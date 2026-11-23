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
import { TurnScheduler } from "./turn-scheduler";
import { TurnWorker, type TurnExecutionOptions } from "./turn-worker";

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
  readonly readWorld: (agentId: string) => AgentWorldRead;
  readonly onStateChange?: () => void;
  readonly turnExecution?: TurnExecutionOptions;
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
        readWorld: this.options.readWorld,
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
      void this.runTrackedCycle()
        .catch((error) => {
          this.options.host.logger.error("Agent runtime cycle failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => this.schedule());
    }, 250);
    this.timer.unref();
  }

  private runTrackedCycle(): Promise<void> {
    if (this.cycle !== null) return this.cycle;
    const cycle = this.runCycle().finally(() => {
      if (this.cycle === cycle) this.cycle = null;
    });
    this.cycle = cycle;
    return cycle;
  }

  private async runCycle(): Promise<void> {
    if (this.stopped || this.consumer === null || this.scheduler === null) return;
    const active = this.options.storage.transact((tx) => {
      const branch = tx.rows("branches").get({ branch_id: this.options.branchId });
      return branch?.["status"] === "active" || branch?.["status"] === "paused";
    });
    if (!active) return;
    const tick = this.clockTick();
    await this.consumer.consume(tick);
    this.consumer.flush(tick);
    await this.memory?.ingestAll(tick);
    this.memory?.proposeDueWakeups(tick);
    await this.memory?.runDueMaintenance(tick);
    if (this.stopped) return;
    this.scheduler.recoverExpired();
    const scheduled = this.scheduler.schedule({
      tick,
      paused: this.clockMode() === "paused",
      runId: this.options.runId,
    });
    if (this.turns !== null) {
      for (const { turnId, agentId } of this.scheduler.queuedTurns(this.options.runId)) {
        this.turns.dispatch(turnId, agentId);
      }
    }
    if (scheduled.length > 0) this.options.onStateChange?.();
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
