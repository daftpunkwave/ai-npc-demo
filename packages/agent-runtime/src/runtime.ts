/**
 * 协调感知消费、延迟发布、租约恢复与 turn 创建。
 * 依赖存储、HostServices、内容包、Agent profile、感知模块与调度端口。
 * 禁止在事务内等待模型、执行世界命令或复制第二套 turn loop。
 */
import type { HostServices, ModuleDefinition, StoragePort } from "@ai-npc/contracts";
import type { PerceptionPort, SchedulingPort } from "@ai-npc/module-sdk";
import type { ContentPack, ResolvedAgentProfile, Roster } from "@ai-npc/experiment";
import { PerceptionEventConsumer } from "./event-consumer";
import { MemoryHost } from "./memory-host";
import { memoryIdentityForAgent } from "./memory-identity";
import { AgentModuleHandle } from "./agent-module-handle";
import { cycleBackoffMs } from "./runtime-backoff";
import { TurnScheduler } from "./turn-scheduler";
import { TurnWorker, type TurnExecutionOptions } from "./turn-worker";

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

/** 把本轮阶段失败聚合为一个错误；没有失败则返回 null，保留每个原因原文供断言与排查。 */
function cycleFailure(failures: readonly CycleStageFailure[]): Error | null {
  if (failures.length === 0) return null;
  return new Error(failures
    .map(({ phase, message }) => `agent runtime stage ${phase} failed: ${message}`)
    .join("; "));
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
      await this.runTrackedCycle();
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

  fenceTurns(reason: string): void {
    this.scheduler?.cancelActive(reason);
  }

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

  async dispose(): Promise<void> {
    let firstError: unknown;
    try {
      await this.drain();
    } catch (error) {
      firstError = error;
    }
    if (this.turns !== null) {
      try {
        await this.turns.dispose();
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
    this.timer = setTimeout(() => {
      // 失败已经由 recordCycleFailure 按轮数分级记录，这里只需吞掉 rejection 以免变成未处理异常。
      void this.runTrackedCycle()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, cycleBackoffMs(this.consecutiveFailures));
    this.timer.unref();
  }

  private runTrackedCycle(): Promise<void> {
    if (this.cycle !== null) return this.cycle;
    const cycle = this.runCycle()
      .then(() => this.recordCycleSuccess())
      .catch((error: unknown) => {
        this.recordCycleFailure(error instanceof Error ? error.message : String(error));
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

  /** 进入 degraded 的第一轮用 error 级，持续失败降为 warn 级，避免退避期间刷屏。 */
  private recordCycleFailure(message: string): void {
    this.consecutiveFailures += 1;
    const data = {
      consecutiveFailures: this.consecutiveFailures,
      nextDelayMs: cycleBackoffMs(this.consecutiveFailures),
      message,
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
