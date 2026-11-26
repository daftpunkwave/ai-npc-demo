/**
 * 随在线分支创建、释放并切换 Agent 运行时及 run 级调度与工具模块。
 * 使用已冻结配置、已启动的依赖端口和权威命令网关。
 * 分支切换后，旧实例及其租约不得继续提交世界动作或对白。
 */
import { AgentRuntime, type SpeechApprovalIndex } from "@ai-npc/agent-runtime";
import type { Authority } from "@ai-npc/authority";
import type { StartedInstances } from "@ai-npc/kernel";
import { startAgentRunModules, type AgentRunModules } from "./agent-run-modules";
import { agentWorldReaders } from "./agent-world-read";
import type { HostStartup } from "./startup";
import { disposeInReverse, settleWithin } from "./dispose";
import type { LiveRunState } from "./live-state";
import type { HostReadPorts } from "./reads";

interface OnlineAgentOptions {
  readonly core: HostStartup;
  readonly active: LiveRunState;
  readonly reads: HostReadPorts;
  readonly authority: Authority;
  readonly approvals: SpeechApprovalIndex;
  readonly onStateChange: () => void;
}

interface BranchAgents {
  readonly branchId: string;
  readonly runtime: AgentRuntime;
  readonly modules: StartedInstances;
}

export class OnlineAgentHost {
  private branch: BranchAgents | null = null;
  private changing: Promise<void> | null = null;
  private closing = false;
  private failed = false;
  private initialModules: AgentRunModules | null;

  constructor(private readonly options: OnlineAgentOptions) {
    this.initialModules = options.core.initialAgentModules;
  }

  /** 分支切换失败或当前分支的 Agent 运行时处于连续失败（degraded）时，健康摘要都报降级。 */
  get healthy(): boolean {
    return !this.failed && !(this.branch?.runtime.degraded ?? false);
  }

  /**
   * 记忆维护队列计数；未启动 Agent 运行时两者都为 0。
   * `queued` 与 `exhausted` 分开上报，健康摘要不把「不会再被推进」的行计入排队数。
   */
  get maintenanceQueue(): { readonly queued: number; readonly exhausted: number } {
    return this.branch?.runtime.maintenanceQueue ?? { queued: 0, exhausted: 0 };
  }

  switch(): Promise<void> {
    if (this.changing !== null) return this.changing;
    const changing = this.reconcile().finally(() => { this.changing = null; });
    this.changing = changing;
    return changing;
  }

