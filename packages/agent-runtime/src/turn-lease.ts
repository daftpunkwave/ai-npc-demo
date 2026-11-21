/**
 * 认领 turn 并在每次短状态转移时校验分支、控制代次、时钟版本和租约。
 * 使用 Agent 运行记录和注入的时钟。状态更新与触发释放在同一事务提交。
 * 租约检查不得代替世界命令自己的权威 fencing。
 */
import type {
  AgentTrigger, AgentTurnStatus, AuthContext, HostServices, StoragePort, StorageRow, StorageTransaction,
} from "@ai-npc/contracts";
import { arrayValue, numberValue, stringValue, triggerFromRow } from "./runtime-records";

export const terminalTurnStatuses: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "budget-exhausted"]);

export class TurnStopped extends Error {
  constructor(
    readonly status: "cancelled" | "failed" | "budget-exhausted",
    readonly reason: string,
  ) {
    super(reason);
  }
}

export interface ClaimedTurn {
  readonly auth: AuthContext & { readonly turnId: string; readonly turnLeaseEpoch: number };
  readonly runId: string;
  readonly agentTurnIndex: number;
  readonly profileHash: string;
  readonly triggers: readonly AgentTrigger[];
  readonly clockVersion: number;
  readonly worldTick: number;
  readonly observationSeq: number;
  readonly probe: boolean;
  readonly pauseExempt: boolean;
  readonly deadlineMs: number;
}

export function cancelTurn(tx: StorageTransaction, row: StorageRow, reason: string, endedAt: string): void {
  if (row["started_at"] !== null) {
    const committed = tx.all(
      `SELECT 1 FROM speech_commits AS s
        JOIN artifacts AS a ON a.artifact_id = s.approved_speech_artifact_ref
        WHERE s.branch_id = ? AND s.principal_id = ? AND a.run_id = ? AND a.kind = 'speech'
          AND json_extract(CAST(a.body AS TEXT), '$.turnId') = ?
          AND json_extract(CAST(a.body AS TEXT), '$.validation.publication') = 'turn-reply'
        LIMIT 1`,
      [stringValue(row, "branch_id"), stringValue(row, "agent_id"), stringValue(row, "run_id"), stringValue(row, "turn_id")],
    );
    if (committed.length > 0) {
      // 已提交的回复不可撤回，保留对应触发的消费状态，避免重启重复回话。
      tx.rows("turn_runs").put({ ...row, status: "failed", terminal_reason: "interrupted-after-speech", ended_at: endedAt, lease_expires_at: null });
      return;
    }
  }
  tx.rows("turn_runs").put({ ...row, status: "cancelled", terminal_reason: reason, ended_at: endedAt, lease_expires_at: null });
  const branch = tx.branch(stringValue(row, "branch_id"));
  const triggers = branch.table("triggers");
  for (const id of arrayValue(row["trigger_ids_json"])) {
    if (typeof id !== "string") continue;
    const trigger = triggers.get({ trigger_id: id });
    if (trigger?.["consumed_by_turn_id"] === row["turn_id"]) {
      triggers.put({ ...trigger, consumed_by_turn_id: null });
    }
  }
}

function branchAndControllerReason(
  tx: StorageTransaction,
  branchId: string,
  agentId: string,
  controllerEpoch: number,
  nowIso: string,
): string | null {
  const state = tx.rows("branches").get({ branch_id: branchId });
  if (state?.["status"] !== "active" && state?.["status"] !== "paused") return "branch-inactive";
  const branch = tx.branch(branchId);
  if (branch.table("agent_activations").get({ agent_id: agentId })?.["status"] !== "active") return "agent-inactive";
  const controller = branch.table("controller_leases").get({ agent_id: agentId });
  if (controller?.["controller_kind"] !== "agent" || controller["controller_epoch"] !== controllerEpoch) {
    return "stale-controller";
  }
  const expires = controller["lease_expires_at"];
  if (expires !== null && (typeof expires !== "string" || !(Date.parse(expires) > Date.parse(nowIso)))) {
    return "stale-controller";
  }
  return null;
}

