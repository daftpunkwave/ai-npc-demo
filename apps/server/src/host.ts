/**
 * 打开服务端宿主：装配预检、存储启动、在线 run 解析、按计划启动剩余模块、authority、应用与时钟 worker。
 * 依赖 kernel 解析/生命周期、组合根公开端口、实验配置加载器、部署配置校验与 authority；不启动浏览器端。
 * 禁止绕过解析计划直接引用模块实现，也禁止按当前入参重建已冻结的在线 run 或重复实现时钟状态。
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assemblyDescriptorSchema,
  canonicalJson,
  type AssemblyDescriptor,
  type AuthContext,
  type ClockView,
  type Json,
  type ModuleDefinition,
  type StartOption,
  type StorageCell,
  type StoragePort,
  type StorageTransaction,
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
import { startInstances, type ResolvedRealmPlan, type StartedInstances } from "@ai-npc/kernel";
import type { ClockState, GameClockPort, GameContent, GameModulePorts } from "@ai-npc/module-sdk";
import { assertDistinctTokens } from "./config";
import { createHostServices } from "./host-services";
import { buildPlayerProjection } from "./projection";
import { advanceWorldTick, catchUpWorldTick } from "./tick";
import { filterPlan, loadAssembly, resolveServerAssembly, resolveSessionAssemblies, type ResolvedServerAssembly } from "./host/assembly";
import { buildRunManifest, readFrozenManifest, type RunManifest } from "./host/manifest";
import { generateRunSeed } from "./host/random";
import {
  createServerRuntime,
  parseTransportConfig,
  plannedModuleForCapability,
  serverModuleDefinitions,
  toGameContent,
  type OperationsDriver,
  type ServerApp,
  type ServerIdentity,
  type ServerRuntime,
  type TransportPort,
  type ConversationReadPort,
} from "./host/module-catalog";

export interface HostOptions {
  readonly dataDir: string;
  readonly contentRoot?: string;
  readonly packId?: string;
  readonly assemblyRef?: string;
  /** 已解析装配对象；仅供嵌入式宿主与测试注入，设置后再指定 assemblyRef 会失败。 */
  readonly assembly?: AssemblyDescriptor;
  /**
   * 完整模块目录；缺省使用组合根登记的全部 server 模块定义。
   * 仅供嵌入式宿主与测试注入，仍走同一解析、校验与启动路径。
   */
  readonly moduleDefinitions?: readonly ModuleDefinition[];
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
  readonly transport: TransportPort;
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

/**
 * 开局选项：派系名、首个委托与接触角色都取自内容包索引，保持内容声明顺序。
 */
