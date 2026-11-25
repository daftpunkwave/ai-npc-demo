/**
 * 创建有界 turn、维护 trigger 合并，并恢复重启或过期租约遗留的 turn。
 * 依赖 storage、HostServices、roster/profile 与调度端口。
 * 禁止为 human 控制身份创建 turn，或让过期 turn 永久占用 trigger。
 */
import type { HostServices, StoragePort } from "@ai-npc/contracts";
import type { SchedulingPort } from "@ai-npc/module-sdk";
import type { ResolvedAgentProfile, Roster } from "@ai-npc/experiment";
import { numberValue, stringValue, triggerFromRow } from "./runtime-records";
import { cancelTurn, activeTurnStatuses, terminalTurnStatuses } from "./turn-lease";

export interface TurnSchedulerInput {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly scheduling: SchedulingPort;
  readonly maxConcurrentTurns: number;
  readonly branchId: string;
  readonly patrolHour?: number;
}

export class TurnScheduler {
  constructor(private readonly input: TurnSchedulerInput) {}

  recoverInterrupted(): void {
    this.cancelActive("runtime-restarted");
  }

  cancelActive(reason: string): void {
    const statuses = activeTurnStatuses.map(() => "?").join(", ");
    const interrupted = this.input.storage.transact((tx) =>
      tx.all(
        `SELECT * FROM turn_runs WHERE branch_id = ? AND status IN (${statuses})`,
        [this.input.branchId, ...activeTurnStatuses],
      ),
    );
    this.cancel(interrupted, reason);
  }

  recoverExpired(): void {
    const now = this.input.host.nowIso();
    const statuses = activeTurnStatuses.map(() => "?").join(", ");
    const expired = this.input.storage.transact((tx) =>
      tx.all(
        `SELECT * FROM turn_runs
          WHERE branch_id = ? AND status IN (${statuses}) AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        [this.input.branchId, ...activeTurnStatuses, now],
      ),
    );
    this.cancel(expired, "lease-expired");
    this.releaseOrphanedTriggers();
  }

  queuedTurns(runId: string): readonly { readonly turnId: string; readonly agentId: string }[] {
    return this.input.storage.transact((tx) => tx.rows("turn_runs")
      .list({ branch_id: this.input.branchId, run_id: runId, status: "queued" })
      .map((row) => ({ turnId: stringValue(row, "turn_id"), agentId: stringValue(row, "agent_id") })));
  }

  schedule(input: {
    readonly tick: number;
    readonly paused: boolean;
    readonly runId: string;
  }): readonly { readonly turnId: string; readonly agentId: string }[] {
    if (this.input.patrolHour !== undefined && input.tick % 24 === this.input.patrolHour) {
      this.schedulePatrols(input.tick);
    }
    const snapshot = this.snapshot();
    if (snapshot.branchStatus !== "active" && snapshot.branchStatus !== "paused") return [];
    const running = snapshot.turns.filter((row) => !terminalTurnStatuses.has(stringValue(row, "status")));
    if (running.length >= this.input.maxConcurrentTurns) return [];
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
    const separateTurns = new Set<string>();
    const sandbox = snapshot.kind === "sandbox";
    // 每条玩家发言创建独立会话。分开调度让每个会话都能收到回复。
    const triggers = snapshot.triggers.map(triggerFromRow)
      .sort((left, right) => left.createdTick - right.createdTick)
      .filter(({ agentId, kind }) => {
        if (sandbox !== (kind === "probe")) return false;
        if (kind !== "player-dialogue" && kind !== "probe") return true;
        if (separateTurns.has(agentId)) return false;
        separateTurns.add(agentId);
        return true;
      });
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
    return plans.flatMap((plan) => {
      const turnId = this.createTurn(plan, snapshot, input.tick, input.runId);
      return turnId === null ? [] : [{ turnId, agentId: plan.agentId }];
    });
  }

  private snapshot() {
    return this.input.storage.transact((tx) => {
      const branch = tx.branch(this.input.branchId);
      const row = tx.rows("branches").get({ branch_id: this.input.branchId });
      return {
        kind: row?.["kind"],
        branchStatus: row?.["status"],
        activations: branch.table("agent_activations").list(),
        leases: branch.table("controller_leases").list(),
        // 相同 tick 的触发按持久化顺序合并，随机生成的 ID 不参与排序。
        triggers: tx.all("SELECT * FROM triggers WHERE branch_id = ? AND consumed_by_turn_id IS NULL ORDER BY rowid", [this.input.branchId]),
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
  ): string | null {
    const lease = snapshot.leases.find((row) => row["agent_id"] === plan.agentId);
    if (lease === undefined || !this.input.profiles.has(plan.agentId)) return null;
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
    return turnId;
  }

  private schedulePatrols(tick: number): void {
    this.input.storage.transact((tx) => {
      const branchId = this.input.branchId;
      const row = tx.rows("branches").get({ branch_id: branchId });
      if (row?.["kind"] === "sandbox" || row?.["status"] !== "active") return;
      const branch = tx.branch(branchId);
      const triggers = branch.table("triggers");
      for (const agent of this.input.roster.agents) {
        if (agent.kind !== "strategic" ||
          branch.table("agent_activations").get({ agent_id: agent.agentId })?.["status"] !== "active" ||
          branch.table("controller_leases").get({ agent_id: agent.agentId })?.["controller_kind"] !== "agent") continue;
        const key = `patrol:${agent.agentId}:${Math.floor(tick / 24)}`;
        if (triggers.list({ dedupe_key: key }, { limit: 1 }).length > 0) continue;
        triggers.put({
          trigger_id: this.input.host.ids("trg"), agent_id: agent.agentId, kind: "patrol", priority: 10,
          source_ref: key, created_tick: tick, dedupe_key: key, consumed_by_turn_id: null,
        });
      }
    });
  }

  private cancel(rows: readonly Readonly<Record<string, unknown>>[], reason: string): void {
    if (rows.length === 0) return;
    this.input.storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      for (const row of rows) {
        const turnId = stringValue(row, "turn_id");
        const current = turns.get({ turn_id: turnId });
        if (current === null || terminalTurnStatuses.has(stringValue(current, "status"))) continue;
        cancelTurn(tx, current, reason, this.input.host.nowIso());
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
