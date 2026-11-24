/**
 * 核心职责：按 run 标识启动、停止或恢复实验 run，维护 run 状态与该分支时钟状态的一致性，
 * 并按 operationId 提供幂等语义。
 * 交互契约：依赖存储与宿主时钟；启动接受 ready（首次）与 paused（恢复，保留已有时钟 tick），
 * 停止接受 running。幂等记录与状态变更在同一事务内提交。
 * 约束与禁忌：不写世界状态、不推进 tick、不创建分支；
 * 状态不符或缺时钟时返回领域错误而不是静默跳过，避免持久化出不一致状态。
 */
import { DomainError, type HostServices, type StoragePort } from "@ai-npc/contracts";

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

/** 在事务内查已有的幂等记录；键为 (主体, operationId, 操作类型)。 */
function replayOf(
  tx: Parameters<Parameters<StoragePort["transact"]>[0]>[0],
  principalId: string,
  operationId: string,
  kind: RunControlKind,
): { readonly runId: string; readonly status: string } | null {
  // run_control_idempotency 是部署级表，经 rows() 访问，不经分支作用域。
  const row = tx.rows(idempotencyTable).get({
    principal_id: principalId,
    operation_id: operationId,
    operation_kind: kind,
  });
  if (row === null) return null;
  const runId = row["run_id"];
  const status = row["status"];
  if (typeof runId !== "string" || typeof status !== "string") return null;
  return { runId, status };
}

/**
 * 启动或恢复 run。
 *
 * 四件事在同一事务里完成：置 status 为 running、首次启动时记录 started_at、
 * 确保分支时钟存在且为运行态、写入幂等记录。
 * 恢复时只切换时钟模式并保留 world_tick，不重置已推进的进度。
 */
export function startRun(
  input: RunControlInput,
  runId: string,
  request: { readonly operationId: string; readonly principalId: string },
): RunControlResult {
  const now = input.host.nowIso();
  return input.storage.transact((tx) => {
    const replay = replayOf(tx, request.principalId, request.operationId, "start");
    if (replay !== null) {
      // 幂等：同一 operationId 重放返回原结果；用于其他 run 属于调用方错误。
      if (replay.runId !== runId) {
        throw new DomainError("idempotency-conflict", `operationId ${request.operationId} 已用于其他 run`);
      }
      return { runId, status: replay.status };
    }

    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null) throw new DomainError("not-found", `run ${runId} 不存在`);
    const status = String(run["status"]);
    if (!startableStatuses.has(status)) {
      throw new DomainError("invalid-state", `run ${runId} 当前状态为 ${status}，不能启动`);
    }
    const branchId = String(run["branch_id"]);
    const existingClock = tx.branch(branchId).table("clock").get({});
    if (existingClock === null) {
      // 首次启动：实验分支的时钟从 tick 0 开始，处于运行态。
      tx.branch(branchId).table("clock").put({
        world_tick: 0,
        mode: "running",
        seconds_per_tick: 20,
        run_version: 0,
        step_target_tick: null,
        updated_at: now,
      });
    } else {
      // 恢复：只切模式，保留 world_tick 与 step 目标。
      tx.branch(branchId).table("clock").put({
        ...existingClock,
        mode: "running",
        run_version: Number(existingClock["run_version"]) + 1,
        updated_at: now,
      });
    }
    const alreadyStarted = run["started_at"];
    tx.rows("runs").put({
      ...run,
      status: "running",
      ...(typeof alreadyStarted === "string" && alreadyStarted.length > 0 ? {} : { started_at: now }),
    });
    tx.rows(idempotencyTable).put({
      world_id: input.worldId,
      principal_id: request.principalId,
      operation_id: request.operationId,
      operation_kind: "start",
      run_id: runId,
      status: "running",
      created_at: now,
    });
    return { runId, status: "running" };
  });
}

/**
 * 停止 run：置为 paused 并同步时钟为暂停态。
 *
 * 缺时钟时显式报错而不是继续更新 run：那会持久化出「run 是 paused 但分支没有时钟」
 * 的不一致状态，后续任何时钟读取都会失败。这种情形只可能来自记录被外部改写。
 */
export function stopRun(
  input: RunControlInput,
  runId: string,
  request: { readonly operationId: string; readonly principalId: string },
): RunControlResult {
  const now = input.host.nowIso();
  return input.storage.transact((tx) => {
    const replay = replayOf(tx, request.principalId, request.operationId, "stop");
    if (replay !== null) {
      if (replay.runId !== runId) {
        throw new DomainError("idempotency-conflict", `operationId ${request.operationId} 已用于其他 run`);
      }
      return { runId, status: replay.status };
    }

    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null) throw new DomainError("not-found", `run ${runId} 不存在`);
    const status = String(run["status"]);
    if (!stoppableStatuses.has(status)) {
      throw new DomainError("invalid-state", `run ${runId} 当前状态为 ${status}，不能停止`);
    }
    const branchId = String(run["branch_id"]);
    const existingClock = tx.branch(branchId).table("clock").get({});
    if (existingClock === null) {
      throw new DomainError("invalid-state", `run ${runId} 缺少分支时钟，无法停止`);
    }
    tx.branch(branchId).table("clock").put({
      ...existingClock,
      mode: "paused",
      run_version: Number(existingClock["run_version"]) + 1,
      updated_at: now,
    });
    tx.rows("runs").put({ ...run, status: "paused" });
    tx.rows(idempotencyTable).put({
      world_id: input.worldId,
      principal_id: request.principalId,
      operation_id: request.operationId,
      operation_kind: "stop",
      run_id: runId,
      status: "paused",
      created_at: now,
    });
    return { runId, status: "paused" };
  });
}
