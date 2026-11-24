/**
 * 核心职责：按 run 标识启动或停止实验 run，维护 run 状态与该分支时钟状态的一致性。
 * 交互契约：依赖存储与宿主时钟；启动要求 run 处于 ready，停止接受 running 与 paused。
 * 约束与禁忌：不写世界状态、不推进 tick、不创建分支；状态不符时返回明确错误而不是静默跳过。
 */
import { DomainError, type HostServices, type StoragePort } from "@ai-npc/contracts";

/** run 控制所需的依赖。 */
export interface RunControlInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
}

/** 控制操作的结果：run 标识与操作后的状态。 */
export interface RunControlResult {
  readonly runId: string;
  readonly status: string;
}

/** 启动时允许的起始状态：只有预检通过的 run 才能开始执行。 */
const startableStatuses = new Set(["ready"]);

/** 停止时允许的状态：未运行或已结束的 run 不需要停止。 */
const stoppableStatuses = new Set(["running", "paused"]);

/**
 * 启动实验 run。
 *
 * 同时做三件事并保持一致性：把 run 状态置为 running、记录 started_at、
 * 为该分支初始化时钟行（创建 run 时只建分支不建时钟）。
 * 三者在一个事务里完成，任一失败都不留下「状态是 running 但时钟不存在」的分支。
 */
export function startRun(input: RunControlInput, runId: string): RunControlResult {
  const now = input.host.nowIso();
  return input.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null) throw new DomainError("not-found", `run ${runId} 不存在`);
    const status = String(run["status"]);
    if (!startableStatuses.has(status)) {
      // 状态不符是业务规则拒绝：明确告知当前状态，而不是假装启动成功。
      throw new DomainError("invalid-state", `run ${runId} 当前状态为 ${status}，不能启动`);
    }
    const branchId = String(run["branch_id"]);
    const existingClock = tx.branch(branchId).table("clock").get({});
    if (existingClock === null) {
      // 实验分支的时钟从 tick 0 开始且处于运行态；秒每 tick 取默认值，由时钟模块读取。
      tx.branch(branchId).table("clock").put({
        world_tick: 0,
        mode: "running",
        seconds_per_tick: 20,
        run_version: 0,
        step_target_tick: null,
        updated_at: now,
      });
    } else {
      // 已有时钟行（重复启动后的重启）：只切模式，不重置 tick。
      tx.branch(branchId).table("clock").put({
        ...existingClock,
        mode: "running",
        run_version: Number(existingClock["run_version"]) + 1,
        updated_at: now,
      });
    }
    tx.rows("runs").put({
      ...run,
      status: "running",
      started_at: run["started_at"] ?? now,
    });
    return { runId, status: "running" };
  });
}

/**
 * 停止实验 run：置为 paused 并同步分支时钟为暂停态。
 *
 * 用 paused 而不是 completed 表达「停止」——停止是可恢复的，
 * 而 completed 表示本次 run 已正常跑完，两者语义不同。
 */
export function stopRun(input: RunControlInput, runId: string): RunControlResult {
  const now = input.host.nowIso();
  return input.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null) throw new DomainError("not-found", `run ${runId} 不存在`);
    const status = String(run["status"]);
    if (!stoppableStatuses.has(status)) {
      throw new DomainError("invalid-state", `run ${runId} 当前状态为 ${status}，不能停止`);
    }
    const branchId = String(run["branch_id"]);
    const existingClock = tx.branch(branchId).table("clock").get({});
    if (existingClock !== null) {
      tx.branch(branchId).table("clock").put({
        ...existingClock,
        mode: "paused",
        run_version: Number(existingClock["run_version"]) + 1,
        updated_at: now,
      });
    }
    tx.rows("runs").put({
      ...run,
      status: "paused",
    });
    return { runId, status: "paused" };
  });
}
