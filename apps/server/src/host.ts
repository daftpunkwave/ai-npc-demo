/**
 * 打开服务端宿主：存储、内容、authority、游戏端口、存档、HTTP/WS 应用与时钟 worker。
 * 依赖组合根、存储模块、实验内容加载与 authority；不启动浏览器端。
 * 禁止在这里绕过模块 catalog 直接引用游戏模块实现。
 */
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClockView, ModuleCreateInput, StoragePort, StorageTransaction } from "@ai-npc/contracts";
import { Authority, TransactionWorldTx } from "@ai-npc/authority";
import { createSystemAuth, systemPrincipalId } from "@ai-npc/authority";
import { loadContentPack } from "@ai-npc/experiment";
import type { ClockState } from "@ai-npc/module-sdk";
import { createHostServices } from "./host-services";
import { buildPlayerProjection } from "./projection";
import { loadAssembly, loadRunSpec, resolveServerModules } from "./host/assembly";
import {
  createGameContributorsFromAssembly,
  createGamePortsFromAssembly,
  createModuleBinderFromAssembly,
  assertSupportedServerBindings,
  createOperationsService,
  createSaveService,
  parseTransportConfig,
  serverModuleDefinitions,
  toGameContent,
  transportModuleDefinition,
  operationsModuleDefinition,
  type TransportPort,
  type ServerApp,
} from "./host/module-catalog";

export interface HostOptions {
  readonly dataDir: string;
  readonly contentRoot?: string;
  readonly packId?: string;
  readonly assemblyRef?: string;
  readonly runSpecRef?: string;
  readonly playerToken: string;
  readonly consoleToken: string;
  readonly transportHost?: string;
  readonly transportPort?: number;
  readonly allowedOrigins?: readonly string[];
}

