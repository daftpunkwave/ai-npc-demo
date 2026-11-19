/**
 * 打开服务端宿主：装配预检、存储启动、在线 run 解析、运营操作幂等、按计划启动剩余模块、authority、应用与时钟 worker。
 * 依赖 kernel 解析/生命周期、组合根公开端口、实验配置加载器、部署配置校验与 authority；不启动浏览器端。
 * 禁止绕过解析计划直接引用模块实现，也禁止按当前入参重建已冻结的在线 run 或重复实现时钟状态。
 */
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DomainError,
  assemblyDescriptorSchema,
  canonicalJson,
  clockViewSchema,
  isErrorCode,
  jsonValueSchema,
  type AssemblyDescriptor,
  type AuthContext,
  type ClockView,
  type ErrorCode,
  type Json,
  type ModuleDefinition,
  type StartOption,
  type StoragePort,
  type StorageRow,
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
  /** 命令网关；嵌入式宿主与测试可以按生产装配直接提交命令。 */
  readonly authority: Authority;
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

/** 运营操作种类；与 operation_idempotency.operation_kind 的约束一致。 */
type OperationKind = "pause" | "resume" | "snapshot" | "restore" | "reset";

/** 请求体中的幂等键与认证主体；传输层校验请求结构后传入。 */
interface OperationActor {
  readonly operationId: string;
  readonly principalId: string;
}

/** 幂等键：世界、认证主体与 operationId；请求内容哈希只用于识别同键不同内容。 */
interface OperationKey {
  readonly kind: OperationKind;
  readonly worldId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly requestHash: string;
}

/** 已持久化的首次结果：成功结果或失败原因；失败也按同一 operationId 返回。 */
type OperationOutcome =
  | { readonly status: "succeeded"; readonly result: Json }
  | { readonly status: "failed"; readonly code: ErrorCode; readonly retryable: boolean; readonly safeMessage: string };

/** 部署级幂等表；不含 branch_id，因此跨在线别名切换与进程重启仍然有效。 */
const operationIdempotencyTable = "operation_idempotency";

/** 运营请求内容哈希：覆盖操作类型与业务字段，复用规范 JSON 保证键顺序无关。 */
function operationRequestHash(kind: OperationKind, content: Json): string {
  return createHash("sha256").update(canonicalJson({ kind, content })).digest("hex");
}

/** 对客户端公开的错误形状；未预期的宿主异常不携带内部细节。 */
function publicOperationError(error: unknown): {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
} {
  if (error instanceof DomainError) {
    return { code: error.code, retryable: error.retryable, safeMessage: error.safeMessage };
  }
  return { code: "plugin-failed", retryable: false, safeMessage: "服务器内部错误" };
}

/** 从幂等记录行还原首次结果；同键不同内容在此明确冲突。 */
function storedOperationOutcome(row: StorageRow, key: OperationKey): OperationOutcome {
  const storedHash = row["request_hash"];
  if (typeof storedHash !== "string") {
    throw new DomainError("invalid-state", "运营幂等记录缺少请求哈希");
  }
  if (storedHash !== key.requestHash) {
    throw new DomainError("idempotency-conflict", "同一 operationId 已用于不同请求内容", {
      details: { operationId: key.operationId, kind: key.kind },
    });
  }
  const status = row["status"];
  if (status === "succeeded") {
    const result = row["result_json"];
    if (result === null || result === undefined || result instanceof Uint8Array) {
      throw new DomainError("invalid-state", "运营幂等记录缺少首次结果");
    }
    return { status: "succeeded", result: result as Json };
  }
  if (status === "failed") {
    const code = row["error_code"];
    const retryable = row["error_retryable"];
    const safeMessage = row["error_safe_message"];
    if (typeof code !== "string" || !isErrorCode(code)) {
      throw new DomainError("invalid-state", "运营幂等记录的错误码不合法");
    }
    if (typeof retryable !== "number" || (retryable !== 0 && retryable !== 1)) {
      throw new DomainError("invalid-state", "运营幂等记录的重试标记不合法");
    }
    if (typeof safeMessage !== "string" || safeMessage.length === 0) {
      throw new DomainError("invalid-state", "运营幂等记录缺少安全文案");
    }
    return { status: "failed", code, retryable: retryable === 1, safeMessage };
  }
  throw new DomainError("invalid-state", "运营幂等记录状态不合法");
}