export class TurnLeases {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
    private readonly signal: AbortSignal,
  ) {}

  claim(turnId: string, scope: {
    readonly worldId: string;
    readonly branchId: string;
    readonly runId: string;
    readonly profileHash: string;
    readonly maxTurnMs: number;
  }): ClaimedTurn | null {
    return this.storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      const row = turns.get({ turn_id: turnId });
      if (row?.["status"] !== "queued" || row["branch_id"] !== scope.branchId || row["run_id"] !== scope.runId) return null;
      const branch = tx.branch(scope.branchId);
      const agentId = stringValue(row, "agent_id");
      const controllerEpoch = numberValue(row, "controller_epoch");
      const nowIso = this.host.nowIso();
      const deadlineMs = this.host.monotonicMs() + scope.maxTurnMs;
      const clock = branch.table("clock").get({});
      if (clock === null) throw new Error("Agent turn has no clock");
      const triggers = arrayValue(row["trigger_ids_json"]).map((id) => {
        if (typeof id !== "string") throw new Error("Invalid turn trigger ID");
        const trigger = branch.table("triggers").get({ trigger_id: id });
        if (trigger?.["consumed_by_turn_id"] !== turnId || trigger["agent_id"] !== agentId) {
          throw new Error("Turn trigger is not bound to its Agent and lease");
        }
        return triggerFromRow(trigger);
      });
      const probe = triggers.some((trigger) => trigger.kind === "probe");
      const pauseExempt = triggers.every((trigger) => trigger.kind === "probe" || trigger.kind === "debug");
      const blocked = branchAndControllerReason(tx, scope.branchId, agentId, controllerEpoch, nowIso)
        ?? (clock["mode"] === "paused" && !pauseExempt ? "paused" : null);
      if (blocked !== null || this.signal.aborted) {
        cancelTurn(tx, row, blocked ?? "runtime-stopped", nowIso);
        return null;
      }
      const turnLeaseEpoch = numberValue(row, "turn_lease_epoch") + 1;
      turns.put({
        ...row,
        status: "preparing",
        profile_hash: scope.profileHash,
        turn_lease_epoch: turnLeaseEpoch,
        lease_expires_at: new Date(Date.parse(nowIso) + scope.maxTurnMs).toISOString(),
        started_at: nowIso,
      });
      return {
        auth: {
          worldId: scope.worldId, branchId: scope.branchId, principalId: agentId, kind: "agent", roles: [],
          actingAsAgentId: null, controllerEpoch, turnId: turnId as AuthContext["turnId"] & string, turnLeaseEpoch,
        },
        runId: scope.runId,
        agentTurnIndex: numberValue(row, "agent_turn_index"),
        profileHash: scope.profileHash,
        triggers,
        clockVersion: numberValue(clock, "run_version"),
        worldTick: numberValue(clock, "world_tick"),
        observationSeq: Number(branch.table("observations").max("observation_seq", { agent_id: agentId }) ?? 0),
        probe, pauseExempt, deadlineMs,
      };
    });
  }

  require(tx: StorageTransaction, turn: ClaimedTurn, expected: AgentTurnStatus): StorageRow {
    const { auth, clockVersion } = turn;
    const nowIso = this.host.nowIso();
    const row = tx.rows("turn_runs").get({ turn_id: auth.turnId });
    if (row?.["status"] !== expected || row["turn_lease_epoch"] !== auth.turnLeaseEpoch ||
      row["profile_hash"] !== turn.profileHash) {
      throw new TurnStopped("cancelled", "stale-turn");
    }
    if (this.signal.aborted) throw new TurnStopped("cancelled", "runtime-stopped");
    const reason = branchAndControllerReason(tx, auth.branchId, auth.principalId, auth.controllerEpoch as number, nowIso);
    if (reason !== null) throw new TurnStopped("cancelled", reason);
    const clock = tx.branch(auth.branchId).table("clock").get({});
    if (clock?.["run_version"] !== clockVersion || (clock["mode"] === "paused" && !turn.pauseExempt)) {
      throw new TurnStopped("cancelled", "clock-changed");
    }
    if (this.host.monotonicMs() >= turn.deadlineMs || !(Date.parse(stringValue(row, "lease_expires_at")) > Date.parse(nowIso))) {
      throw new TurnStopped("budget-exhausted", "turn-deadline");
    }
    return row;
  }

  move(turn: ClaimedTurn, expected: AgentTurnStatus, status: AgentTurnStatus): void {
    this.storage.transact((tx) => {
      const row = this.require(tx, turn, expected);
      tx.rows("turn_runs").put({ ...row, status });
    });
  }

  finish(turn: ClaimedTurn, status: "completed" | TurnStopped["status"], reason: string | null): void {
    this.storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      const row = status === "completed" ? this.require(tx, turn, "settling") : turns.get({ turn_id: turn.auth.turnId });
      if (row === null || row["turn_lease_epoch"] !== turn.auth.turnLeaseEpoch ||
        terminalTurnStatuses.has(stringValue(row, "status"))) return;
      const now = this.host.nowIso();
      if (status === "cancelled") {
        cancelTurn(tx, row, reason ?? "cancelled", now);
        return;
      }
      turns.put({ ...row, status, terminal_reason: reason, ended_at: now, lease_expires_at: null });
    });
  }
}