export interface RunningHost {
  readonly app: ServerApp;
  readonly storage: StoragePort;
  readonly branchId: string;
  readonly worldId: string;
  readonly transport: import("./host/module-catalog").TransportPort;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const allAggregates = new Set([
  "campaign",
  "meters",
  "character",
  "team",
  "group",
  "delegation",
  "evidence-placement",
  "chapter-stats",
  "road",
  "passage-grant",
  "stockpile",
  "task",
  "task-invitation",
  "conversation",
  "knowledge-grant",
  "agreement",
  "scenario-card",
  "scenario-run",
]);

function clockView(clock: ClockState): ClockView {
  return {
    worldTick: clock.worldTick,
    day: Math.floor(clock.worldTick / 24) + 1,
    hour: clock.worldTick % 24,
    mode: clock.mode,
    runVersion: clock.runVersion,
  };
}

function createOperations(driver: import("./host/module-catalog").OperationsDriver): ReturnType<typeof createOperationsService> {
  return createOperationsService(driver);
}

/** 打开并启动服务端宿主；调用方负责监听端口与优雅关闭。 */
export async function startHost(options: HostOptions): Promise<RunningHost> {
  const dataDir = resolve(options.dataDir);
  if (dataDir.length <= 3 || /^[A-Za-z]:\\?$/.test(dataDir)) {
    throw new Error("DATA_DIR 必须是具体目录，不能是磁盘根目录");
  }
  const host = createHostServices();
  const signal = new AbortController().signal;
  const storageInput: ModuleCreateInput = {
    moduleId: "platform.storage.sqlite",
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal,
  };
  const storageModule = serverModuleDefinitions[0];
  const storageInstance = await storageModule.create(storageInput);
  await storageInstance.start(signal);
  const storage = storageInstance.port as StoragePort;
  if (storage === undefined) {
    throw new Error("存储模块没有暴露 StoragePort");
  }

  const content = loadContentPack(options.contentRoot ?? join(process.cwd(), "content"), options.packId ?? "earth-2964-v1");
  const gameContent = toGameContent(content);
  const assembly = loadAssembly(options.assemblyRef ?? "local-slg-standard-v1");
  assertSupportedServerBindings(assembly);
  const runSpec = loadRunSpec(options.runSpecRef ?? "online-default");
  const resolvedModules = resolveServerModules(assembly, serverModuleDefinitions);
  const clockConfig = assembly.configs["clock"] as { readonly secondsPerTick?: number } | undefined;
  const secondsPerTick = typeof clockConfig?.secondsPerTick === "number" ? clockConfig.secondsPerTick : 10;
  const contentVersion = content.pack.schemaVersion.toString();
  const timestamp = host.nowIso();
  const worldId = host.ids("wld");
  const branchId = host.ids("br");
  storage.transact((tx) => {
    const existing = tx.rows("branches").list({ kind: "online" })[0];
    if (existing !== undefined) {
      const world = tx.rows("worlds").get({ world_id: String(existing["world_id"]) });
      if (world === null || world["pack_id"] !== (options.packId ?? "earth-2964-v1") || world["content_version"] !== contentVersion) {
        throw new Error("现有世界的内容包或版本与当前配置不匹配");
      }
      return;
    }
    tx.rows("worlds").put({
      world_id: worldId,
      pack_id: options.packId ?? "earth-2964-v1",
      content_version: contentVersion,
      created_at: timestamp,
    });
    tx.rows("branches").put({
      branch_id: branchId,
      world_id: worldId,
      kind: "online",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: null,
      run_id: null,
      profile_hash: null,
      created_at: timestamp,
    });
    tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: timestamp });
    tx.branch(branchId).table("clock").put({
      world_tick: 0,
      mode: "paused",
      seconds_per_tick: secondsPerTick,
      run_version: 0,
      step_target_tick: null,
      updated_at: timestamp,
    });
  });
  const branchRow = storage.transact((tx) => tx.rows("branches").list({ kind: "online" })[0]);
  if (branchRow === null || branchRow === undefined) {
    throw new Error("无法创建在线分支");
  }
  let activeWorldId = String(branchRow["world_id"]);
  let activeBranchId = String(branchRow["branch_id"]);
  storage.transact((tx) => {
    const clock = tx.branch(activeBranchId).table("clock");
    const row = clock.get({});
    if (row !== null && row["mode"] !== "paused") {
      clock.put({ ...row, mode: "paused", run_version: Number(row["run_version"]) + 1, updated_at: timestamp });
    }
    if (tx.rows("world_aliases").get({ alias: "online" }) === null) {
      tx.rows("world_aliases").put({ alias: "online", branch_id: activeBranchId, updated_at: timestamp });
    }
  });

  const ensureLiveRun = (branch: string, world: string): string => storage.transact((tx) => {
    const row = tx.rows("branches").get({ branch_id: branch });
    if (row === null) {
      throw new Error(`分支 ${branch} 不存在`);
    }
    if (typeof row["run_id"] === "string" && row["run_id"].length > 0) {
      return row["run_id"];
    }
    const runId = host.ids("run");
    const createdAt = host.nowIso();
    tx.rows("runs").put({
      run_id: runId,
      world_id: world,
      branch_id: branch,
      mode: "live",
      status: "running",
      run_spec_json: runSpec,
      manifest_json: null,
      manifest_hash: null,
      contaminated: 0,
      evidence_complete: 1,
      created_at: createdAt,
      started_at: createdAt,
      ended_at: null,
    });
    tx.rows("branches").put({ ...row, run_id: runId });
    return runId;
  });
  ensureLiveRun(activeBranchId, activeWorldId);

  const binder = createModuleBinderFromAssembly(assembly, gameContent, host);
  const authority = new Authority({
    storage,
    host,
    content: gameContent,
    moduleBinder: binder,
    allowDirectAgentCommands: true,
  });
  for (const contributor of createGameContributorsFromAssembly(assembly)) {
    authority.registerModule(contributor);
  }

  const readClockTx = (tx: StorageTransaction, branch: string): ClockState => {
    const row = tx.branch(branch).table("clock").get({});
    if (row === null) {
      throw new Error("分支缺少 clock");
    }
    return {
      worldTick: Number(row["world_tick"]),
      mode: String(row["mode"]) as ClockState["mode"],
      secondsPerTick: Number(row["seconds_per_tick"]),
      runVersion: Number(row["run_version"]),
      stepTargetTick: row["step_target_tick"] === null ? null : Number(row["step_target_tick"]),
    };
  };

  const clockState = (): ClockState => storage.transact((tx) => readClockTx(tx, activeBranchId));

  const txFor = (storageTx: StorageTransaction, moduleId: string) =>
    (id: string): TransactionWorldTx => new TransactionWorldTx({
      storageTx,
      worldId: activeWorldId,
      branchId: activeBranchId,
      worldTick: readClockTx(storageTx, activeBranchId).worldTick,
      principalId: systemPrincipalId,
      correlationId: `host:${moduleId}:${id}`,
      scope: { moduleId: id, ownsAggregates: allAggregates, order: 0 },
      host,
    });

  const control = (mode: "pause" | "start", expectedRunVersion: number): ClockView => {
    return storage.transact((tx) => {
      const current = readClockTx(tx, activeBranchId);
      if (current.runVersion !== expectedRunVersion) {
        throw new Error("时钟版本冲突");
      }
      const table = tx.branch(activeBranchId).table("clock");
      const row = table.get({});
      if (row === null) {
        throw new Error("分支缺少 clock");
      }
      table.put({ ...row, mode: mode === "pause" ? "paused" : "running", run_version: expectedRunVersion + 1, updated_at: host.nowIso() });
      return clockView(readClockTx(tx, activeBranchId));
    });
  };
  const projection = () => storage.transact((tx) => {
    const gameTx = txFor(tx, "read");
    const ports = createGamePortsFromAssembly(assembly, gameTx, gameContent, host);
    return buildPlayerProjection({ content: gameContent, world: ports["game.world"], map: ports["game.map"], clock: clockView(readClockTx(tx, activeBranchId)) });
  });

  const save = createSaveService(storage, host);
  const resetOnline = (): { readonly branchId: string; readonly clock: ClockView } => {
    const current = clockState();
    if (current.mode === "running") {
      control("pause", current.runVersion);
    }
    const label = `reset-${current.worldTick}`;
    save.createSnapshot({ sourceBranchId: activeBranchId, label, createdBy: "operator-1" });
    const nextBranchId = host.ids("br");
    storage.transact((tx) => {
      const now = host.nowIso();
      const nextRunId = host.ids("run");
      const previous = tx.rows("branches").get({ branch_id: activeBranchId });
      const previousRunId = previous === null ? null : previous["run_id"];
      if (typeof previousRunId === "string") {
        const previousRun = tx.rows("runs").get({ run_id: previousRunId });
        if (previousRun !== null) {
          tx.rows("runs").put({ ...previousRun, status: "completed", ended_at: now });
        }
      }
      tx.rows("branches").put({
        branch_id: nextBranchId,
        world_id: activeWorldId,
        kind: "online",
        status: "active",
        parent_branch_id: activeBranchId,
        forked_at_world_seq: null,
        run_id: null,
        profile_hash: null,
        created_at: now,
      });
      tx.rows("runs").put({
        run_id: nextRunId,
        world_id: activeWorldId,
        branch_id: nextBranchId,
        mode: "live",
        status: "running",
        run_spec_json: runSpec,
        manifest_json: null,
        manifest_hash: null,
        contaminated: 0,
        evidence_complete: 1,
        created_at: now,
        started_at: now,
        ended_at: null,
      });
      tx.rows("branches").put({
        branch_id: nextBranchId,
        world_id: activeWorldId,
        kind: "online",
        status: "active",
        parent_branch_id: activeBranchId,
        forked_at_world_seq: null,
        run_id: nextRunId,
        profile_hash: null,
        created_at: now,
      });
      tx.branch(nextBranchId).table("clock").put({
        world_tick: 0,
        mode: "paused",
        seconds_per_tick: secondsPerTick,
        run_version: 0,
        step_target_tick: null,
        updated_at: now,
      });
      if (previous !== null) {
        tx.rows("branches").put({ ...previous, status: "archived" });
      }
      tx.rows("world_aliases").put({ alias: "online", branch_id: nextBranchId, updated_at: now });
    });
    activeBranchId = nextBranchId;
    return { branchId: nextBranchId, clock: clockView(clockState()) };
  };

  const transportConfig = parseTransportConfig({
    host: options.transportHost ?? "127.0.0.1",
    port: options.transportPort ?? 3000,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://127.0.0.1:3000"],
  });
  const transportInstance = await transportModuleDefinition.create({
    moduleId: "transport.http-ws.fastify",
    realm: "server",
    config: transportConfig,
    scope: {},
    ports: {},
    host,
    signal,
  });
  const transport = transportInstance.port as TransportPort;
  await transportInstance.start(signal);

  const operationsInstance = await operationsModuleDefinition.create({
    moduleId: "platform.operations.standard",
    realm: "server",
    config: {},
    scope: {},
    ports: {},
    host,
    signal,
  });
  await operationsInstance.start(signal);
  const operationsFactory = operationsInstance.port as {
    create: typeof createOperations;
  };
  const operations = operationsFactory.create({
    clock: () => clockState(),
    pause: (expected) => control("pause", expected),
    resume: (expected) => control("start", expected),
    snapshot: (input) => save.createSnapshot({ sourceBranchId: activeBranchId, label: input.label, createdBy: input.createdBy }),
    restore: (input) => {
      const restored = save.restoreSnapshot({ snapshotId: input.snapshotId, createdBy: input.createdBy, ...(input.runId === undefined ? {} : { runId: input.runId }) });
      activeBranchId = restored.branchId;
      return restored;
    },
    reset: resetOnline,
  });

  const app = await transport.createApp({
    authority,
    storage,
    worldId: activeWorldId,
    branchId: activeBranchId,
    assembly: resolvedModules,
    projection,
    clock: () => clockView(clockState()),
    pause: (operationId, expected) => {
      void operationId;
      return operations.pause(expected);
    },
    resume: (operationId, expected) => {
      void operationId;
      return operations.resume(expected);
    },
    save: {
      createSnapshot: (input) => operations.snapshot(input.label, input.createdBy),
      listSnapshots: () => save.listSnapshots(),
      restoreSnapshot: (input) => operations.restore(input.snapshotId, input.createdBy, input.runId),
    },
    reset: () => operations.reset(),
    onBranchChanged: (nextBranchId) => {
      activeBranchId = nextBranchId;
    },
    identities: [
      { token: options.playerToken, auth: { principalId: "player-1", kind: "player", roles: ["player"], worldId: activeWorldId, branchId: activeBranchId, actingAsAgentId: null, controllerEpoch: null, turnLeaseEpoch: null, turnId: null } },
      { token: options.consoleToken, auth: { principalId: "operator-1", kind: "operator", roles: ["operator"], worldId: activeWorldId, branchId: activeBranchId, actingAsAgentId: null, controllerEpoch: null, turnLeaseEpoch: null, turnId: null } },
    ],
    ids: (prefix) => host.ids(prefix),
    tokens: (kind) => `${kind}-${randomUUID()}`,
    healthStatus: () => (workerFailed ? "degraded" : "ready"),
  });

  let workerFailed = false;
  let workerBusy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (workerFailed) {
      return;
    }
    const delay = Math.max(1000, clockState().secondsPerTick * 1000);
    timer = setTimeout(runWorker, delay);
    timer.unref();
  };
  const runWorker = (): void => {
    if (workerBusy) {
      return;
    }
    workerBusy = true;
    try {
      const clock = clockState();
      if (clock.mode === "running") {
        storage.transact((tx) => {
          const table = tx.branch(activeBranchId).table("clock");
          const row = table.get({});
          if (row !== null) {
            table.put({ ...row, world_tick: clock.worldTick + 1, updated_at: host.nowIso() });
          }
        });
        authority.clock.run(activeBranchId);
        authority.jobs.runDue(activeBranchId, clock.worldTick + 1);
        authority.consumers.run(activeBranchId);
        app.notifyWorldChanged();
      }
    } catch (error) {
      workerFailed = true;
      host.logger.error("host worker 失败，已停止推进", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      workerBusy = false;
      if (!workerFailed) {
        schedule();
      }
    }
  };
  schedule();

  return {
    app,
    storage,
    branchId: activeBranchId,
    worldId: activeWorldId,
    transport,
    listen: () => transport.listen(app),
    close: async () => {
      workerFailed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      await app.close();
      await transportInstance.dispose();
      await operationsInstance.dispose();
      await storageInstance.dispose();
    },
  };
}

/** 暴露系统认证构造供宿主测试与调试使用。 */
export const hostSystemAuth = createSystemAuth;