/** 把宿主构造的纯数据结果转换为契约 JSON；非法值在这里失败，不写入半成品记录。 */
function toJsonResult(value: unknown): Json {
  return jsonValueSchema.parse(value);
}

function operationJsonObject(value: Json, label: string): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("invalid-state", `运营幂等记录中的${label}结果不合法`);
  }
  return value as Record<string, Json>;
}

/** 校验并还原时钟结果；记录由宿主自己写入，非法内容说明存储被破坏。 */
function decodeClockOutcome(value: Json): ClockView {
  const parsed = clockViewSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "运营幂等记录中的时钟结果不合法");
  }
  return parsed.data;
}

function decodeSnapshotOutcome(value: Json): { readonly snapshotId: string; readonly worldTick: number } {
  const record = operationJsonObject(value, "快照");
  const snapshotId = record["snapshotId"];
  const worldTick = record["worldTick"];
  if (typeof snapshotId !== "string" || typeof worldTick !== "number" || !Number.isSafeInteger(worldTick)) {
    throw new DomainError("invalid-state", "运营幂等记录中的快照结果不合法");
  }
  return { snapshotId, worldTick };
}

function decodeBranchClockOutcome(value: Json): { readonly branchId: string; readonly clock: ClockView } {
  const record = operationJsonObject(value, "分支");
  const branchId = record["branchId"];
  const clock = record["clock"];
  if (typeof branchId !== "string" || branchId.length === 0 || clock === undefined) {
    throw new DomainError("invalid-state", "运营幂等记录中的分支结果不合法");
  }
  return { branchId, clock: decodeClockOutcome(clock) };
}

/**
 * 运营操作日志：按认证主体与 operationId 读取首次结果，或在同一事务内写入结果。
 * 只读写部署级表，不参与分支复制；写入失败只记录日志，不覆盖原始业务错误。
 */
class OperationJournal {
  private readonly storage: StoragePort;
  private readonly nowIso: () => string;
  private readonly report: (message: string, error: unknown) => void;

  constructor(storage: StoragePort, nowIso: () => string, report: (message: string, error: unknown) => void) {
    this.storage = storage;
    this.nowIso = nowIso;
    this.report = report;
  }

  /** 在独立读事务中查首次结果；命中时返回，未命中返回 null，同键不同内容抛冲突。 */
  replay<T>(key: OperationKey, decode: (value: Json) => T): T | null {
    const outcome = this.storage.transact((tx) => this.read(tx, key));
    return outcome === null ? null : this.materialize(outcome, decode);
  }

  /** 在调用方事务内读取首次结果；不做任何写入。 */
  read(tx: StorageTransaction, key: OperationKey): OperationOutcome | null {
    const row = tx.rows(operationIdempotencyTable).get({
      world_id: key.worldId,
      principal_id: key.principalId,
      operation_id: key.operationId,
    });
    return row === null ? null : storedOperationOutcome(row, key);
  }

  /** 首次结果成功时返回结果；失败时抛出与首次执行相同的领域错误。 */
  materialize<T>(outcome: OperationOutcome, decode: (value: Json) => T): T {
    if (outcome.status === "failed") {
      throw new DomainError(outcome.code, outcome.safeMessage, { retryable: outcome.retryable });
    }
    return decode(outcome.result);
  }

  /**
   * 在独立事务中写入成功结果；仅用于无法把业务写入并入同一事务的时钟控制。
   * 调用方须保证业务写入已经成功。
   */
  recordSuccessStandalone(key: OperationKey, result: Json): void {
    this.storage.transact((tx) => this.recordSuccess(tx, key, result));
  }

