/**
 * 在线世界的固定 tick 执行顺序：写入时钟、到期 job、时钟步骤、事件消费者；stepping 模式按同一顺序逐 tick 推进并在达标或终局后收尾。
 * 依赖存储事务读取分支状态、authority 的 job/时钟/消费者执行器、时钟模块端口与宿主时间服务。
 * 每个阶段各自提交事务；时钟读写只经模块端口，禁止在这里解析或改写 clock 行。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名用于表达调用契约。 */
import { DomainError, type HostServices, type StoragePort } from "@world-prism/contracts";
import type { ClockState } from "@world-prism/module-sdk";

/** 一次 tick 需要的 authority 入口；结构类型让宿主与测试共用同一顺序。 */
export interface TickAuthority {
  readonly jobs: { runDue(branchId: string, tick: number): number };
  readonly clock: {
    run(branchId: string): number;
    /** 额外返回是否有步骤请求在本次 tick 收尾后停止时钟（章节终点）。 */
    runDetailed(branchId: string): { readonly executed: number; readonly stopRequested: boolean };
    /** 读取持久时钟停止点；有登记时禁止继续推进或恢复时钟。 */
    pendingStop(branchId: string): boolean;
  };
  readonly consumers: {
    run(branchId: string): { readonly processed: number; readonly scanned: number };
  };
}

/** tick 推进需要的时钟端口视图；读取、推进与终点暂停都由时钟 provider 完成。 */
export interface TickClockPort {
  read(branchId: string): ClockState;
  setTick(branchId: string, tick: number): ClockState;
  pause(branchId: string, expectedRunVersion?: number): { readonly ok: boolean };
}

/** 单步推进额外需要的时钟端口视图：收尾单步并回到 paused。 */
export type SteppingClockPort = TickClockPort & { finishStep(branchId: string): ClockState };

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
  const clockSteps = input.authority.clock.runDetailed(input.branchId);
  const consumers = input.authority.consumers.run(input.branchId);
  // 章节评估等步骤声明终点后，在所有阶段提交完成时暂停时钟，保留存档与资源交接数据；
  // 持久停止点让崩溃后重启的补完路径也能补做暂停。
  if (clockSteps.stopRequested || input.authority.clock.pendingStop(input.branchId)) {
    const paused = input.clock.pause(input.branchId);
    if (!paused.ok) {
      throw new DomainError("invalid-state", "章节终点暂停时钟失败", {
        details: { branchId: input.branchId, worldTick },
      });
    }
  }
  return {
    worldTick,
    executedJobs,
    executedClockSteps: clockSteps.executed,
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
  // 终局停止点已持久化时先补做暂停（幂等），再拒绝越过章节终点推进。
  if (input.authority.clock.pendingStop(input.branchId)) {
    const paused = input.clock.pause(input.branchId);
    if (!paused.ok) {
      throw new DomainError("invalid-state", "章节终点暂停时钟失败", {
        details: { branchId: input.branchId, targetTick: input.targetTick },
      });
    }
    throw new DomainError("invalid-state", "章节终点已登记，不能推进 tick", {
      details: { branchId: input.branchId, targetTick: input.targetTick },
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

/** 单步推进的输入：在共用运行环境上补充收尾端口与调用方刚读到的时钟快照。 */
export interface AdvanceSteppingInput extends WorldTickContext {
  readonly clock: SteppingClockPort;
  readonly current: ClockState;
}

/** 单步推进结果：finished 表示本步已收尾（完成、被章节终点截断或时钟已离开 stepping）。 */
export interface SteppingTickResult extends WorldTickResult {
  readonly finished: boolean;
}

/** 无实际阶段执行的空计数；收尾与截断路径只改时钟模式。 */
const idleTickCounts = { executedJobs: 0, executedClockSteps: 0, consumers: { processed: 0, scanned: 0 } } as const;

/**
 * 推进 stepping 模式一个 tick：到达目标或章节终点时收尾并回到 paused。
 * 任一阶段失败时错误向上传播，时钟停留在 stepping；暂停与恢复仍是有效退出路径。
 */
export function advanceSteppingTick(input: AdvanceSteppingInput): SteppingTickResult {
  // 章节终点已登记：补做幂等暂停，本步视为被终局截断，与运行中终局同语义。
  if (input.authority.clock.pendingStop(input.branchId)) {
    const paused = input.clock.pause(input.branchId);
    if (!paused.ok) {
      throw new DomainError("invalid-state", "章节终点暂停时钟失败", {
        details: { branchId: input.branchId, worldTick: input.current.worldTick },
      });
    }
    return { worldTick: input.current.worldTick, ...idleTickCounts, finished: true };
  }
  const target = input.current.stepTargetTick;
  // 目标缺失或已达成（如重启后补完现场）：只收尾单步，不重复推进。
  if (target === null || input.current.worldTick >= target) {
    return { worldTick: input.clock.finishStep(input.branchId).worldTick, ...idleTickCounts, finished: true };
  }
  const result = advanceWorldTick({ ...input, targetTick: input.current.worldTick + 1 });
  const after = input.clock.read(input.branchId);
  // 推进后仍在 stepping 且达标时收尾；被章节终点暂停时 mode 已离开 stepping，无需再收尾。
  if (after.mode === "stepping" && after.stepTargetTick !== null && after.worldTick >= after.stepTargetTick) {
    return { ...result, finished: true, worldTick: input.clock.finishStep(input.branchId).worldTick };
  }
  return { ...result, finished: after.mode !== "stepping" };
}
