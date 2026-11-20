/**
 * 创建有界 turn、维护 trigger 合并，并恢复重启或过期租约遗留的 turn。
 * 依赖 storage、HostServices、roster/profile 与调度端口。
 * 禁止为 human 控制身份创建 turn，或让过期 turn 永久占用 trigger。
 */
import type { AgentTrigger, HostServices, StoragePort } from "@ai-npc/contracts";
import type { SchedulingPort } from "@ai-npc/module-sdk";
import type { ResolvedAgentProfile, Roster } from "@ai-npc/experiment";
import { numberValue, stringValue, triggerFromRow } from "./runtime-records";

const terminalTurnStatuses = new Set(["completed", "failed", "cancelled", "budget-exhausted"]);

export interface TurnSchedulerInput {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly scheduling: SchedulingPort;
  readonly maxConcurrentTurns: number;
  readonly branchId: string;
}

export class TurnScheduler {
  constructor(private readonly input: TurnSchedulerInput) {}

  recoverInterrupted(): void {
    const interrupted = this.input.storage.transact((tx) =>
      tx.rows("turn_runs").list({ branch_id: this.input.branchId })
        .filter((row) => !terminalTurnStatuses.has(stringValue(row, "status"))),
    );
    this.cancel(interrupted, "runtime-restarted");
  }

  recoverExpired(): void {
    const now = this.input.host.nowIso();
    const expired = this.input.storage.transact((tx) =>
      tx.rows("turn_runs").list({ branch_id: this.input.branchId })
        .filter((row) =>
          !terminalTurnStatuses.has(stringValue(row, "status")) &&
          typeof row["lease_expires_at"] === "string" &&
          row["lease_expires_at"] <= now,
        ),
    );
    this.cancel(expired, "lease-expired");
    this.releaseOrphanedTriggers();
  }

  schedule(input: {
    readonly tick: number;
    readonly paused: boolean;
    readonly runId: string;
  }): void {
    const snapshot = this.snapshot();
    const running = snapshot.turns.filter((row) => !terminalTurnStatuses.has(stringValue(row, "status")));
    if (running.length >= this.input.maxConcurrentTurns) return;
    const agents = this.input.roster.agents.map((agent) => {
      const activation = snapshot.activations.find((row) => row["agent_id"] === agent.agentId);
      const lease = snapshot.leases.find((row) => row["agent_id"] === agent.agentId);
      return {
        agentId: agent.agentId,
        active: activation?.["status"] === "active",
        controllerKind: lease?.["controller_kind"] === "human" ? "human" as const : "agent" as const,
        strategic: agent.kind === "strategic",
      };
    });
    const triggers = snapshot.triggers.map(triggerFromRow);
    const lastTurnTickByAgent = this.lastTurnTicks(snapshot.turns);
    const plans = this.input.scheduling.plan({
      branchId: this.input.branchId,
      worldTick: input.tick,
      paused: input.paused,
      agents,
      triggers,
      runningTurnAgentIds: running.map((row) => stringValue(row, "agent_id")),
      lastTurnTickByAgent,
    }).slice(0, Math.max(0, this.input.maxConcurrentTurns - running.length));
    for (const plan of plans) {
      this.createTurn(plan, snapshot, input.tick, input.runId);
    }
  }

  private snapshot() {
    return this.input.storage.transact((tx) => {
      const branch = tx.branch(this.input.branchId);
      return {
        activations: branch.table("agent_activations").list(),
        leases: branch.table("controller_leases").list(),
        triggers: branch.table("triggers").list().filter((row) => row["consumed_by_turn_id"] === null),
        turns: tx.rows("turn_runs").list({ branch_id: this.input.branchId }),
      };
    });
  }

  private lastTurnTicks(rows: readonly Readonly<Record<string, unknown>>[]): Record<string, number> {
    const ticks: Record<string, number> = {};
    for (const row of rows) {
      const agentId = stringValue(row, "agent_id");
      ticks[agentId] = Math.max(ticks[agentId] ?? 0, numberValue(row, "created_tick"));
    }
    return ticks;
  }

  private createTurn(
    plan: { readonly agentId: string; readonly triggerIds: readonly string[] },
    snapshot: ReturnType<TurnScheduler["snapshot"]>,
    tick: number,
    runId: string,
  ): void {
    const lease = snapshot.leases.find((row) => row["agent_id"] === plan.agentId);
    if (lease === undefined || !this.input.profiles.has(plan.agentId)) return;
    const turnId = this.input.host.ids("turn");
    const index = snapshot.turns.filter((row) => row["agent_id"] === plan.agentId).length + 1;
    this.input.storage.transact((tx) => {
      tx.rows("turn_runs").put({
        turn_id: turnId,
        run_id: runId,
        branch_id: this.input.branchId,
        agent_id: plan.agentId,
        agent_turn_index: index,
        status: "queued",
        trigger_ids_json: [...plan.triggerIds],
        input_frontier_json: null,
        memory_revision: null,
        profile_hash: "pending",
        controller_epoch: numberValue(lease, "controller_epoch"),
        turn_lease_epoch: 0,
        lease_expires_at: null,
        terminal_reason: null,
        effective_json: [],
        created_at: this.input.host.nowIso(),
        created_tick: tick,
        started_at: null,
        ended_at: null,
      });
      const triggers = tx.branch(this.input.branchId).table("triggers");
      for (const triggerId of plan.triggerIds) {
        const row = triggers.get({ trigger_id: triggerId });
        if (row !== null) triggers.put({ ...row, consumed_by_turn_id: turnId });
      }
    });
  }

  private cancel(rows: readonly Readonly<Record<string, unknown>>[], reason: string): void {
    if (rows.length === 0) return;
    this.input.storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      const triggers = tx.branch(this.input.branchId).table("triggers");
      for (const row of rows) {
        const turnId = stringValue(row, "turn_id");
        const current = turns.get({ turn_id: turnId });
        if (current === null || terminalTurnStatuses.has(stringValue(current, "status"))) continue;
        turns.put({
          ...current,
          status: "cancelled",
          terminal_reason: reason,
          ended_at: this.input.host.nowIso(),
        });
        for (const triggerId of Array.isArray(current["trigger_ids_json"])
          ? current["trigger_ids_json"].filter((id): id is string => typeof id === "string")
          : []) {
          const trigger = triggers.get({ trigger_id: triggerId });
          if (trigger !== null) triggers.put({ ...trigger, consumed_by_turn_id: null });
        }
      }
    });
  }

  private releaseOrphanedTriggers(): void {
    this.input.storage.transact((tx) => {
      const triggers = tx.branch(this.input.branchId).table("triggers");
      for (const trigger of triggers.list()) {
        if (trigger["consumed_by_turn_id"] === null) continue;
        const turn = tx.rows("turn_runs").get({ turn_id: stringValue(trigger, "consumed_by_turn_id") });
        if (turn === null) triggers.put({ ...trigger, consumed_by_turn_id: null });
      }
    });
  }
}