  /** 把成功结果写入调用方事务；调用方负责把业务写入与本次写入一起提交。 */
  recordSuccess(tx: StorageTransaction, key: OperationKey, result: Json): void {
    tx.rows(operationIdempotencyTable).put({
      world_id: key.worldId,
      principal_id: key.principalId,
      operation_id: key.operationId,
      operation_kind: key.kind,
      request_hash: key.requestHash,
      status: "succeeded",
      result_json: result,
      error_code: null,
      error_retryable: 0,
      error_safe_message: null,
      created_at: this.nowIso(),
    });
  }

  /** 记录首次执行的失败原因；已有记录时不覆盖，写入失败只记日志。 */
  recordFailure(key: OperationKey, error: unknown): void {
    const published = publicOperationError(error);
    try {
      this.storage.transact((tx) => {
        const existing = tx.rows(operationIdempotencyTable).get({
          world_id: key.worldId,
          principal_id: key.principalId,
          operation_id: key.operationId,
        });
        if (existing !== null) {
          return;
        }
        tx.rows(operationIdempotencyTable).put({
          world_id: key.worldId,
          principal_id: key.principalId,
          operation_id: key.operationId,
          operation_kind: key.kind,
          request_hash: key.requestHash,
          status: "failed",
          result_json: null,
          error_code: published.code,
          error_retryable: published.retryable ? 1 : 0,
          error_safe_message: published.safeMessage,
          created_at: this.nowIso(),
        });
      });
    } catch (recordError) {
      this.report("运营幂等失败记录写入失败", recordError);
    }
  }
}

/** 在线入口：world_aliases('online') 指向的唯一在线分支及其绑定的 live run。 */
interface OnlineEntry {
  readonly branch: StorageRow;
  readonly run: StorageRow;
  readonly branchId: string;
  readonly runId: string;
  readonly worldId: string;
}

/**
 * 从持久化的在线别名解析分支与 run；这是启动、重启与恢复共同的唯一入口。
 * 别名缺失表示首次启动，返回 null；别名存在但分支、run 或状态不一致时明确失败，不静默新建或改选其他分支。
 */
