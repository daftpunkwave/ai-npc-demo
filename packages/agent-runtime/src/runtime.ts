/**
 * 协调感知消费、延迟发布、租约恢复与 turn 创建。
 * 依赖存储、HostServices、内容包、Agent profile、感知模块与调度端口。
 * 轮询节奏由世界 tick 变化与宿主唤醒信号驱动；空闲轮退避到有上限的巡检间隔。
 * 禁止在事务内等待模型、执行世界命令或复制第二套 turn loop。
 */
import type { HostServices, ModuleDefinition, StoragePort } from "@ai-npc/contracts";
import type { PerceptionPort, SchedulingPort } from "@ai-npc/module-sdk";
import type { ContentPack, ResolvedAgentProfile, Roster } from "@ai-npc/experiment";
import { PerceptionEventConsumer } from "./event-consumer";
import { MemoryHost } from "./memory-host";
import { memoryIdentityForAgent } from "./memory-identity";
import { AgentModuleHandle } from "./agent-module-handle";
import { cycleBackoffMs, idleDelayMs } from "./runtime-backoff";
import { TurnScheduler } from "./turn-scheduler";
import { TurnWorker, type TurnExecutionOptions } from "./turn-worker";

/**
 * 收到世界变化信号后到下一轮的最短延迟。
 * 不取 0：命令与运营操作会成批提交，排到下一个事件循环 tick 可以把同一段时间内的
 * 多个信号合并成一轮，避免为每一条提交各跑一次完整流水线。
 */
const baseWakeDelayMs = 25;

/** 单个阶段失败的记录：阶段名加原因原文，供聚合错误与日志对账。 */
interface CycleStageFailure {
  readonly phase: string;
  readonly message: string;
}

export interface AgentWorldRead {
  readonly nodeId: string | null;
  readonly factionId: string;
  readonly worldViewText: string;
  readonly affairsText: string;
}

export interface AgentRuntimeOptions {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly content: ContentPack;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly moduleDefinitions: ReadonlyMap<string, ModuleDefinition>;
  readonly scheduling: SchedulingPort;
  readonly maxConcurrentTurns: number;
  readonly patrolHour?: number;
  readonly worldId: string;
  readonly branchId: string;
  readonly runId: string;
  readonly readWorlds: (agentIds: readonly string[]) => ReadonlyMap<string, AgentWorldRead>;
  readonly onStateChange?: () => void;
  readonly turnExecution?: TurnExecutionOptions;
}

/**
 * 阶段失败的聚合错误：message 保留每个阶段的原因原文，供调用方断言与排查；
 * 另带 phases 供日志记录受控字段——日志只写阶段名，不写可能含自由文本的原文。
 */
class CycleFailure extends Error {
  readonly phases: readonly string[];

  constructor(message: string, phases: readonly string[]) {
    super(message);
    this.name = "CycleFailure";
    this.phases = phases;
  }
}

/** 把本轮阶段失败聚合为一个错误；没有失败则返回 null，保留每个原因原文供断言与排查。 */
function cycleFailure(failures: readonly CycleStageFailure[]): Error | null {
  if (failures.length === 0) return null;
  return new CycleFailure(
    failures
      .map(({ phase, message }) => `agent runtime stage ${phase} failed: ${message}`)
      .join("; "),
    failures.map(({ phase }) => phase),
  );
}

/**
 * 在预算内等待一个异步操作，返回是否按时完成；超时后原操作仍在后台推进，其 rejection 已被兜住。
 * 关闭链路用它给「等待在途工作」一个可终止的边界，避免单个卡住的主体让进程无法退出。
 */
