/**
 * 在线世界的固定 tick 执行顺序：写入时钟、到期 job、时钟步骤、事件消费者。
 * 依赖存储事务、authority 的 job/时钟/消费者执行器与宿主时间服务；每个阶段各自提交事务。
 * 禁止把整个 tick 合并进一个事务、跳过命中阶段或吞掉阶段异常；补完入口不得推进 tick。
 */
import { DomainError, type HostServices, type StoragePort, type StorageTransaction } from "@ai-npc/contracts";

/** 一次 tick 需要的 authority 入口；结构类型让宿主与测试共用同一顺序。 */
export interface TickAuthority {
  readonly jobs: { runDue(branchId: string, tick: number): number };
  readonly clock: { run(branchId: string): number };
  readonly consumers: {
    run(branchId: string): { readonly processed: number; readonly scanned: number };
  };
}

/** 补完当前 tick 与推进下一 tick 共用的运行环境。 */
export interface WorldTickContext {
  readonly storage: StoragePort;
  readonly authority: TickAuthority;
  readonly host: Pick<HostServices, "nowIso">;
  readonly branchId: string;
}

/** 推进一个 tick 的输入：目标 tick 只能比当前 tick 大 1。 */
export interface AdvanceWorldTickInput extends WorldTickContext {
  readonly targetTick: number;
}

/** 一次 tick 各阶段的执行计数；worldTick 是阶段执行时的分支时钟。 */
export interface WorldTickResult {
  readonly worldTick: number;
  readonly executedJobs: number;
  readonly executedClockSteps: number;
  readonly consumers: { readonly processed: number; readonly scanned: number };
}

/** 时钟行中本入口需要的字段。 */
interface ClockRow {
  readonly worldTick: number;
  readonly mode: string;
}

/** 允许逻辑时间前进的时钟模式；paused 等模式由模式语义拒绝推进。 */
const advancingModes: ReadonlySet<string> = new Set(["running", "stepping"]);

/** 读取并校验分支时钟行；缺失或列非法时明确失败，避免在未知世界时间上推进。 */
function readClockRow(tx: StorageTransaction, branchId: string): ClockRow {
  const row = tx.branch(branchId).table("clock").get({});
  if (row === null) {
    throw new DomainError("not-ready", `分支 ${branchId} 尚未建立时钟状态`, {
      details: { branchId },
    });
  }
  const worldTick = row["world_tick"];
  if (typeof worldTick !== "number" || !Number.isSafeInteger(worldTick) || worldTick < 0) {
    throw new DomainError("invalid-state", "clock.world_tick 不是非负安全整数", {
      details: { branchId },
    });
  }
  const mode = row["mode"];
  if (typeof mode !== "string" || mode.length === 0) {
    throw new DomainError("invalid-state", "clock.mode 不是非空字符串", {
      details: { branchId },
    });
  }
  return { worldTick, mode };
}

/** 在同一事务内把时钟写为目标 tick；不产生领域事件。 */
function commitClockTick(tx: StorageTransaction, input: AdvanceWorldTickInput): number {
  const branch = tx.rows("branches").get({ branch_id: input.branchId });
  if (branch === null) {
    throw new DomainError("not-found", `分支 ${input.branchId} 不存在`, {
      details: { branchId: input.branchId },
    });
  }
  const status = branch["status"];
  if (status !== "active" && status !== "paused") {
    throw new DomainError("forbidden", `分支 ${input.branchId} 当前状态不接受 tick 推进`, {
      details: { branchId: input.branchId, status: String(status) },
    });
  }
  const clock = readClockRow(tx, input.branchId);
  if (!advancingModes.has(clock.mode)) {
    throw new DomainError("invalid-state", `时钟模式 ${clock.mode} 下不能推进 tick`, {
      details: { branchId: input.branchId, mode: clock.mode },
    });
  }
  if (input.targetTick !== clock.worldTick + 1) {
    throw new DomainError("validation", "一次只允许推进一个 tick，跨 tick 会跳过每日结算与章节评估", {
      details: { currentTick: clock.worldTick, targetTick: input.targetTick },
    });
  }
  const table = tx.branch(input.branchId).table("clock");
  const row = table.get({});
  if (row === null) {
    throw new DomainError("not-ready", `分支 ${input.branchId} 尚未建立时钟状态`, {
      details: { branchId: input.branchId },
    });
  }
  table.put({ ...row, world_tick: input.targetTick, updated_at: input.host.nowIso() });
  return input.targetTick;
}

/** 按规则顺序补完一个已提交 tick 的其余阶段；任一步抛错都向上传播。 */
function completeTick(input: WorldTickContext, worldTick: number): WorldTickResult {
  const executedJobs = input.authority.jobs.runDue(input.branchId, worldTick);
  const executedClockSteps = input.authority.clock.run(input.branchId);
  const consumers = input.authority.consumers.run(input.branchId);
  return {
    worldTick,
    executedJobs,
    executedClockSteps,
    consumers: { processed: consumers.processed, scanned: consumers.scanned },
  };
}

/**
 * 推进一个 tick：时钟写入、到期 job、时钟步骤、消费者依次提交。
 * 阶段失败时保留已提交阶段并把错误交给调用方，由宿主记录并停止后续调度。
 */
export function advanceWorldTick(input: AdvanceWorldTickInput): WorldTickResult {
  if (!Number.isSafeInteger(input.targetTick) || input.targetTick < 1) {
    throw new DomainError("validation", "目标 tick 必须是正整数", {
      details: { targetTick: input.targetTick },
    });
  }
  const worldTick = input.storage.transact((tx) => commitClockTick(tx, input));
  return completeTick(input, worldTick);
}

/**
 * 不推进 tick，只对当前 clock.world_tick 幂等重跑到期 job、时钟步骤与消费者。
 * 已提交的 job、每日结算与章节评估依赖各自 done 标记和状态守卫只生效一次。
 */
export function catchUpWorldTick(input: WorldTickContext): WorldTickResult {
  const worldTick = input.storage.transact((tx) => readClockRow(tx, input.branchId).worldTick);
  return completeTick(input, worldTick);
}
