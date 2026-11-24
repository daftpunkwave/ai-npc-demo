/**
 * 核心职责：按 run 标识启动、停止或恢复实验 run，维护 run 状态与该分支时钟状态的一致性，
 * 并按 operationId 提供幂等语义。
 * 交互契约：依赖存储与宿主时钟；启动接受 ready（首次）与 paused（恢复，保留已有时钟 tick），
 * 停止接受 running。幂等记录与状态变更在同一事务内提交。
 * 约束与禁忌：不写世界状态、不推进 tick、不创建分支；
 * 状态不符或缺时钟时返回领域错误而不是静默跳过，避免持久化出不一致状态。
 */
import { DomainError, type HostServices, type StoragePort, type StorageTransaction } from "@ai-npc/contracts";

/** run 控制所需的依赖。 */
export interface RunControlInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly worldId: string;
}

/** 控制操作的结果：run 标识与操作后的状态。 */
export interface RunControlResult {
  readonly runId: string;
  readonly status: string;
}

/** 控制请求：幂等键与主体。 */
export interface RunControlRequest {
  readonly operationId: string;
  readonly principalId: string;
}

/** 控制操作类型。 */
export type RunControlKind = "start" | "stop";

/**
 * 可启动的状态：`ready` 是首次启动，`paused` 是恢复。
 * 恢复保留已有时钟的 tick——把暂停当作从头开始会丢掉已推进的世界进度。
 */
const startableStatuses = new Set(["ready", "paused"]);

/** 可停止的状态：只有运行中的 run 需要停止。 */
const stoppableStatuses = new Set(["running"]);

/** 幂等表名；与迁移 0015 一致。 */
const idempotencyTable = "run_control_idempotency";

/** 一次控制操作在事务内的上下文：已校验的 run 行与分支时钟。 */
interface ControlContext {
  readonly run: Readonly<Record<string, unknown>>;
  readonly branchId: string;
  readonly clock: Readonly<Record<string, unknown>> | null;
}

/**
 * 读书已提交的幂等记录；键为 (主体, operationId, 操作类型)。
 * run_control_idempotency 是部署级表，经 rows() 访问而不经分支作用域。
 */
function replayOf(
  tx: StorageTransaction,
  request: RunControlRequest,
  kind: RunControlKind,
): { readonly runId: string; readonly status: string } | null {
  const row = tx.rows(idempotencyTable).get({
    principal_id: request.principalId,
    operation_id: request.operationId,
    operation_kind: kind,
  });
  if (row === null) return null;
  const runId = row["run_id"];
  const status = row["status"];
  if (typeof runId !== "string" || typeof status !== "string") return null;
  return { runId, status };
}

/**
 * 两个控制操作的公共前置：幂等重放、run 加载、状态校验。
 *
 * 这段在启动与停止里完全一致，抽出来既消除重复也保证两边对
 * 「重放」「不存在」「状态不符」的处理不会走偏。
 * 返回 null 表示命中了幂等记录，调用方直接返回 replay 结果。
 */
function prepare(
  tx: StorageTransaction,
  runId: string,
  request: RunControlRequest,
  kind: RunControlKind,
  allowed: ReadonlySet<string>,
): { readonly replay: RunControlResult } | { readonly context: ControlContext } {
  const replay = replayOf(tx, request, kind);
  if (replay !== null) {
    // 同一 operationId 用于其他 run 属于调用方错误，不能当成新操作静默执行。
    if (replay.runId !== runId) {
      throw new DomainError("idempotency-conflict", `operationId ${request.operationId} 已用于其他 run`);
    }
    return { replay: { runId, status: replay.status } };
  }
  const run = tx.rows("runs").get({ run_id: runId });
  if (run === null) throw new DomainError("not-found", `run ${runId} 不存在`);
  const status = String(run["status"]);
  if (!allowed.has(status)) {
    const action = kind === "start" ? "启动" : "停止";
    throw new DomainError("invalid-state", `run ${runId} 当前状态为 ${status}，不能${action}`);
  }
  const branchId = String(run["branch_id"]);
  return { context: { run, branchId, clock: tx.branch(branchId).table("clock").get({}) } };
}

/** 写入幂等记录；与状态变更同事务，避免重放窗口。 */
function recordControl(
  tx: StorageTransaction,
  input: RunControlInput,
  runId: string,
  request: RunControlRequest,
  kind: RunControlKind,
  status: string,
  now: string,
): void {
  tx.rows(idempotencyTable).put({
    world_id: input.worldId,
    principal_id: request.principalId,
    operation_id: request.operationId,
    operation_kind: kind,
    run_id: runId,
    status,
    created_at: now,
  });
}

/**
 * 启动或恢复 run。
 *
 * 首次启动创建 tick 0 的运行态时钟；恢复只切换模式并递增版本，
 * 保留 world_tick 与 step 目标。started_at 仅在首次写入，恢复不重置开始时间。
 */
export function startRun(input: RunControlInput, runId: string, request: RunControlRequest): RunControlResult {
  const now = input.host.nowIso();
  return input.storage.transact((tx) => {
    const prepared = prepare(tx, runId, request, "start", startableStatuses);
    if ("replay" in prepared) return prepared.replay;
    const { run, branchId, clock } = prepared.context;
    const clockTable = tx.branch(branchId).table("clock");
    clockTable.put(clock === null
      // 首次启动：实验分支的时钟从 tick 0 开始，处于运行态。
      ? { world_tick: 0, mode: "running", seconds_per_tick: 20, run_version: 0, step_target_tick: null, updated_at: now }
      // 恢复：只切模式，保留 world_tick 与 step 目标。
      : { ...clock, mode: "running", run_version: Number(clock["run_version"]) + 1, updated_at: now });
    const startedAt = run["started_at"];
    tx.rows("runs").put({
      ...run,
      status: "running",
      ...(typeof startedAt === "string" && startedAt.length > 0 ? {} : { started_at: now }),
    });
    recordControl(tx, input, runId, request, "start", "running", now);
    return { runId, status: "running" };
  });
}

/**
 * 停止 run：置为 paused 并同步时钟为暂停态。
 *
 * 缺时钟时显式报错而不是继续更新 run：那会持久化出「run 是 paused 但分支没有时钟」
 * 的不一致状态，后续任何时钟读取都会失败。这种情形只可能来自记录被外部改写。
 */
export function stopRun(input: RunControlInput, runId: string, request: RunControlRequest): RunControlResult {
  const now = input.host.nowIso();
  return input.storage.transact((tx) => {
    const prepared = prepare(tx, runId, request, "stop", stoppableStatuses);
    if ("replay" in prepared) return prepared.replay;
    const { run, branchId, clock } = prepared.context;
    if (clock === null) {
      throw new DomainError("invalid-state", `run ${runId} 缺少分支时钟，无法停止`);
    }
    tx.branch(branchId).table("clock").put({
      ...clock,
      mode: "paused",
      run_version: Number(clock["run_version"]) + 1,
      updated_at: now,
    });
    tx.rows("runs").put({ ...run, status: "paused" });
    recordControl(tx, input, runId, request, "stop", "paused", now);
    return { runId, status: "paused" };
  });
}