async function settleWithin(work: () => Promise<void>, deadlineMs: number): Promise<"done" | "timed-out"> {
  if (deadlineMs <= 0) {
    void work().catch(() => undefined);
    return "timed-out";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), deadlineMs);
    timer.unref();
  });
  const running = work().then(() => "done" as const, (error: unknown) => {
    throw error;
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 单进程感知、记忆和调度宿主。turn 执行与后台摄入并行运行。
 */
export class AgentRuntime {
  private readonly perception = new Map<string, AgentModuleHandle<PerceptionPort>>();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cycle: Promise<void> | null = null;
  private draining: Promise<void> | null = null;
  private running = false;
  private stopped = false;
  private consecutiveFailures = 0;
  /** 连续空闲轮数：世界 tick 没有变化也没有唤醒信号时按指数退避，避免固定高频轮询。 */
  private idleCycles = 0;
  /** 上一轮观察到的世界 tick；变化即代表世界已推进，需要重新摄入与调度。 */
  private lastObservedTick: number | null = null;
  private consumer: PerceptionEventConsumer | null = null;
  private memory: MemoryHost | null = null;
  private scheduler: TurnScheduler | null = null;
  private turns: TurnWorker | null = null;

  constructor(private readonly options: AgentRuntimeOptions) {}

  async start(): Promise<void> {
    try {
      for (const agent of this.options.roster.agents) {
        const selection = this.options.profiles.get(agent.agentId)?.slots.perception;
        if (selection === undefined) {
          throw new Error(`名册身份 ${agent.agentId} 缺少 perception profile`);
        }
        const definition = this.options.moduleDefinitions.get(selection.module);
        if (definition === undefined) {
          throw new Error(`感知模块 ${selection.module} 未登记`);
        }
        this.perception.set(agent.agentId, await AgentModuleHandle.create<PerceptionPort>({
          ...this.options,
          agentId: agent.agentId,
          moduleId: selection.module,
          config: selection.config,
          definition,
          signal: this.abort.signal,
          ...(this.options.turnExecution === undefined ? {} : { ports: this.options.turnExecution.ports }),
        }));
      }
      const memorySelections = this.options.roster.agents.map((agent) =>
        this.options.profiles.get(agent.agentId)?.slots.memory,
      );
      if (memorySelections.some((selection) => selection !== undefined) &&
          memorySelections.some((selection) => selection === undefined)) {
        throw new Error("Agent 名册的记忆 profile 配置不完整");
      }
      if (memorySelections.every((selection) => selection !== undefined)) {
        this.memory = new MemoryHost({
          storage: this.options.storage,
          host: this.options.host,
          roster: this.options.roster,
          profiles: this.options.profiles,
          moduleDefinitions: this.options.moduleDefinitions,
          identities: new Map(this.options.roster.agents.map((agent) => [
            agent.agentId,
            memoryIdentityForAgent(this.options.content, agent.agentId),
          ])),
          worldId: this.options.worldId,
          branchId: this.options.branchId,
          runId: this.options.runId,
          signal: this.abort.signal,
          ...(this.options.turnExecution === undefined ? {} : { ports: this.options.turnExecution.ports }),
          ...(this.options.turnExecution?.model == null ? {} : { model: this.options.turnExecution.model }),
        });
        await this.memory.start();
      }
      if (this.options.turnExecution !== undefined) {
        if (this.memory === null) throw new Error("Running turns requires a memory provider for every Agent");
        this.turns = new TurnWorker(this.options, this.options.turnExecution, this.memory, this.abort.signal);
        await this.turns.start();
      }
      this.consumer = new PerceptionEventConsumer({
        storage: this.options.storage,
        host: this.options.host,
        content: this.options.content,
        roster: this.options.roster,
        profiles: this.options.profiles,
        worldId: this.options.worldId,
        branchId: this.options.branchId,
        readWorlds: this.options.readWorlds,
      }, this.perception);
      this.scheduler = new TurnScheduler({
        storage: this.options.storage,
        host: this.options.host,
        roster: this.options.roster,
        profiles: this.options.profiles,
        scheduling: this.options.scheduling,
        maxConcurrentTurns: this.options.maxConcurrentTurns,
        branchId: this.options.branchId,
        ...(this.options.patrolHour === undefined ? {} : { patrolHour: this.options.patrolHour }),
      });
      this.scheduler.recoverInterrupted();
      this.running = true;
      // 首轮阶段故障只进入降级与退避，不让 startup 拆掉整个 runtime：
      // 单主体故障是可恢复的运行期状态，销毁运行时会连带停止其余身份的摄入与调度。
      try {
        await this.runTrackedCycle();
      } catch (error) {
        // 与 recordCycleFailure 同一口径：只记阶段名，不写错误原文。
        this.options.host.logger.error("Agent runtime first cycle failed", {
          phases: error instanceof CycleFailure ? [...error.phases] : [],
        });
      }
      this.schedule();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  /** 测试与受控单步使用同一轮询逻辑。 */
  async pump(): Promise<void> {
    await this.runTrackedCycle();
  }

  /** 连续失败后为 true；调度端口与健康摘要据此区分降级，不把失败当成正常轮。 */
  get degraded(): boolean {
    return this.consecutiveFailures > 0;
  }

  /**
   * 记忆维护队列计数：`queued` 为仍会推进的行，`exhausted` 为已达尝试上限、不会再被认领的行。
   * 未启动记忆宿主时两者都为 0，不编造数字。
   */
  get maintenanceQueue(): { readonly queued: number; readonly exhausted: number } {
    return this.memory?.maintenanceQueue() ?? { queued: 0, exhausted: 0 };
  }

  fenceTurns(reason: string): void {
    this.scheduler?.cancelActive(reason);
  }

  /**
   * 停止新任务并等待轮询边界。
   * 幂等：重复调用返回同一个 Promise，避免关闭路径重复推进或产生第二份状态。
   * 截止时间由调用方在 dispose 阶段施加，这里不自行截断，以免把「已停止」误报成「已排空」。
   */
  drain(): Promise<void> {
    if (this.draining !== null) return this.draining;
    this.stopped = true;
    this.running = false;
    this.abort.abort();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.draining = Promise.resolve(this.cycle).then(() => {
      if (this.turns !== null) this.scheduler?.cancelActive("runtime-stopped");
    });
    return this.draining;
  }

  /**
   * 在截止时间内完成排空；超时只记录，不阻塞调用方继续释放资源。
   *
   * 排空本身仍会继续在后台推进（重复关闭复用同一次结果），但调用方不会因此被挂住：
   * 关闭路径已经给了预算，超过预算就说明有主体卡住了，此时继续等待只会让进程无法退出。
   */
  async drainUntil(deadlineMs: number): Promise<void> {
    const outcome = await settleWithin(async () => { await this.drain(); }, deadlineMs);
    if (outcome === "timed-out") {
      // 只记预算，不写可能含观察正文的错误消息。
      this.options.host.logger.warn("Agent runtime drain timed out", { deadlineMs: Math.max(0, deadlineMs) });
    }
  }

  /**
   * 释放在途 turn、模块与记忆宿主。
   * 排空受同一预算约束：超时后不再等待 `this.draining`，直接进入逐项释放，
   * 否则一个永不结束的轮询周期会让释放阶段也停在原处。
   */
  async dispose(deadlineMs?: number): Promise<void> {
    let firstError: unknown;
    try {
      if (deadlineMs === undefined) {
        await this.drain();
      } else {
        await this.drainUntil(deadlineMs);
      }
    } catch (error) {
      firstError = error;
    }
    if (this.turns !== null) {
      try {
        await this.turns.dispose(deadlineMs);
      } catch (error) {
        firstError ??= error;
      }
      this.turns = null;
    }
    for (const handle of [...this.perception.values()].reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.perception.clear();
    if (this.memory !== null) {
      try {
        await this.memory.dispose();
      } catch (error) {
        firstError ??= error;
      }
      this.memory = null;
    }
    if (firstError !== undefined) throw firstError;
  }

  private schedule(): void {
    if (!this.running || this.stopped) return;
    // 唤醒信号可能在一轮进行中多次到达：先清掉待触发的计时器，保证同一时刻只有一个调度在等。
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      // 失败已经由 recordCycleFailure 按轮数分级记录，这里只需吞掉 rejection 以免变成未处理异常。
      void this.runTrackedCycle()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, this.nextDelayMs());
    this.timer.unref();
  }

  /**
   * 下一轮延迟：失败退避优先；空闲轮按指数退避到巡检上限，只有世界 tick 变化或收到唤醒信号才提前重跑。
   * 世界每 tick 20 秒推进一次，固定 250 毫秒轮询会把「世界没变化」放大成约 80 倍的空转事务。
   */
  private nextDelayMs(): number {
    if (this.consecutiveFailures > 0) return cycleBackoffMs(this.consecutiveFailures);
    return idleDelayMs(this.idleCycles + 1);
  }

  /**
   * 收到「世界可能已变化」的信号：重置空闲计数，并把下一轮提前到最短延迟。
   *
   * 信号只缩短等待，不直接同步起跑：命令提交是一批批到达的，逐条立即重跑会让同一
   * 段世界变化被反复完整扫描；把重跑挂在同一个计时器上，一轮正在进行时到达的多个
   * 信号合并成一次后续轮次，既保留「变化后立即处理」的时延，也不产生并发轮次。
   * 停止后忽略信号。
   */
  notifyWorldChanged(): void {
    this.idleCycles = 0;
    if (!this.running || this.stopped) return;
    if (this.cycle !== null) {
      // 本轮结束后由 runTrackedCycle 的收尾统一排下一轮，届时延迟已按重置后的计数计算。
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      void this.runTrackedCycle()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, baseWakeDelayMs);
    this.timer.unref();
  }

  private runTrackedCycle(): Promise<void> {
    if (this.cycle !== null) return this.cycle;
    const cycle = this.runCycle()
      .then(() => this.recordCycleSuccess())
      .catch((error: unknown) => {
        // 只把阶段名交给日志；聚合错误里的原因原文可能含观察正文或对话原文。
        this.recordCycleFailure(error instanceof CycleFailure ? error.phases : []);
        throw error;
      })
      .finally(() => {
        if (this.cycle === cycle) this.cycle = null;
      });
    this.cycle = cycle;
    return cycle;
  }

  /** 成功轮清零连续失败计数；从 degraded 恢复时显式记录一次，便于对账。 */
  private recordCycleSuccess(): void {
    if (this.consecutiveFailures === 0) return;
    this.consecutiveFailures = 0;
    this.options.host.logger.info("Agent runtime recovered", { consecutiveFailures: 0 });
  }

  /**
   * 本轮是否只是空转：世界 tick 未变化且没有新的调度产出。
   * 空转轮只推进退避计数，不改变失败计数，也不产生额外日志。
   */
  private recordIdle(worldTick: number, scheduled: number): void {
    const advanced = this.lastObservedTick !== null && worldTick !== this.lastObservedTick;
    this.lastObservedTick = worldTick;
    if (advanced || scheduled > 0) {
      this.idleCycles = 0;
      return;
    }
    this.idleCycles += 1;
  }

  /**
   * 进入 degraded 的第一轮用 error 级，持续失败降为 warn 级，避免退避期间刷屏。
   * 只记录受控字段（连续失败次数、下次退避、失败的阶段名），不记录错误原文：
   * 阶段错误的原文可能含观察正文或对话原文，属于不受信任自由文本。
   */
  private recordCycleFailure(phases: readonly string[]): void {
    this.consecutiveFailures += 1;
    const data = {
      consecutiveFailures: this.consecutiveFailures,
      nextDelayMs: cycleBackoffMs(this.consecutiveFailures),
      phases: [...phases],
    };
    if (this.consecutiveFailures === 1) this.options.host.logger.error("Agent runtime degraded", data);
    else this.options.host.logger.warn("Agent runtime cycle failed", data);
  }

  private async runCycle(): Promise<void> {
    if (this.stopped || this.consumer === null || this.scheduler === null) return;
    const consumer = this.consumer;
    const scheduler = this.scheduler;
    const active = this.options.storage.transact((tx) => {
      const branch = tx.rows("branches").get({ branch_id: this.options.branchId });
      return branch?.["status"] === "active" || branch?.["status"] === "paused";
    });
    if (!active) return;
    const tick = this.clockTick();
    // 每个阶段独立失败：单个阶段抛错只记录，后续阶段照常执行，尤其是 turn 调度不能因此被跳过。
    const failures: CycleStageFailure[] = [];
    const stage = async (phase: string, operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push({ phase, message: error instanceof Error ? error.message : String(error) });
      }
    };
    await stage("consumer.consume", () => consumer.consume(tick));
    await stage("consumer.flush", () => { consumer.flush(tick); });
    await stage("memory.ingestAll", async () => { await this.memory?.ingestAll(tick); });
    await stage("memory.proposeDueWakeups", () => { this.memory?.proposeDueWakeups(tick); });
    await stage("memory.runDueMaintenance", async () => { await this.memory?.runDueMaintenance(tick); });
    if (this.stopped) {
      const failure = cycleFailure(failures);
      if (failure !== null) throw failure;
      return;
    }
    await stage("scheduler.recoverExpired", () => { scheduler.recoverExpired(); });
    let scheduled: readonly { readonly turnId: string; readonly agentId: string }[] = [];
    await stage("scheduler.schedule", () => {
      scheduled = scheduler.schedule({
        tick,
        paused: this.clockMode() === "paused",
        runId: this.options.runId,
      });
    });
    if (this.turns !== null) {
      await stage("turns.dispatch", () => {
        for (const { turnId, agentId } of scheduler.queuedTurns(this.options.runId)) {
          this.turns?.dispatch(turnId, agentId);
        }
      });
    }
    this.recordIdle(tick, scheduled.length);
    if (scheduled.length > 0) this.options.onStateChange?.();
    const failure = cycleFailure(failures);
    if (failure !== null) throw failure;
  }


  private clockTick(): number {
    return this.options.storage.transact((tx) => {
      const row = tx.branch(this.options.branchId).table("clock").get({});
      if (row === null || typeof row["world_tick"] !== "number") throw new Error("Agent runtime 缺少时钟");
      return row["world_tick"];
    });
  }

  private clockMode(): string {
    return this.options.storage.transact((tx) => {
      const row = tx.branch(this.options.branchId).table("clock").get({});
      if (row === null || typeof row["mode"] !== "string") throw new Error("Agent runtime 缺少时钟");
      return row["mode"];
    });
  }
}