function startOptions(content: GameContent): StartOption[] {
  return [...content.starts.values()].map((start) => ({
    factionId: start.factionId,
    name: content.factions.get(start.factionId)?.name ?? start.factionId,
    commission: start.commission,
    contacts: start.contacts.map((agentId) => ({
      agentId,
      name: content.characters.get(agentId)?.name ?? agentId,
    })),
  }));
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

/** 恢复或重开后的活动 run 与启动计划。 */
interface ResumedRunState {
  readonly active: ActiveRunState;
  readonly startup: ResolvedServerAssembly;
}

/** 首次启动的待提交状态；时钟 provider 启动后再在同一事务内写入在线世界与初始时钟行。 */
interface PendingFirstRun {
  readonly active: ActiveRunState;
  commit(clock: GameClockPort): void;
}

/** 内容版本不兼容时给出冻结值与当前值，便于定位是哪一次内容发布。 */
function contentVersionMismatch(frozen: string, current: string, scope: string): Error {
  return new Error(`内容包 contentVersion 不一致：${scope} 冻结「${frozen}」，当前内容包「${current}」；拒绝启动`);
}

/** 已启动的存储实例必须与在线装配声明的存储配置一致，避免用错误设置继续运行。 */
function assertStorageCompatible(
  activePlan: ResolvedRealmPlan,
  requestedPlan: ResolvedRealmPlan,
  storageModuleId: string,
): void {
  const activeStorage = activePlan.modules.find((module) => module.moduleId === storageModuleId);
  const requestedStorage = requestedPlan.modules.find((module) => module.moduleId === storageModuleId);
  if (activeStorage === undefined || requestedStorage === undefined) {
    throw new Error(`在线装配缺少当前启动的存储模块 ${storageModuleId}`);
  }
  if (canonicalJson(activeStorage.config) !== canonicalJson(requestedStorage.config)) {
    throw new Error("在线装配的存储配置与本次启动不一致；拒绝使用不匹配的存储实例");
  }
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
  if (options.assembly !== undefined && options.assemblyRef !== undefined) {
    throw new Error("不能同时指定装配对象与装配引用");
  }
  const host = createHostServices();
  const signal = new AbortController().signal;
  const definitions = options.moduleDefinitions ?? serverModuleDefinitions;
  const packId = options.packId ?? defaultPackId;
  const configDir = resolve(process.cwd(), "config");
  const loadContext = { configDir, env: process.env };
  const content = loadContentPack(options.contentRoot ?? resolve(process.cwd(), "content"), packId);
  const gameContent = toGameContent(content);
  const contentVersion = content.pack.contentVersion;
  const requestedAssembly = options.assembly === undefined
    ? loadAssembly(options.assemblyRef ?? defaultAssemblyRef)
    : assemblyDescriptorSchema.parse(options.assembly);
  const transportConfig = parseTransportConfig({
    host: options.transportHost ?? "127.0.0.1",
    port: options.transportPort ?? 3000,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://127.0.0.1:3000"],
  });

  /** 部署期参数由宿主并入模块配置：数据目录与监听设置不写进装配，也不参与冻结摘要。 */
  const deploymentOverrides: Readonly<Record<string, Json>> = {
    "platform.storage.sqlite": { dataDir },
    "transport.http-ws.fastify": transportConfig as unknown as Json,
  };

  // 装配预检必须先于存储启动：缺失依赖、重复绑定、错误 realm 与非法配置都在打开数据库前失败。
  const requestedResolved = await resolveServerAssembly(requestedAssembly, definitions);
  const requestedStartup = await resolveServerAssembly(requestedAssembly, definitions, {
    configOverrides: deploymentOverrides,
  });
  const storageModuleId = plannedModuleForCapability(requestedStartup.plan, "platform.storage").moduleId;
  const storageStarted = await startInstances(filterPlan(requestedStartup.plan, (moduleId) => moduleId === storageModuleId), {
    host,
    scope: {},
    signal,
  });
  const storage = storageStarted.instances[0]?.port as StoragePort | undefined;
  if (storage === undefined) {
    await storageStarted.dispose();
    throw new Error("存储模块没有暴露 StoragePort");
  }

  /** 首次启动：用当前启动选择生成新 RunSpec、随机 seed 与冻结 manifest；提交函数在时钟 provider 启动后写入在线世界。 */
  const prepareFirstRun = async (): Promise<PendingFirstRun> => {
    const roster = loadRoster(options.rosterRef ?? defaultRosterRef, loadContext);
    validateRoster(roster.value, content);
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
      resolved: requestedResolved,
    });
    const worldId = host.ids("wld");
    const branchId = host.ids("br");
    const runId = host.ids("run");
    const createdAt = host.nowIso();
    return {
      active: {
        worldId,
        branchId,
        assembly: requestedAssembly,
        resolved: requestedResolved,
        runSpec: loaded.value,
        manifest: sealed.manifest,
        manifestHash: sealed.manifestHash,
      },
      commit: (clock) => {
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
          // 初始时钟行由 provider 自己的有效配置写入，宿主不解析或构造 clock 行。
          clock.initializeInTransaction(tx, branchId);
          tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: createdAt });
        });
      },
    };
  };

  /** 重启：沿用在线别名指向的分支与已冻结 run，不复用当前入参重建 RunSpec。 */
  const resumeRun = async (onlineState: OnlineBranchState): Promise<ResumedRunState> => {
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
    const roster = loadRoster(frozenSpec.rosterRef, loadContext);
    validateRoster(roster.value, content);
    validateRunSpec(frozenSpec, content, roster);
    const resolved = await resolveServerAssembly(assembly, definitions);
    const startup = await resolveServerAssembly(assembly, definitions, { configOverrides: deploymentOverrides });
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
      active: {
        worldId: String(onlineState.branch["world_id"]),
        branchId: String(onlineState.branch["branch_id"]),
        assembly,
        resolved,
        runSpec: frozenSpec,
        manifest: rebuilt.manifest,
        manifestHash: storedHash,
      },
      startup,
    };
  };

  let activeStarted: StartedInstances | null = null;
  let serverRuntime: ServerRuntime | null = null;
  let sessionAssemblies: Awaited<ReturnType<typeof resolveSessionAssemblies>> | null = null;
  let activeBranchId = "";
  let activeWorldId = "";
  let activeAssembly: AssemblyDescriptor;
  let activeResolved: ResolvedServerAssembly;
  let activeStartup: ResolvedServerAssembly;
  let runSpec: RunSpec;
  let frozenManifest: RunManifest;
  let frozenManifestHash: string;
  try {
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
    let pendingFirstRun: PendingFirstRun | null = null;
    if (online === null) {
      pendingFirstRun = await prepareFirstRun();
      active = pendingFirstRun.active;
      activeStartup = requestedStartup;
    } else {
      const resumed = await resumeRun(online);
      active = resumed.active;
      activeStartup = resumed.startup;
    }
    assertStorageCompatible(activeStartup.plan, requestedStartup.plan, storageModuleId);
    activeWorldId = active.worldId;
    activeBranchId = active.branchId;
    activeAssembly = active.assembly;
    activeResolved = active.resolved;
    runSpec = active.runSpec;
    frozenManifest = active.manifest;
    frozenManifestHash = active.manifestHash;
    // 在线装配确定后再启动其余模块；存储实例作为部署级 provider 复用，不重复创建。
    activeStarted = await startInstances(filterPlan(activeStartup.plan, (moduleId) => moduleId !== storageModuleId), {
      host,
      scope: { worldId: activeWorldId, branchId: activeBranchId },
      signal,
      running: storageStarted.instances,
    });
    serverRuntime = createServerRuntime({
      plan: activeStartup.plan,
      instances: [...storageStarted.instances, ...activeStarted.instances],
      content: gameContent,
      host,
    });
    sessionAssemblies = await resolveSessionAssemblies(activeAssembly, definitions);
    if (pendingFirstRun !== null) {
      // 世界、分支、run、别名与初始时钟行在同一事务提交，时钟配置来自 provider。
      pendingFirstRun.commit(serverRuntime.clock);
    }
    const restoredClock = serverRuntime.clock.read(activeBranchId);
    if (restoredClock.mode !== "paused") {
      const paused = serverRuntime.clock.pause(activeBranchId);
      if (!paused.ok) {
        throw new Error(`启动时暂停时钟失败：${paused.reasonCode}`);
      }
    }
  } catch (error) {
    await activeStarted?.dispose();
    await storageStarted.dispose();
    throw error;
  }
  if (activeStarted === null || serverRuntime === null || sessionAssemblies === null) {
    await storageStarted.dispose();
    throw new Error("宿主运行时未初始化");
  }
  const runtime = serverRuntime;
  const startedModules = activeStarted;
  const sessionAssembly = sessionAssemblies;

  const clockState = () => runtime.clock.read(activeBranchId);

  const txFor = (storageTx: StorageTransaction, moduleId: string) =>
    (id: string): TransactionWorldTx => new TransactionWorldTx({
      storageTx,
      worldId: activeWorldId,
      branchId: activeBranchId,
      worldTick: runtime.clock.readInTransaction(storageTx, activeBranchId).worldTick,
      principalId: systemPrincipalId,
      correlationId: `host:${moduleId}:${id}`,
      scope: { moduleId: id, ownsAggregates: allAggregates, order: 0 },
      host,
    });

  const control = (mode: "pause" | "start", expectedRunVersion: number): ClockView => {
    const result = mode === "pause"
      ? runtime.clock.pause(activeBranchId, expectedRunVersion)
      : runtime.clock.start(activeBranchId, expectedRunVersion);
    if (!result.ok) {
      throw new Error(result.reasonCode === "version-conflict" ? "时钟版本冲突" : "时钟控制参数非法");
    }
    return clockView(result.clock);
  };

  const binder = runtime.binder;
  const authority = new Authority({
    storage,
    host,
    content: gameContent,
    moduleBinder: binder,
    allowDirectAgentCommands: true,
    runSeed: runSpec.seed,
  });
  for (const contributor of runtime.contributors) {
    authority.registerModule(contributor);
  }

  const projection = () => storage.transact((tx) => {
    const gameTx = txFor(tx, "read");
    const ports = binder(gameTx) as GameModulePorts;
    return buildPlayerProjection({
      content: gameContent,
      world: ports["game.world"],
      map: ports["game.map"],
      clock: clockView(runtime.clock.readInTransaction(tx, activeBranchId)),
      comms: ports["game.comms"],
      resources: ports["game.resources"],
      actions: ports["game.actions"],
      agreements: ports["game.agreements"],
    });
  });

  /**
   * 会话读取端口：每次读取绑定只读事务与已装配的通信模块公开端口；
   * 会话选择、分页与送达过滤由传输层完成，宿主只提供事实。
   */
  const conversationPort: ConversationReadPort = {
    worldTick: () => clockState().worldTick,
    conversationsOf: (principalId: string) =>
      storage.transact((tx) => {
        const ports = binder(txFor(tx, "conversation")) as GameModulePorts;
        return ports["game.comms"].conversationsOf(principalId);
      }),
    conversationMessages: (conversationId: string, limit: number) =>
      storage.transact((tx) => {
        const ports = binder(txFor(tx, "conversation")) as GameModulePorts;
        return ports["game.comms"].conversationMessages(conversationId, limit);
      }),
    speakerName: (principalId: string) => gameContent.characters.get(principalId)?.name ?? principalId,
  };

  const save = runtime.save;
  const createDrainedSnapshot = (
    input: { readonly label: string; readonly createdBy: string },
  ): ReturnType<typeof save.createSnapshot> => {
    catchUpWorldTick({ storage, clock: runtime.clock, authority, branchId: activeBranchId });
    return save.createSnapshot({ sourceBranchId: activeBranchId, label: input.label, createdBy: input.createdBy });
  };
  const resetOnline = (): { readonly branchId: string; readonly clock: ClockView } => {
    const current = clockState();
    if (current.mode !== "paused") {
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
      // 新分支的初始时钟行由 provider 写入同一事务，秒数取 provider 有效配置。
      runtime.clock.initializeInTransaction(tx, nextBranchId);
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

  const operations = runtime.operations.create({
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
  } satisfies OperationsDriver);

  let workerFailed = false;
  let workerBusy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let app: ServerApp;
  try {
    app = await runtime.transport.createApp({
      authority,
      storage,
      worldId: activeWorldId,
      branchId: activeBranchId,
      assembly: activeResolved.modules,
      sessionAssembly,
      starts: () => startOptions(gameContent),
      conversation: conversationPort,
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
  } catch (error) {
    await startedModules.dispose();
    await storageStarted.dispose();
    throw error;
  }

  try {
    catchUpWorldTick({ storage, clock: runtime.clock, authority, branchId: activeBranchId });
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
        advanceWorldTick({
          storage,
          clock: runtime.clock,
          authority,
          branchId: activeBranchId,
          targetTick: clock.worldTick + 1,
        });
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
    transport: runtime.transport,
    listen: () => runtime.transport.listen(app),
    close: async () => {
      workerFailed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      await app.close();
      await startedModules.dispose();
      await storageStarted.dispose();
    },
  };
}

/** 暴露系统认证构造供宿主测试与调试使用。 */
export const hostSystemAuth = createSystemAuth;