function readOnlineEntry(tx: StorageTransaction): OnlineEntry | null {
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
    throw new Error(`在线别名指向的分支 ${branchId} 不存在；拒绝启动`);
  }
  if (branch["kind"] !== "online") {
    throw new Error(`在线别名指向的分支 ${branchId} 不是 online 分支；拒绝启动`);
  }
  const status = branch["status"];
  if (status !== "active" && status !== "paused") {
    throw new Error(`在线别名指向的分支 ${branchId} 状态为 ${String(status)}；拒绝启动`);
  }
  const runId = typeof branch["run_id"] === "string" ? branch["run_id"] : "";
  if (runId.length === 0) {
    throw new Error(`在线分支 ${branchId} 没有绑定 run；拒绝启动`);
  }
  const run = tx.rows("runs").get({ run_id: runId });
  if (run === null) {
    throw new Error(`在线分支 ${branchId} 绑定的 run ${runId} 不存在；拒绝启动`);
  }
  if (run["mode"] !== "live") {
    throw new Error(`在线 run ${runId} 不是 live run；拒绝启动`);
  }
  if (run["branch_id"] !== branchId) {
    throw new Error(`在线 run ${runId} 绑定的分支与别名分支 ${branchId} 不一致；拒绝启动`);
  }
  const runStatus = run["status"];
  if (runStatus === "completed" || runStatus === "failed" || runStatus === "invalid") {
    throw new Error(`在线 run ${runId} 状态为 ${String(runStatus)}；拒绝启动`);
  }
  const worldId = typeof branch["world_id"] === "string" ? branch["world_id"] : "";
  if (worldId.length === 0) {
    throw new Error(`在线分支 ${branchId} 缺少 world_id；拒绝启动`);
  }
  return { branch, run, branchId, runId, worldId };
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
  const journal = new OperationJournal(storage, () => host.nowIso(), (message, error) => {
    host.logger.error(message, { message: error instanceof Error ? error.message : String(error) });
  });

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
  const resumeRun = async (online: OnlineEntry): Promise<ResumedRunState> => {
    const run = online.run;
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
    const worldRow = storage.transact((tx) => tx.rows("worlds").get({ world_id: online.worldId }));
    if (worldRow === null) {
      throw new Error(`在线分支引用的 world ${online.worldId} 不存在`);
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
        worldId: online.worldId,
        branchId: online.branchId,
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
    const online = storage.transact(readOnlineEntry);

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
      throw result.reasonCode === "version-conflict"
        ? new DomainError("version-conflict", "时钟版本冲突")
        : new DomainError("invalid-state", "时钟控制参数非法");
    }
    return clockView(result.clock);
  };

  /** 运营操作键：世界取当前在线世界，主体与 operationId 由认证会话和请求体给出。 */
  const operationKeyFor = (
    kind: OperationKind,
    principalId: string,
    operationId: string,
    content: Json,
  ): OperationKey => ({
    kind,
    worldId: activeWorldId,
    principalId,
    operationId,
    requestHash: operationRequestHash(kind, content),
  });

  const binder = runtime.binder;
  // 生产装配使用默认 fencing：Agent 命令必须带有效 turn 租约，测试辅助方可显式放开直连。
  const authority = new Authority({
    storage,
    host,
    content: gameContent,
    moduleBinder: binder,
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
  /** 快照前的受控准备：运行中先暂停，再幂等补完当前 tick 的到期 job 与消费者。 */
  const prepareSnapshot = (): void => {
    const current = clockState();
    if (current.mode === "running") {
      control("pause", current.runVersion);
    }
    catchUpWorldTick({ storage, clock: runtime.clock, authority, branchId: activeBranchId });
  };
  const createDrainedSnapshot = (
    input: { readonly label: string; readonly createdBy: string },
  ): ReturnType<typeof save.createSnapshot> => {
    catchUpWorldTick({ storage, clock: runtime.clock, authority, branchId: activeBranchId });
    return save.createSnapshot({ sourceBranchId: activeBranchId, label: input.label, createdBy: input.createdBy });
  };
  /**
   * 重开的单事务部分：先把当前在线世界冻结为快照，再创建新的空在线分支与 live run、
   * 结束旧 run、归档旧分支并切换在线别名；调用方负责先暂停并补完 tick。
   */
  const resetInTransaction = (
    tx: StorageTransaction,
    createdBy: string,
  ): { readonly branchId: string; readonly clock: ClockView } => {
    const alias = tx.rows("world_aliases").get({ alias: "online" });
    if (alias === null || alias["branch_id"] !== activeBranchId) {
      throw new DomainError("invalid-state", "在线别名在重开事务内发生变化，拒绝切换");
    }
    const previous = tx.rows("branches").get({ branch_id: activeBranchId });
    if (previous === null) {
      throw new DomainError("invalid-state", `在线分支 ${activeBranchId} 不存在，拒绝重开`);
    }
    if (previous["kind"] !== "online") {
      throw new DomainError("invalid-state", `在线分支 ${activeBranchId} 不是 online 分支，拒绝重开`);
    }
    const previousStatus = previous["status"];
    if (previousStatus !== "active" && previousStatus !== "paused") {
      throw new DomainError("invalid-state", `在线分支 ${activeBranchId} 状态为 ${String(previousStatus)}，拒绝重开`);
    }
    const previousRunId = typeof previous["run_id"] === "string" ? previous["run_id"] : "";
    const previousRun = previousRunId.length === 0 ? null : tx.rows("runs").get({ run_id: previousRunId });
    if (previousRun === null) {
      throw new DomainError("invalid-state", `在线分支 ${activeBranchId} 没有绑定 run，拒绝重开`);
    }
    const clockRow = runtime.clock.readInTransaction(tx, activeBranchId);
    const now = host.nowIso();
    const nextBranchId = host.ids("br");
    const nextRunId = host.ids("run");
    // 重开前的快照与后续分支切换同事务提交，避免失败时留下孤立快照或半切换别名。
    save.createSnapshotInTransaction(tx, {
      sourceBranchId: activeBranchId,
      label: `reset-${clockRow.worldTick}`,
      createdBy,
    });
    const nextBranch: StorageRow = {
      branch_id: nextBranchId,
      world_id: activeWorldId,
      kind: "online",
      status: "active",
      parent_branch_id: activeBranchId,
      forked_at_world_seq: null,
      run_id: null,
      profile_hash: null,
      created_at: now,
    };
    tx.rows("branches").put(nextBranch);
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
    tx.rows("branches").put({ ...nextBranch, run_id: nextRunId });
    // 新分支的初始时钟行由 provider 写入同一事务，秒数取 provider 有效配置。
    runtime.clock.initializeInTransaction(tx, nextBranchId);
    tx.rows("runs").put({ ...previousRun, status: "completed", ended_at: now });
    tx.rows("branches").put({ ...previous, status: "archived" });
    tx.rows("world_aliases").put({ alias: "online", branch_id: nextBranchId, updated_at: now });
    return { branchId: nextBranchId, clock: clockView(runtime.clock.readInTransaction(tx, nextBranchId)) };
  };
  /**
   * 重开：先把当前在线世界存为快照，再在同一事务内创建新的空在线分支与 live run、
   * 结束旧 run、归档旧分支并切换在线别名；重启后从别名选中新分支。
   */
  const resetOnline = (): { readonly branchId: string; readonly clock: ClockView } => {
    const online = storage.transact(readOnlineEntry);
    if (online === null) {
      throw new DomainError("invalid-state", "没有 world_aliases('online')，拒绝重开");
    }
    if (online.branchId !== activeBranchId) {
      throw new DomainError(
        "invalid-state",
        `在线别名指向 ${online.branchId}，与宿主分支 ${activeBranchId} 不一致；拒绝重开`,
      );
    }
    prepareSnapshot();
    const result = storage.transact((tx) => resetInTransaction(tx, "operator-1"));
    activeBranchId = result.branchId;
    return result;
  };

  /**
   * 恢复 dry-run 的内容与模块兼容性裁决：内容包版本、RunSpec、装配、名册与冻结 manifest
   * 必须仍与当前宿主一致；任何不兼容都在写入前失败，不产生快照副本或别名变更。
   */
  const validateRestoreSource = (inspection: ReturnType<typeof save.inspectRestore>): void => {
    const parsed = runSpecSchema.safeParse(inspection.sourceRun.runSpec);
    if (!parsed.success) {
      throw new Error(`快照源 run 的 RunSpec 无法解析：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    }
    const sourceSpec = parsed.data;
    const facts = readFrozenManifest(inspection.sourceRun.manifest);
    if (facts.packId !== packId) {
      throw new Error(`内容包不一致：快照源 run 冻结「${facts.packId}」，当前内容包「${packId}」；拒绝恢复`);
    }
    if (facts.contentVersion !== contentVersion) {
      throw contentVersionMismatch(facts.contentVersion, contentVersion, "快照源 run");
    }
    if (facts.seed !== sourceSpec.seed) {
      throw new Error("快照源 run 的 seed 与 RunSpec 不一致；拒绝恢复");
    }
    if (facts.moduleAssemblyRef !== sourceSpec.moduleAssemblyRef) {
      throw new Error("快照源 run 的装配引用与 RunSpec 不一致；拒绝恢复");
    }
    if (facts.rosterRef !== sourceSpec.rosterRef) {
      throw new Error("快照源 run 的名册引用与 RunSpec 不一致；拒绝恢复");
    }
    if (sourceSpec.worldPackRef !== packId) {
      throw new Error(`快照源 RunSpec 的 worldPackRef「${sourceSpec.worldPackRef}」与当前内容包「${packId}」不一致；拒绝恢复`);
    }
    if (inspection.sourceRun.manifestHash !== frozenManifestHash) {
      throw new Error("快照源 run 的冻结 manifest 与当前在线 run 不一致（模块、名册或内容版本不同）；拒绝恢复");
    }
    if (canonicalJson(sourceSpec as unknown as Json) !== canonicalJson(runSpec as unknown as Json)) {
      throw new Error("快照源 run 的 RunSpec 与当前在线 run 不一致；拒绝恢复");
    }
    const assembly = loadAssembly(sourceSpec.moduleAssemblyRef);
    if (assembly.assemblyId !== activeAssembly.assemblyId) {
      throw new Error(
        `快照源 run 的装配「${assembly.assemblyId}」与当前在线装配「${activeAssembly.assemblyId}」不一致；拒绝恢复`,
      );
    }
    const roster = loadRoster(sourceSpec.rosterRef, loadContext);
    validateRoster(roster.value, content);
    validateRunSpec(sourceSpec, content, roster);
  };

  /**
   * 从快照恢复：先 dry-run 校验内容与运行规格兼容性，再在同一事务内建立后继分支与 run、
   * 结束旧 run、归档旧分支并切换在线别名；提交后更新宿主内存中的在线分支与世界。
   */
  const restoreOnlineRun = (
    input: { readonly snapshotId: string; readonly createdBy: string; readonly runId?: string },
  ): ReturnType<typeof save.restoreSnapshot> => {
    const inspection = save.inspectRestore(input.snapshotId);
    validateRestoreSource(inspection);
    const restored = save.restoreSnapshot({
      snapshotId: input.snapshotId,
      createdBy: input.createdBy,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      expected: {
        sourceRunId: inspection.sourceRun.runId,
        canonicalRunSpec: canonicalJson(inspection.sourceRun.runSpec),
        manifestHash: inspection.sourceRun.manifestHash,
        worldSeq: inspection.worldSeq,
        worldTick: inspection.worldTick,
      },
    });
    activeBranchId = restored.branchId;
    activeWorldId = restored.worldId;
    return restored;
  };

  /**
   * 暂停/继续的幂等执行。时钟 provider 自持事务，结果记录只能随后单独提交，
   * 两次提交之间崩溃会退化为重新执行一次时钟控制，不承诺该窗口的原子性。
   */
  const controlOperation = (
    kind: "pause" | "resume",
    expectedRunVersion: number,
    operation: OperationActor,
  ): ClockView => {
    const key = operationKeyFor(kind, operation.principalId, operation.operationId, { expectedRunVersion });
    const replayed = journal.replay(key, decodeClockOutcome);
    if (replayed !== null) {
      return replayed;
    }
    let clock: ClockView;
    try {
      clock = control(kind === "pause" ? "pause" : "start", expectedRunVersion);
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
    journal.recordSuccessStandalone(key, toJsonResult(clock));
    return clock;
  };

  /** 快照的幂等执行：首次结果与冻结分支、快照行在同一事务提交。 */
  const snapshotOperation = (
    operation: OperationActor,
    input: { readonly label: string; readonly createdBy: string },
  ): { readonly snapshotId: string; readonly worldTick: number } => {
    const key = operationKeyFor("snapshot", operation.principalId, operation.operationId, { label: input.label });
    const replayed = journal.replay(key, decodeSnapshotOutcome);
    if (replayed !== null) {
      return replayed;
    }
    try {
      prepareSnapshot();
      return storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) {
          return journal.materialize(stored, decodeSnapshotOutcome);
        }
        const created = save.createSnapshotInTransaction(tx, {
          sourceBranchId: activeBranchId,
          label: input.label,
          createdBy: input.createdBy,
        });
        const outcome = { snapshotId: created.snapshotId, worldTick: created.worldTick };
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return outcome;
      });
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  /** 恢复的幂等执行：首次结果、后继分支/run 与别名切换在同一事务提交。 */
  const restoreOperation = (
    operation: OperationActor,
    input: { readonly snapshotId: string; readonly createdBy: string; readonly runId?: string },
  ): { readonly branchId: string; readonly clock: ClockView } => {
    const key = operationKeyFor("restore", operation.principalId, operation.operationId, {
      snapshotId: input.snapshotId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    });
    const replayed = journal.replay(key, decodeBranchClockOutcome);
    if (replayed !== null) {
      return replayed;
    }
    try {
      const committed = storage.transact((tx): {
        readonly outcome: { readonly branchId: string; readonly clock: ClockView };
        readonly applied: boolean;
        readonly worldId?: string;
      } => {
        const stored = journal.read(tx, key);
        if (stored !== null) {
          return { outcome: journal.materialize(stored, decodeBranchClockOutcome), applied: false };
        }
        const inspection = save.inspectRestoreInTransaction(tx, input.snapshotId);
        validateRestoreSource(inspection);
        const restored = save.restoreSnapshotInTransaction(tx, {
          snapshotId: input.snapshotId,
          createdBy: input.createdBy,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          expected: {
            sourceRunId: inspection.sourceRun.runId,
            canonicalRunSpec: canonicalJson(inspection.sourceRun.runSpec),
            manifestHash: inspection.sourceRun.manifestHash,
            worldSeq: inspection.worldSeq,
            worldTick: inspection.worldTick,
          },
        });
        const outcome = {
          branchId: restored.branchId,
          clock: clockView(runtime.clock.readInTransaction(tx, restored.branchId)),
        };
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return { outcome, applied: true, worldId: restored.worldId };
      });
      if (committed.applied) {
        activeBranchId = committed.outcome.branchId;
        activeWorldId = committed.worldId ?? activeWorldId;
      }
      return committed.outcome;
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  /** 重开的幂等执行：重开前的快照与分支切换同事务，结果同事务写入。 */
  const resetOperation = (operation: OperationActor): { readonly branchId: string; readonly clock: ClockView } => {
    const key = operationKeyFor("reset", operation.principalId, operation.operationId, {});
    const replayed = journal.replay(key, decodeBranchClockOutcome);
    if (replayed !== null) {
      return replayed;
    }
    try {
      const online = storage.transact(readOnlineEntry);
      if (online === null) {
        throw new DomainError("invalid-state", "没有 world_aliases('online')，拒绝重开");
      }
      if (online.branchId !== activeBranchId) {
        throw new DomainError(
          "invalid-state",
          `在线别名指向 ${online.branchId}，与宿主分支 ${activeBranchId} 不一致；拒绝重开`,
        );
      }
      prepareSnapshot();
      const committed = storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) {
          return { outcome: journal.materialize(stored, decodeBranchClockOutcome), applied: false };
        }
        const outcome = resetInTransaction(tx, operation.principalId);
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return { outcome, applied: true };
      });
      if (committed.applied) {
        activeBranchId = committed.outcome.branchId;
      }
      return committed.outcome;
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  const operations = runtime.operations.create({
    clock: () => clockState(),
    pause: (expected) => control("pause", expected),
    resume: (expected) => control("start", expected),
    snapshot: (input) => createDrainedSnapshot({ label: input.label, createdBy: input.createdBy }),
    restore: (input) => restoreOnlineRun(input),
    reset: resetOnline,
    idempotent: {
      pause: (operation, expected) => controlOperation("pause", expected, operation),
      resume: (operation, expected) => controlOperation("resume", expected, operation),
      snapshot: (operation, input) => snapshotOperation(operation, input),
      restore: (operation, input) => restoreOperation(operation, input),
      reset: (operation) => resetOperation(operation),
    },
  } satisfies OperationsDriver);

  let workerFailed = false;
  let workerBusy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let app: ServerApp;
  try {
    app = await runtime.transport.createApp({
      authority,
      accessPolicy: runtime.accessPolicy,
      storage,
      worldId: activeWorldId,
      branchId: activeBranchId,
      assembly: activeResolved.modules,
      sessionAssembly,
      starts: () => startOptions(gameContent),
      conversation: conversationPort,
      projection,
      clock: () => clockView(clockState()),
      pause: (operationId, expected, principalId) =>
        operations.pause(expected, { operationId, principalId }),
      resume: (operationId, expected, principalId) =>
        operations.resume(expected, { operationId, principalId }),
      save: {
        createSnapshot: (input) =>
          operations.snapshot(input.label, input.createdBy, {
            operationId: input.operationId,
            principalId: input.principalId,
          }),
        listSnapshots: () => save.listSnapshots(),
        restoreSnapshot: (input) =>
          operations.restore(input.snapshotId, input.createdBy, input.runId, {
            operationId: input.operationId,
            principalId: input.principalId,
          }),
      },
      reset: (operationId, principalId) => operations.reset({ operationId, principalId }),
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
    authority,
    // 在线分支切换后仍反映当前在线入口，调用方不需要重新启动宿主即可读取。
    get branchId(): string {
      return activeBranchId;
    },
    get worldId(): string {
      return activeWorldId;
    },
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
