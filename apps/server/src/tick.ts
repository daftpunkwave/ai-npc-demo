/**
 * 在线世界的固定 tick 执行顺序：写入时钟、到期 job、时钟步骤、事件消费者。
 * 依赖存储事务读取分支状态、authority 的 job/时钟/消费者执行器、时钟模块端口与宿主时间服务。
 * 每个阶段各自提交事务；时钟读写只经模块端口，禁止在这里解析或改写 clock 行。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名用于表达调用契约。 */
import { DomainError, type HostServices, type StoragePort } from "@ai-npc/contracts";
import type { ClockState } from "@ai-npc/module-sdk";

/** 一次 tick 需要的 authority 入口；结构类型让宿主与测试共用同一顺序。 */
export interface TickAuthority {
  readonly jobs: { runDue(branchId: string, tick: number): number };
  readonly clock: { run(branchId: string): number };
  readonly consumers: {
    run(branchId: string): { readonly processed: number; readonly scanned: number };
  };
}

/** tick 推进需要的时钟端口视图；读取与推进都由时钟 provider 完成。 */
export interface TickClockPort {
  read(branchId: string): ClockState;
  setTick(branchId: string, tick: number): ClockState;
}

/** 补完当前 tick 与推进下一 tick 共用的运行环境。 */
export interface WorldTickContext {
  readonly storage: StoragePort;
  readonly clock: TickClockPort;
  readonly authority: TickAuthority;
  readonly branchId: string;
  /** 兼容既有调用方传入的宿主时间服务；tick 推进本身只经时钟端口。 */
  readonly host?: Pick<HostServices, "nowIso">;
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

/** 允许逻辑时间前进的时钟模式；paused 等模式由模式语义拒绝推进。 */
const advancingModes: ReadonlySet<string> = new Set(["running", "stepping"]);

/** 分支状态决定是否接受 tick 推进；时钟字段本身由模块端口校验。 */
function assertBranchAcceptsTicks(storage: StoragePort, branchId: string): void {
  const branch = storage.transact((tx) => tx.rows("branches").get({ branch_id: branchId }));
  if (branch === null) {
    throw new DomainError("not-found", `分支 ${branchId} 不存在`, {
      details: { branchId },
    });
  }
  const status = branch["status"];
  if (status !== "active" && status !== "paused") {
    throw new DomainError("forbidden", `分支 ${branchId} 当前状态不接受 tick 推进`, {
      details: { branchId, status: String(status) },
    });
  }
}

/** 通过时钟端口把逻辑时间推进一个 tick；越界与模式由时钟 provider 拒绝。 */
function commitClockTick(input: AdvanceWorldTickInput): number {
  assertBranchAcceptsTicks(input.storage, input.branchId);
  const clock = input.clock.read(input.branchId);
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
  return input.clock.setTick(input.branchId, input.targetTick).worldTick;
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
  const worldTick = commitClockTick(input);
  return completeTick(input, worldTick);
}

/**
 * 不推进 tick，只对当前 clock.world_tick 幂等重跑到期 job、时钟步骤与消费者。
 * 已提交的 job、每日结算与章节评估依赖各自 done 标记和状态守卫只生效一次。
 */
export function catchUpWorldTick(input: WorldTickContext): WorldTickResult {
  const worldTick = input.clock.read(input.branchId).worldTick;
  return completeTick(input, worldTick);
}
