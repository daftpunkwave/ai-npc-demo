/**
 * 打开服务端宿主：存储、内容、authority、游戏端口、存档、HTTP/WS 应用与时钟 worker。
 * 依赖组合根、存储模块、实验配置加载器、部署配置校验与 authority；不启动浏览器端。
 * 禁止在这里绕过模块 catalog 直接引用游戏模块实现，也禁止按当前入参重建已冻结的在线 run。
 */
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AssemblyDescriptor,
  AuthContext,
  ClockView,
  Json,
  ModuleCreateInput,
  StorageCell,
  StoragePort,
  StorageTransaction,
} from "@ai-npc/contracts";
import { Authority, TransactionWorldTx } from "@ai-npc/authority";
import { createSystemAuth, systemPrincipalId } from "@ai-npc/authority";
import {
  loadContentPack,
  loadRoster,
  loadRunSpec,
  runSpecSchema,
  validateRoster,
  validateRunSpec,
  type RunSpec,
} from "@ai-npc/experiment";
import type { ClockState } from "@ai-npc/module-sdk";
import { assertDistinctTokens } from "./config";
import { createHostServices } from "./host-services";
import { buildPlayerProjection } from "./projection";
import { advanceWorldTick, catchUpWorldTick } from "./tick";
import { loadAssembly, resolveServerAssembly, type ResolvedServerAssembly } from "./host/assembly";
import { buildRunManifest, readFrozenManifest, type RunManifest } from "./host/manifest";
import { generateRunSeed } from "./host/random";
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
  type ServerIdentity,
} from "./host/module-catalog";