  requestSwitch(): void {
    void this.switch().catch((error: unknown) => {
      this.failed = true;
      this.options.core.host.logger.error("Online Agent branch change failed", {
        branchId: this.options.active.branchId, message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  fenceTurns(reason: string): void {
    this.branch?.runtime.fenceTurns(reason);
  }

  /**
   * 世界可能已变化：让当前分支的 Agent 运行时立即重跑一轮，而不是等下一次空闲巡检。
   * tick 推进、玩家命令与 turn 完成都会走到这里；未启动分支时由调用方忽略。
   */
  notifyWorldChanged(): void {
    this.branch?.runtime.notifyWorldChanged();
  }

  /**
   * 停止新 turn 并等待当前分支的运行时排空；截止时间由关闭编排给出。
   * 分支切换本身也受同一预算约束：卡住的切换不能把关闭挡在排空之前，
   * 否则 `drainUntil` 永远不会被调用，关闭重新变成无界等待。
   */
  async drain(deadlineMs: number): Promise<void> {
    this.closing = true;
    const deadlineAt = Date.now() + Math.max(0, deadlineMs);
    if (this.changing !== null) {
      const settled = await settleWithin(async () => { await this.changing; }, Math.max(0, deadlineAt - Date.now()));
      if (settled === "timed-out") {
        this.options.core.host.logger.warn("Online Agent branch change timed out during shutdown", {
          branchId: this.options.active.branchId,
          deadlineMs: Math.max(0, deadlineMs),
        });
      }
    }
    const remaining = Math.max(0, deadlineAt - Date.now());
    await this.branch?.runtime.drainUntil(remaining);
  }

  /**
   * 释放已装配模块与当前分支的运行时。
   * 分支切换与运行时释放都受同一预算约束：关闭期间卡住的切换或卡住的 turn 都不能把进程留住。
   */
  async close(deadlineMs = 10_000): Promise<void> {
    this.closing = true;
    const deadlineAt = Date.now() + Math.max(0, deadlineMs);
    try {
      if (this.changing !== null) {
        await settleWithin(async () => { await this.changing; }, Math.max(0, deadlineAt - Date.now()));
      }
    } finally {
      await disposeInReverse([
        { label: "unused Agent modules", dispose: async () => { await this.initialModules?.started.dispose(); } },
        { label: "active Agent runtime", dispose: () => this.closeBranch(Math.max(0, deadlineAt - Date.now())) },
      ]);
    }
  }

  private async reconcile(): Promise<void> {
    if (this.options.core.active.agents === null) return;
    while (!this.closing && this.branch?.branchId !== this.options.active.branchId) {
      await this.closeBranch();
      if (this.closing) return;
      const { worldId, branchId } = this.options.active;
      this.branch = await this.openBranch({ worldId, branchId });
      this.failed = false;
    }
  }

  /** 释放一个分支的模块与运行时；`deadlineMs` 为 0 表示不做额外等待，直接按关闭语义收尾。 */
  private async closeBranch(deadlineMs?: number): Promise<void> {
    const branch = this.branch;
    this.branch = null;
    if (branch === null) return;
    await disposeInReverse([
      { label: "run Agent modules", dispose: () => branch.modules.dispose() },
      { label: "Agent runtime", dispose: () => branch.runtime.dispose(deadlineMs) },
    ]);
  }

  private async openBranch(scope: { readonly worldId: string; readonly branchId: string }): Promise<BranchAgents> {
    const { core, reads, authority, approvals, onStateChange } = this.options;
    const { host, storage, content, gameContent, activeStartup } = core;
    const agents = core.active.agents;
    if (agents === null) throw new Error("Agent run is not configured");
    const runId = storage.transact((tx) => tx.rows("branches").get({ branch_id: scope.branchId })?.["run_id"]);
    if (typeof runId !== "string") throw new Error("Agent branch has no run ID");
    const running = [...core.storageStarted.instances, ...core.startedModules.instances];
    const prepared = scope.branchId === core.active.branchId ? this.initialModules : null;
    if (prepared !== null) this.initialModules = null;
    const { started: modules, tools, scheduling, model, maxConcurrentTurns, patrolHour } = prepared ??
      await startAgentRunModules({ plan: activeStartup.plan, configuration: agents, content, host, scope, running });
    try {
      const read = agentWorldReaders({ storage, reads, content: gameContent, scope });
      const ports = Object.fromEntries([...running, ...modules.instances]
        .flatMap((instance) => (agents.modules.get(instance.moduleId)?.provides ?? [])
          .map(({ capability }) => [capability, instance.port])));
      const runtime = new AgentRuntime({
        ...scope, runId, storage, host, content,
        roster: agents.roster, profiles: agents.profiles, moduleDefinitions: agents.modules,
        scheduling, maxConcurrentTurns,
        ...(patrolHour === undefined ? {} : { patrolHour }),
        readWorlds: read.perception, onStateChange,
        turnExecution: {
          runSeed: core.active.runSpec.seed, profileHashes: agents.profileHashes, tools,
          approvals, readWorld: read.decision, ports, model,
          recordSpan: (span) => core.runtime.observability.recordSpan(span),
          executeCommand: (auth, envelope) => authority.commands.execute(auth, envelope),
        },
      });
      await runtime.start();
      return { branchId: scope.branchId, modules, runtime };
    } catch (error) {
      try {
        await modules.dispose();
      } catch (cleanupError) {
        host.logger.error("Agent run module cleanup failed", {
          branchId: scope.branchId, message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
  }
}
