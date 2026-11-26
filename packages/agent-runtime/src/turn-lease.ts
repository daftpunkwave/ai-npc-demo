/**
 * 认领 turn 并在每次短状态转移时校验分支、控制代次、时钟版本和租约。
 * 使用 Agent 运行记录和注入的时钟。状态更新与触发释放在同一事务提交。
 * 租约检查不得代替世界命令自己的权威 fencing。
 */
import type {
  AgentTrigger, AgentTurnStatus, AuthContext, HostServices, StoragePort, StorageRow, StorageTransaction,
} from "@ai-npc/contracts";
import { arrayValue, numberValue, stringValue, triggerFromRow } from "./runtime-records";

/**
 * turn 的终态集合：到达这些状态后不再推进，也不再占用并发名额。
 * 与 SQL 中 turn_runs_active 部分索引的非终态列表互补，二者必须一起改。
 */
export const terminalTurnStatuses: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "budget-exhausted"]);

/**
 * 非终态集合，与 turn_runs_active 部分索引的过滤条件逐字一致。
 * 只作为状态词的唯一来源；拼进 SQL 时必须内联成字面量而不是绑定参数，
 * 因为 SQLite 只有看到字面量才肯为部分索引判定谓词成立，绑定参数会退回全量索引。
 */
export const activeTurnStatuses: readonly string[] = [
  "queued",
  "preparing",
  "waiting",
  "deciding",
  "executing",
  "speaking",
  "settling",
];

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
    const branchId = stringValue(row, "branch_id");
    const agentId = stringValue(row, "agent_id");
    const runId = stringValue(row, "run_id");
    const turnId = stringValue(row, "turn_id");
    const reply = tx.get(
      `SELECT 1 FROM speech_commits AS s
        JOIN artifacts AS a ON a.artifact_id = s.approved_speech_artifact_ref
        WHERE s.branch_id = ? AND s.principal_id = ? AND a.run_id = ? AND a.kind = 'speech'
          AND json_extract(CAST(a.body AS TEXT), '$.turnId') = ?
          AND json_extract(CAST(a.body AS TEXT), '$.validation.publication') = 'turn-reply'
        LIMIT 1`,
      [branchId, agentId, runId, turnId],
    );
    const acceptedTool = reply === null ? tx.get(
      `SELECT 1 FROM tool_calls AS t
       JOIN command_receipts AS c ON c.branch_id = ? AND c.principal_id = t.agent_id AND c.command_id = t.command_id
       WHERE t.run_id = ? AND t.turn_id = ? AND t.agent_id = ?
         AND json_extract(c.receipt_json, '$.commandStatus') = 'accepted'
       LIMIT 1`,
      [branchId, runId, turnId, agentId],
    ) : null;
    if (reply !== null || acceptedTool !== null) {
      // 已提交的动作和回复留在世界中，保留触发的消费位置以避免再次下令。
      tx.rows("turn_runs").put({
        ...row, status: "failed", terminal_reason: reply === null ? "interrupted-after-command" : "interrupted-after-speech",
        ended_at: endedAt, lease_expires_at: null,
      });
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

/**
 * 认领前的不可恢复输入失败：时钟行缺失、触发引用损坏、租约代次非法等。
 * 与 TurnStopped 区分：后者是已获知 turn 状态后的业务终止，这里连 turn 行都还没有可用租约。
 */
export class TurnClaimRejected extends Error {
  constructor(readonly reason: string, cause: unknown) {
    super(reason, { cause });
    this.name = "TurnClaimRejected";
  }
}

/**
 * 把无法继续认领的 turn 落成终态并释放它占用的 trigger 与并发名额。
 * 认领过程自身抛错时 turn 行仍是 `queued`、租约字段为空，恢复机制只处理已过期租约，
 * 因此这里必须显式收尾，否则该行不会被任何路径再次推进。
 * 这类失败属于不可恢复的输入损坏，因此落 `failed` 而不是可重试的 `cancelled`。
 */
export function failClaim(
  storage: StoragePort,
  turnId: string,
  reason: string,
  endedAt: string,
): boolean {
  return storage.transact((tx) => {
    const turns = tx.rows("turn_runs");
    const row = turns.get({ turn_id: turnId });
    if (row === null || terminalTurnStatuses.has(String(row["status"]))) return false;
    // 已过 ready 检查的 turn 可能带着已完成的部分副作用，保留其消费位置避免重复下令。
    if (row["started_at"] !== null) {
      cancelTurn(tx, row, reason, endedAt);
      return true;
    }
    turns.put({
      ...row,
      status: "failed",
      terminal_reason: reason,
      lease_expires_at: null,
      ended_at: endedAt,
    });
    const triggers = tx.branch(stringValue(row, "branch_id")).table("triggers");
    for (const id of arrayValue(row["trigger_ids_json"])) {
      if (typeof id !== "string") continue;
      const trigger = triggers.get({ trigger_id: id });
      if (trigger?.["consumed_by_turn_id"] === row["turn_id"]) {
        triggers.put({ ...trigger, consumed_by_turn_id: null });
      }
    }
    return true;
  });
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
