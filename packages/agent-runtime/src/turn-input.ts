/**
 * 等待感知与记忆到达可读边界，原子封存 turn 的 frontier、观察和授权世界视图。
 * 就绪判定使用递增的观察水位、不可变记忆 revision 和到期整理记录。
 * 等待按指数退避轮询，不持事务等待后台 worker，也不以更晚的实时视图补齐已封存的输入。
 */
import {
  dialogueSubmittedPayloadSchema,
  inputFrontierSchema,
  taskInvitationIssuedPayloadSchema,
  type AgentObservation,
  type HostServices,
  type InputFrontier,
  type MemoryScope,
  type StoragePort,
  type StorageTransaction,
} from "@ai-npc/contracts";
import type { ResolvedAgentProfile } from "@ai-npc/experiment";
import type { DeterministicDecisionInput, DelegationView } from "@ai-npc/module-sdk";
import { parseWatermark } from "./memory-row-codec";
import { asRecord, numberValue } from "./runtime-records";
import { TurnStopped, type ClaimedTurn, type TurnLeases } from "./turn-lease";
import { readTurnObservations } from "./turn-observations";

export interface TurnWorldRead {
  readonly nodeId: string | null;
  readonly injured: boolean;
  readonly delegations: readonly DelegationView[];
  readonly taskInvitations: DeterministicDecisionInput["taskInvitations"];
  readonly principalFactions: ReadonlyMap<string, string>;
  readonly knowledge: ReadonlyMap<string, ReadonlySet<string>>;
}

export type ReadTurnWorld = (
  tx: StorageTransaction,
  scope: MemoryScope,
  frontier: InputFrontier,
  invitedTaskIds: readonly string[],
) => TurnWorldRead;

export interface FrozenTurnInput {
  readonly scope: MemoryScope;
  readonly frontier: InputFrontier;
  readonly observations: readonly AgentObservation[];
  readonly triggerObservations: readonly AgentObservation[];
  readonly world: TurnWorldRead;
  readonly degraded: string | null;
}

type Readiness = { readonly kind: "ready" } | {
  readonly kind: "waiting" | "failed";
  readonly reason: string;
};

function readinessIn(
  tx: StorageTransaction,
  turn: ClaimedTurn,
  settings: ResolvedAgentProfile["readiness"],
): Readiness {
  const { branchId, principalId } = turn.auth;
  const branch = tx.branch(branchId);
  const stored = branch.table("memory_watermarks").get({ agent_id: principalId });
  if (stored === null) return { kind: "failed", reason: "missing-memory-watermark" };
  const scan = branch.table("perception_state").get({ agent_id: principalId });
  if (Number(scan?.["scanned_through_seq"] ?? 0) < Number(branch.table("domain_events").max("world_seq") ?? 0)) {
    return { kind: "waiting", reason: "perception-watermark" };
  }
  const watermark = parseWatermark(stored);
  if (settings.requireDurable && watermark.observationSeqConsumed < turn.observationSeq) {
    return { kind: "waiting", reason: "durable-watermark" };
  }
  if (!settings.requireDerived) return { kind: "ready" };
  const due = tx.all(
    `SELECT MAX(due_tick) AS latest_due,
            MAX(CASE WHEN status IN ('queued', 'leased') THEN 1 ELSE 0 END) AS pending
       FROM maintenance_runs WHERE run_id = ? AND agent_id = ? AND due_tick <= ?`,
    [turn.runId, principalId, turn.worldTick],
  )[0];
  if (due?.["pending"] === 1) return { kind: "waiting", reason: "derived-maintenance" };
  if (typeof due?.["latest_due"] === "number" && due["latest_due"] > watermark.derivedThroughTick) {
    return { kind: "failed", reason: "maintenance-failed" };
  }
  return { kind: "ready" };
}

function previousObservationSeq(tx: StorageTransaction, turn: ClaimedTurn): number {
  const rows = tx.all(
    `SELECT input_frontier_json FROM turn_runs
      WHERE branch_id = ? AND agent_id = ? AND agent_turn_index < ?
        AND status IN ('completed', 'failed', 'budget-exhausted') AND input_frontier_json IS NOT NULL
      ORDER BY agent_turn_index DESC LIMIT 1`,
    [turn.auth.branchId, turn.auth.principalId, turn.agentTurnIndex],
  );
  const previous = rows[0]?.["input_frontier_json"];
  return typeof previous === "string" ? inputFrontierSchema.parse(JSON.parse(previous)).observationSeq : 0;
}