export interface HostOptions {
  readonly dataDir: string;
  readonly contentRoot?: string;
  readonly packId?: string;
  readonly assemblyRef?: string;
  readonly runSpecRef?: string;
  /** 在线世界首次启动时写入 RunSpec 的名册引用；缺省用 standard-20。 */
  readonly rosterRef?: string;
  /** 在线世界首次启动时写入 RunSpec 的模型布局引用；缺省沿用 RunSpec 模板。 */
  readonly modelLayoutRef?: string;
  readonly playerToken: string;
  readonly consoleToken: string;
  /** 可选的单角色控制台令牌；只发放对应角色。 */
  readonly operatorToken?: string;
  readonly researcherToken?: string;
  readonly evaluatorToken?: string;
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
  "road",
  "passage-grant",
  "stockpile",
  "task",
  "task-invitation",
  "conversation",
  "knowledge-grant",
  "share",
  "message",
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

/** 按启动令牌构造传输层身份；主体和角色只来自宿主配置。 */
function createIdentity(
  token: string,
  principalId: string,
  kind: AuthContext["kind"],
  roles: readonly string[],
  worldId: string,
  branchId: string,
): ServerIdentity {
  return {
    token,
    auth: {
      principalId,
      kind,
      roles: [...roles],
      worldId,
      branchId,
      actingAsAgentId: null,
      controllerEpoch: null,
      turnLeaseEpoch: null,
      turnId: null,
    },
  };
}

function createOperations(driver: import("./host/module-catalog").OperationsDriver): ReturnType<typeof createOperationsService> {
  return createOperationsService(driver);
}

const defaultPackId = "earth-2964-v1";
const defaultRunSpecRef = "online-default";
const defaultAssemblyRef = "local-slg-standard-v1";
const defaultRosterRef = "standard-20";

/** 在线分支与其已冻结的 run；首次启动时两者都不存在。 */
interface OnlineBranchState {
  readonly branch: Readonly<Record<string, StorageCell>>;
  readonly run: Readonly<Record<string, StorageCell>> | null;
}

/** 本次启动实际使用的世界、装配、RunSpec 与冻结 manifest。 */
interface ActiveRunState {
  readonly worldId: string;
  readonly branchId: string;
  readonly assembly: AssemblyDescriptor;
  readonly resolved: ResolvedServerAssembly;
  readonly runSpec: RunSpec;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

/** 读取装配时钟配置的秒数；缺失或非法时沿用默认值。 */
function secondsPerTickOf(assembly: AssemblyDescriptor): number {
  const config = assembly.configs["clock"];
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return 10;
  }
  const value = config["secondsPerTick"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 10;
}

/** 内容版本不兼容时给出冻结值与当前值，便于定位是哪一次内容发布。 */
function contentVersionMismatch(frozen: string, current: string, scope: string): Error {
  return new Error(`内容包 contentVersion 不一致：${scope} 冻结「${frozen}」，当前内容包「${current}」；拒绝启动`);
}

/** 打开并启动服务端宿主；调用方负责监听端口与优雅关闭。 */
export async function startHost(options: HostOptions): Promise<RunningHost> {
  assertDistinctTokens([
    { label: "玩家令牌", token: options.playerToken },
    { label: "控制台令牌", token: options.consoleToken },
    { label: "operator 单角色令牌", token: options.operatorToken },
    { label: "researcher 单角色令牌", token: options.researcherToken },
    { label: "evaluator 单角色令牌", token: options.evaluatorToken },
  ]);
  const dataDir = resolve(options.dataDir);
  if (dataDir.length <= 3 || /^[A-Za-z]:\\?$/.test(dataDir)) {
    throw new Error("DATA_DIR 必须是具体目录，不能是磁盘根目录");
  }
  const host = createHostServices();
  const signal = new AbortController().signal;
  const packId = options.packId ?? defaultPackId;
  const configDir = join(process.cwd(), "config");
  const loadContext = { configDir, env: process.env };
  const content = loadContentPack(options.contentRoot ?? join(process.cwd(), "content"), packId);
  const gameContent = toGameContent(content);
  const contentVersion = content.pack.contentVersion;
  const requestedAssembly = loadAssembly(options.assemblyRef ?? defaultAssemblyRef);
  assertSupportedServerBindings(requestedAssembly);
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

  /** 首次启动：用当前启动选择生成新 RunSpec、随机 seed 与冻结 manifest，并创建在线世界。 */
  const createFirstRun = async (): Promise<ActiveRunState> => {
    const roster = loadRoster(options.rosterRef ?? defaultRosterRef, loadContext);
    validateRoster(roster.value, content);
    const resolved = await resolveServerAssembly(requestedAssembly, serverModuleDefinitions);
    const loaded = loadRunSpec(options.runSpecRef ?? defaultRunSpecRef, loadContext, {
      seed: generateRunSeed(),
      moduleAssemblyRef: requestedAssembly.assemblyId,
      worldPackRef: packId,
      rosterRef: roster.value.rosterId,
      ...(options.modelLayoutRef === undefined ? {} : { modelLayoutRef: options.modelLayoutRef }),
    });
    validateRunSpec(loaded.value, content, roster);
    const sealed = await buildRunManifest({
      runSpec: loaded.value,
      content: { packId, contentVersion },
      roster: roster.value,
      resolved,
    });
    const worldId = host.ids("wld");
    const branchId = host.ids("br");
    const runId = host.ids("run");
    const createdAt = host.nowIso();
    storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: worldId,
        pack_id: packId,
        content_version: contentVersion,
        created_at: createdAt,
      });
      tx.rows("branches").put({
        branch_id: branchId,
        world_id: worldId,
        kind: "online",
        status: "active",
        parent_branch_id: null,
        forked_at_world_seq: null,
        run_id: runId,
        profile_hash: null,
        created_at: createdAt,
      });
      tx.rows("runs").put({
        run_id: runId,
        world_id: worldId,
        branch_id: branchId,
        mode: "live",
        status: "running",
        run_spec_json: loaded.value,
        manifest_json: sealed.manifest as unknown as Json,
        manifest_hash: sealed.manifestHash,
        contaminated: 0,
        evidence_complete: 1,
        created_at: createdAt,
        started_at: createdAt,
        ended_at: null,
      });
      tx.branch(branchId).table("clock").put({
        world_tick: 0,
        mode: "paused",
        seconds_per_tick: secondsPerTickOf(requestedAssembly),
        run_version: 0,
        step_target_tick: null,
        updated_at: createdAt,
      });
      tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: createdAt });
    });
    return {
      worldId,
      branchId,
      assembly: requestedAssembly,
      resolved,
      runSpec: loaded.value,
      manifest: sealed.manifest,
      manifestHash: sealed.manifestHash,
    };
  };

  /** 重启：沿用在线别名指向的分支与已冻结 run，不复用当前入参重建 RunSpec。 */
  const resumeRun = async (onlineState: OnlineBranchState): Promise<ActiveRunState> => {
    const run = onlineState.run;
    if (run === null) {
      throw new Error(`在线分支 ${String(onlineState.branch["branch_id"])} 没有已冻结的 run；拒绝按当前入参重建`);
    }
    const parsed = runSpecSchema.safeParse(run["run_spec_json"]);
    if (!parsed.success) {
      throw new Error(`在线 run 的 RunSpec 无法解析：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    }
    const frozenSpec = parsed.data;
    const manifestValue = run["manifest_json"];
    if (manifestValue === null || manifestValue === undefined || manifestValue instanceof Uint8Array) {
      throw new Error("在线 run 缺少冻结 manifest（旧版本数据），拒绝按当前入参重建");
    }
    const facts = readFrozenManifest(manifestValue);
    if (facts.seed !== frozenSpec.seed) {
      throw new Error("冻结 manifest 的 seed 与 RunSpec 不一致");
    }
    if (facts.moduleAssemblyRef !== frozenSpec.moduleAssemblyRef) {
      throw new Error("冻结 manifest 的装配引用与 RunSpec 不一致");
    }
    if (facts.rosterRef !== frozenSpec.rosterRef) {
      throw new Error("冻结 manifest 的名册引用与 RunSpec 不一致");
    }
    if (facts.packId !== packId) {
      throw new Error(`内容包不一致：在线 run 冻结「${facts.packId}」，当前内容包「${packId}」；拒绝启动`);
    }
    if (facts.contentVersion !== contentVersion) {
      throw contentVersionMismatch(facts.contentVersion, contentVersion, "在线 run");
    }
    const worldRow = storage.transact((tx) =>
      tx.rows("worlds").get({ world_id: String(onlineState.branch["world_id"]) }),
    );
    if (worldRow === null) {
      throw new Error(`在线分支引用的 world ${String(onlineState.branch["world_id"])} 不存在`);
    }
    if (worldRow["pack_id"] !== packId) {
      throw new Error(`内容包不一致：在线世界「${String(worldRow["pack_id"])}」，当前内容包「${packId}」；拒绝启动`);
    }
    const worldVersion = typeof worldRow["content_version"] === "string" ? worldRow["content_version"] : "";
    if (worldVersion !== contentVersion) {
      throw contentVersionMismatch(worldVersion, contentVersion, "在线世界");
    }
    const assembly = loadAssembly(frozenSpec.moduleAssemblyRef);
    assertSupportedServerBindings(assembly);
    const roster = loadRoster(frozenSpec.rosterRef, loadContext);
    validateRoster(roster.value, content);
    validateRunSpec(frozenSpec, content, roster);
    const resolved = await resolveServerAssembly(assembly, serverModuleDefinitions);
    const rebuilt = await buildRunManifest({
      runSpec: frozenSpec,
      content: { packId, contentVersion },
      roster: roster.value,
      resolved,
    });
    const storedHash = typeof run["manifest_hash"] === "string" ? run["manifest_hash"] : "";
    if (storedHash.length === 0) {
      throw new Error("在线 run 缺少 manifest_hash，拒绝按当前入参重建");
    }
    if (rebuilt.manifestHash !== storedHash) {
      throw new Error("冻结 manifest 无法复算：装配、名册或内容版本与 run 记录不一致");
    }
    return {
      worldId: String(onlineState.branch["world_id"]),
      branchId: String(onlineState.branch["branch_id"]),
      assembly,
      resolved,
      runSpec: frozenSpec,
      manifest: rebuilt.manifest,
      manifestHash: storedHash,
    };
  };

  const online = storage.transact((tx): OnlineBranchState | null => {
    const alias = tx.rows("world_aliases").get({ alias: "online" });
    if (alias === null) {
      return null;
    }
    const branchId = typeof alias["branch_id"] === "string" ? alias["branch_id"] : "";
    if (branchId.length === 0) {
      throw new Error("world_aliases('online') 缺少 branch_id");
    }
    const branch = tx.rows("branches").get({ branch_id: branchId });
    if (branch === null) {
      throw new Error(`在线别名指向的分支 ${branchId} 不存在`);
    }
    if (branch["kind"] !== "online") {
      throw new Error(`在线别名指向的分支 ${branchId} 不是 online 分支`);
    }
    const runId = typeof branch["run_id"] === "string" ? branch["run_id"] : "";
    return {
      branch,
      run: runId.length === 0 ? null : tx.rows("runs").get({ run_id: runId }),
    };
  });

  let active: ActiveRunState;
  try {
    active = online === null ? await createFirstRun() : await resumeRun(online);
  } catch (error) {
    await storageInstance.dispose();
    throw error;
  }
  const activeWorldId = active.worldId;
  let activeBranchId = active.branchId;
  const activeAssembly = active.assembly;
  const activeResolved = active.resolved;
  const runSpec = active.runSpec;
  const frozenManifest = active.manifest;
  const frozenManifestHash = active.manifestHash;

  storage.transact((tx) => {
    const clock = tx.branch(activeBranchId).table("clock");
    const row = clock.get({});
    if (row !== null && row["mode"] !== "paused") {
      clock.put({ ...row, mode: "paused", run_version: Number(row["run_version"]) + 1, updated_at: host.nowIso() });
    }
  });

  const binder = createModuleBinderFromAssembly(activeAssembly, gameContent, host);
  const authority = new Authority({
    storage,
    host,
    content: gameContent,
    moduleBinder: binder,
    allowDirectAgentCommands: true,
    runSeed: runSpec.seed,
  });
  for (const contributor of createGameContributorsFromAssembly(activeAssembly)) {
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
    const ports = createGamePortsFromAssembly(activeAssembly, gameTx, gameContent, host);
    return buildPlayerProjection({
      content: gameContent,
      world: ports["game.world"],
      map: ports["game.map"],
      clock: clockView(readClockTx(tx, activeBranchId)),
      comms: ports["game.comms"],
      resources: ports["game.resources"],
      actions: ports["game.actions"],
      agreements: ports["game.agreements"],
    });
  });

  const save = createSaveService(storage, host);
  const createDrainedSnapshot = (
    input: { readonly label: string; readonly createdBy: string },
  ): ReturnType<typeof save.createSnapshot> => {
    catchUpWorldTick({ storage, authority, host, branchId: activeBranchId });
    return save.createSnapshot({ sourceBranchId: activeBranchId, label: input.label, createdBy: input.createdBy });
  };
  const resetOnline = (): { readonly branchId: string; readonly clock: ClockView } => {
    const current = clockState();
    if (current.mode === "running") {
      control("pause", current.runVersion);
    }
    const label = `reset-${current.worldTick}`;
    createDrainedSnapshot({ label, createdBy: "operator-1" });
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
        manifest_json: frozenManifest as unknown as Json,
        manifest_hash: frozenManifestHash,
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
        seconds_per_tick: secondsPerTickOf(activeAssembly),
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

  /** 从快照恢复：后继 run 沿用源 run 的 RunSpec、seed 与冻结 manifest。 */
  const restoreOnlineRun = (
    input: { readonly snapshotId: string; readonly createdBy: string; readonly runId?: string },
  ): { readonly branchId: string; readonly runId: string } => {
    const snapshot = storage.transact((tx) => tx.rows("snapshots").get({ snapshot_id: input.snapshotId }));
    if (snapshot === null) {
      throw new Error(`快照 ${input.snapshotId} 不存在`);
    }
    const sourceBranchId = typeof snapshot["source_branch_id"] === "string" ? snapshot["source_branch_id"] : "";
    const sourceBranch =
      sourceBranchId.length === 0
        ? null
        : storage.transact((tx) => tx.rows("branches").get({ branch_id: sourceBranchId }));
    if (sourceBranch === null) {
      throw new Error(`快照源分支 ${sourceBranchId} 不存在`);
    }
    const sourceRunId = typeof sourceBranch["run_id"] === "string" ? sourceBranch["run_id"] : "";
    const sourceRun =
      sourceRunId.length === 0
        ? null
        : storage.transact((tx) => tx.rows("runs").get({ run_id: sourceRunId }));
    if (sourceRun === null) {
      throw new Error("快照源分支没有已冻结的 run，拒绝恢复");
    }
    const sourceRunSpec = sourceRun["run_spec_json"];
    const sourceManifest = sourceRun["manifest_json"];
    const sourceManifestHash = sourceRun["manifest_hash"];
    if (
      sourceRunSpec === undefined ||
      sourceRunSpec === null ||
      sourceManifest === undefined ||
      sourceManifest === null ||
      sourceManifest instanceof Uint8Array ||
      typeof sourceManifestHash !== "string" ||
      sourceManifestHash.length === 0
    ) {
      throw new Error("快照源 run 缺少冻结 RunSpec 或 manifest，拒绝恢复");
    }
    const facts = readFrozenManifest(sourceManifest);
    if (facts.packId !== packId) {
      throw new Error(`内容包不一致：快照源 run 冻结「${facts.packId}」，当前内容包「${packId}」；拒绝恢复`);
    }
    if (facts.contentVersion !== contentVersion) {
      throw contentVersionMismatch(facts.contentVersion, contentVersion, "快照源 run");
    }
    const runId = input.runId ?? host.ids("run");
    const restored = save.restoreSnapshot({ snapshotId: input.snapshotId, createdBy: input.createdBy, runId });
    const createdAt = host.nowIso();
    storage.transact((tx) => {
      const branch = tx.rows("branches").get({ branch_id: restored.branchId });
      if (branch === null) {
        throw new Error(`恢复后的分支 ${restored.branchId} 不存在`);
      }
      tx.rows("runs").put({
        run_id: restored.runId,
        world_id: String(branch["world_id"]),
        branch_id: restored.branchId,
        mode: "live",
        status: "running",
        run_spec_json: sourceRunSpec,
        manifest_json: sourceManifest,
        manifest_hash: sourceManifestHash,
        contaminated: sourceRun["contaminated"] ?? 0,
        evidence_complete: sourceRun["evidence_complete"] ?? 1,
        created_at: createdAt,
        started_at: createdAt,
        ended_at: null,
      });
    });
    return restored;
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
    snapshot: (input) => createDrainedSnapshot({ label: input.label, createdBy: input.createdBy }),
    restore: (input) => {
      const restored = restoreOnlineRun(input);
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
    assembly: activeResolved.modules,
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
      createIdentity(options.playerToken, "player-1", "player", ["player"], activeWorldId, activeBranchId),
      createIdentity(options.consoleToken, "console-admin", "operator", ["operator", "researcher", "evaluator"], activeWorldId, activeBranchId),
      ...(options.operatorToken === undefined
        ? []
        : [createIdentity(options.operatorToken, "console-operator", "operator", ["operator"], activeWorldId, activeBranchId)]),
      ...(options.researcherToken === undefined
        ? []
        : [createIdentity(options.researcherToken, "console-researcher", "researcher", ["researcher"], activeWorldId, activeBranchId)]),
      ...(options.evaluatorToken === undefined
        ? []
        : [createIdentity(options.evaluatorToken, "console-evaluator", "evaluator", ["evaluator"], activeWorldId, activeBranchId)]),
    ],
    ids: (prefix) => host.ids(prefix),
    tokens: (kind) => `${kind}-${randomUUID()}`,
    healthStatus: () => (workerFailed ? "degraded" : "ready"),
  });

  let workerFailed = false;
  let workerBusy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    catchUpWorldTick({ storage, authority, host, branchId: activeBranchId });
  } catch (error) {
    workerFailed = true;
    host.logger.error("host 启动补完当前 tick 失败，已停止推进", {
      message: error instanceof Error ? error.message : String(error),
      branchId: activeBranchId,
    });
  }
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
        advanceWorldTick({ storage, authority, host, branchId: activeBranchId, targetTick: clock.worldTick + 1 });
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