function freezeIn(
  tx: StorageTransaction,
  turn: ClaimedTurn,
  readWorld: ReadTurnWorld,
  degraded: string | null,
): FrozenTurnInput {
  const { worldId, branchId, principalId: agentId } = turn.auth;
  const scope = { worldId, branchId, agentId };
  const branch = tx.branch(branchId);
  const memory = branch.table("memory_watermarks").get({ agent_id: agentId });
  const clock = branch.table("clock").get({});
  if (memory === null || clock === null) throw new TurnStopped("failed", "not-ready");
  const watermark = parseWatermark(memory);
  const perception = branch.table("perception_state").get({ agent_id: agentId });
  const worldSeq = perception === null ? 0 : numberValue(perception, "scanned_through_seq");
  const sourceRefs = new Set(turn.triggers.map((trigger) => trigger.sourceRef));
  const previous = previousObservationSeq(tx, turn);
  const observations = readTurnObservations(tx, {
    branchId,
    agentId,
    scope,
    previousSeq: previous,
    throughSeq: watermark.observationSeqConsumed,
    sourceRefs: [...sourceRefs],
  });
  const triggerObservations = observations.filter((observation) =>
    observation.sourceEventIds.some((id) => sourceRefs.has(id)));
  const latestDialogue = triggerObservations.findLast((observation) =>
    asRecord(observation.content)["eventType"] === "DialogueSubmitted");
  const dialogue = dialogueSubmittedPayloadSchema.safeParse(asRecord(latestDialogue?.content)["facts"]);
  const grants = tx.all(
    `SELECT MAX(world_seq) AS revision FROM domain_events
      WHERE branch_id = ? AND world_seq <= ? AND type = 'KnowledgeGranted'
        AND json_extract(payload_json, '$.principalId') = ?`,
    [branchId, worldSeq, agentId],
  );
  const frontier = inputFrontierSchema.parse({
    worldSeq,
    worldTick: numberValue(clock, "world_tick"),
    observationSeq: watermark.observationSeqConsumed,
    perceptionRevision: perception === null ? 0 : numberValue(perception, "revision"),
    memoryRevision: watermark.revision,
    conversationCursor: dialogue.success ? dialogue.data.dialogueId : null,
    knowledgeGrantRevision: Number(grants[0]?.["revision"] ?? 0),
  });
  const invitedTaskIds = triggerObservations.flatMap((observation) => {
    if (asRecord(observation.content)["eventType"] !== "TaskInvitationIssued") return [];
    const parsed = taskInvitationIssuedPayloadSchema.safeParse(asRecord(observation.content)["facts"]);
    return parsed.success && parsed.data.inviteeId === agentId ? [parsed.data.taskId] : [];
  });
  return { scope, frontier, observations, triggerObservations, world: readWorld(tx, scope, frontier, invitedTaskIds), degraded };
}

/** 就绪轮询的首次间隔：短等待仍按秒级以下粒度响应，不拖慢同 tick 内的水位推进。 */
const waitDelayBaseMs = 25;

/**
 * 就绪轮询的间隔上限：就绪条件由 tick 推进或事件消费满足，粒度远大于 50 毫秒，
 * 因此等待期按指数退避把轮询次数降到个位数即可，不必保持高频空转。
 */
const waitDelayCeilingMs = 200;

/** 第 n 次等待的间隔：25、50、100、200，之后钳制在 200 毫秒。 */
function waitDelayMs(pollIndex: number): number {
  return Math.min(waitDelayCeilingMs, waitDelayBaseMs * 2 ** Math.max(0, pollIndex));
}

export async function freezeTurnInput(input: {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly leases: TurnLeases;
  readonly turn: ClaimedTurn;
  readonly profile: ResolvedAgentProfile;
  readonly readWorld: ReadTurnWorld;
  readonly signal: AbortSignal;
}): Promise<FrozenTurnInput> {
  const { storage, host, leases, turn, profile, signal } = input;
  const started = host.monotonicMs();
  const timeout = profile.failurePolicy === "online-fallback"
    ? Math.min(profile.readiness.onlineDegradeAfterMs, profile.readiness.waitTimeoutMs)
    : profile.readiness.waitTimeoutMs;
  const expires = Math.min(turn.deadlineMs, started + timeout);
  let waiting = false;
  let polls = 0;
  while (true) {
    const result = storage.transact((tx) => {
      const row = leases.require(tx, turn, waiting ? "waiting" : "preparing");
      const readiness = readinessIn(tx, turn, profile.readiness);
      const expired = host.monotonicMs() >= expires;
      if (readiness.kind === "waiting" && !expired) {
        // 只有首次进入等待才写一次状态；等待期间的轮询不再重复写同一行。
        if (!waiting) tx.rows("turn_runs").put({ ...row, status: "waiting" });
        return null;
      }
      if (readiness.kind !== "ready" && (profile.failurePolicy === "strict" || readiness.reason === "perception-watermark")) {
        throw new TurnStopped("failed", "not-ready");
      }
      const snapshot = freezeIn(tx, turn, input.readWorld, readiness.kind === "ready" ? null : readiness.reason);
      tx.rows("turn_runs").put({
        ...row,
        status: "preparing",
        input_frontier_json: snapshot.frontier,
        memory_revision: snapshot.frontier.memoryRevision,
      });
      return snapshot;
    });
    if (result !== null) return result;
    waiting = true;
    try {
      await host.sleep(Math.max(1, Math.min(waitDelayMs(polls), expires - host.monotonicMs())), signal);
    } catch (error) {
      if (signal.aborted) throw new TurnStopped("cancelled", "runtime-stopped");
      throw error;
    }
    polls += 1;
  }
}
