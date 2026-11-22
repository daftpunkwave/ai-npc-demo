/**
 * 从冻结触发与记忆构造检索查询、校验决定引用，并组装独立的对白素材。
 * 只接受 Agent 本轮已授权观察与记忆，披露由安全对白流程再次判定。
 * 禁止把决策理由、私有会话全文或全量世界事实带入对白。
 */
import {
  decisionSubmissionSchema, dialogueSubmittedPayloadSchema, probeAskedPayloadSchema,
  type AgentMemoryQuery, type DecisionSubmission, type DialogueIntent, type Json,
  type MemoryBundle, type ToolExecutionResult,
} from "@ai-npc/contracts";
import type { ContentPack, ResolvedAgentProfile } from "@ai-npc/experiment";
import type { DeterministicDecisionInput, MemoryRecordView } from "@ai-npc/module-sdk";
import type { SpeechApprovalInput } from "./dialogue-flow";
import { isDisclosable, type SpeechFact } from "./disclosure";
import { asRecord } from "./runtime-records";
import type { FrozenTurnInput } from "./turn-input";
import type { ClaimedTurn } from "./turn-lease";

function strings(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

export function prospectiveInputs(
  agentId: string,
  records: readonly MemoryRecordView[],
): DeterministicDecisionInput["prospective"] {
  return records.flatMap((record) => {
    const data = asRecord(record.content.data);
    const { obligorId, dueTick } = data;
    if (data["state"] !== "open" || typeof obligorId !== "string" || typeof dueTick !== "number") return [];
    const counterpartId = obligorId === agentId
      ? record.content.counterpartIds.find((id) => id !== agentId && !id.startsWith("system:"))
      : obligorId;
    if (counterpartId === undefined) return [];
    const subject = data["agreementId"] ?? data["taskId"];
    return [{ memoryId: record.memoryId, obligorId, counterpartId, dueTick, subjectRef: typeof subject === "string" ? subject : null }];
  });
}

function participants(frozen: FrozenTurnInput, prospective: DeterministicDecisionInput["prospective"]): Set<string> {
  const ids = new Set(prospective.map((promise) => promise.counterpartId));
  for (const observation of frozen.triggerObservations) {
    const content = asRecord(observation.content);
    const facts = asRecord(content["facts"]);
    for (const id of [
      ...strings(content["subjectIds"]), ...strings(facts["parties"]),
      facts["speakerId"], facts["fromId"], facts["proposerId"], facts["askedBy"],
    ]) {
      if (typeof id === "string" && id !== frozen.scope.agentId &&
        (!id.startsWith("system:") || id === facts["askedBy"])) ids.add(id);
    }
  }
  for (const task of frozen.world.taskInvitations) ids.add(task.dispatcherId);
  return ids;
}

export function turnMemoryQuery(
  frozen: FrozenTurnInput,
  prospective: DeterministicDecisionInput["prospective"],
  content: ContentPack,
  profile: ResolvedAgentProfile,
): AgentMemoryQuery {
  const summaries = frozen.triggerObservations.map((observation) => asRecord(observation.content)["summaryZh"])
    .filter((summary): summary is string => typeof summary === "string");
  const queryText = summaries.join("\n");
  const tags = new Set<string>();
  for (const observation of frozen.triggerObservations) {
    const data = asRecord(observation.content);
    const eventType = data["eventType"];
    for (const tag of strings(data["tags"])) tags.add(tag);
    if (typeof eventType === "string" && eventType.startsWith("Agreement")) tags.add("agreement");
    const taskType = asRecord(data["facts"])["taskType"];
    if (typeof taskType === "string") tags.add(taskType);
  }
  for (const entry of content.locale.lexicons.memoryQueryTags) {
    if (queryText.includes(entry.word)) for (const tag of entry.tags) tags.add(tag);
  }
  const context = asRecord(profile.slots.context?.config);
  const decisionBudget = asRecord(asRecord(context["decision"])["segmentBudgets"])["memory"];
  return {
    scope: frozen.scope, revision: frozen.frontier.memoryRevision, frontier: frozen.frontier,
    counterpartIds: [...participants(frozen, prospective)], nodeId: frozen.world.nodeId,
    queryTags: [...tags], queryText, purpose: "decision", audience: [],
    maxItems: 8, maxTokens: typeof decisionBudget === "number" ? decisionBudget : 1000,
  };
}

export function checkedDecision(
  value: unknown,
  frozen: FrozenTurnInput,
  memory: MemoryBundle,
  prospective: DeterministicDecisionInput["prospective"],
  receipts: readonly ToolExecutionResult[],
  allowedAudience?: ReadonlySet<string>,
): DecisionSubmission | null {
  const parsed = decisionSubmissionSchema.safeParse(value);
  if (!parsed.success) return null;
  const decision = parsed.data;
  const intent = decision.dialogueIntent;
  const allowed = allowedAudience ?? participants(frozen, prospective);
  if (intent.kind !== "none" && (intent.audience.length === 0 ||
    intent.audience.some((id) => !allowed.has(id)))) return null;
  const memoryIds = new Set<string>(memory.items.map((item) => item.memoryId));
  const observationIds = new Set<string>(frozen.observations.map((item) => item.observationId));
  const knownSubjects = new Set(frozen.observations.flatMap((item) =>
    Object.values(asRecord(asRecord(item.content)["refs"])).filter((ref): ref is string => typeof ref === "string")));
  for (const promise of prospective) if (promise.subjectRef !== null) knownSubjects.add(promise.subjectRef);
  for (const ref of frozen.world.knowledge.get(frozen.scope.agentId) ?? []) {
    if (ref.startsWith("ev-")) knownSubjects.add(ref);
  }
  const resultRefs = new Set(receipts.flatMap((result) => [result.resultRef, result.receiptId]));
  if (intent.subjectRef !== null && !knownSubjects.has(intent.subjectRef)) return null;
  if (intent.factRefs.some((id) => !memoryIds.has(id) && !observationIds.has(id) && !knownSubjects.has(id) && !resultRefs.has(id))) return null;
  if (decision.citedMemoryIds.some((id) => !memoryIds.has(id)) ||
    decision.noteworthy.some((item) => item.sourceRefs.some((id) => !observationIds.has(id)))) return null;
  return decision;
}

export function speechInput(input: {
  readonly frozen: FrozenTurnInput;
  readonly turn: ClaimedTurn;
  readonly content: ContentPack;
  readonly profile: ResolvedAgentProfile;
  readonly memory: MemoryBundle;
  readonly prospective: DeterministicDecisionInput["prospective"];
  readonly intent: DialogueIntent;
  readonly channel?: SpeechApprovalInput["channel"];
}): SpeechApprovalInput {
  const { content, frozen, memory, prospective, intent, turn, profile } = input;
  const facts = new Map<string, SpeechFact>();
  for (const item of memory.items) facts.set(item.memoryId, { ref: item.memoryId, ...item });
  for (const { memoryId, subjectRef } of prospective) {
    const promise = facts.get(memoryId);
    if (subjectRef !== null && promise !== undefined && !facts.has(subjectRef)) {
      facts.set(subjectRef, { ...promise, ref: subjectRef });
    }
  }
  for (const observation of frozen.observations) {
    const data = asRecord(observation.content);
    if (typeof data["summaryZh"] !== "string") continue;
    const material = { releasePolicyId: observation.releasePolicyId, summaryZh: data["summaryZh"] };
    facts.set(observation.observationId, { ref: observation.observationId, ...material });
    for (const ref of Object.values(asRecord(data["refs"]))) {
      if (typeof ref === "string" && !facts.has(ref)) facts.set(ref, { ref, ...material });
    }
  }
  const { agentId } = frozen.scope;
  for (const id of frozen.world.knowledge.get(agentId) ?? []) {
    const item = content.index.evidence.get(id);
    if (item !== undefined) facts.set(id, { ref: id, releasePolicyId: `holders:${id}`, summaryZh: item.content });
  }
  const character = content.index.characters.get(agentId);
  const faction = content.index.factions.get(agentId);
  const latestDialogue = frozen.triggerObservations.findLast((observation) => {
    const facts = asRecord(asRecord(observation.content)["facts"]);
    return intent.audience.length === 1 && intent.audience[0] === facts["speakerId"] &&
      asRecord(observation.content)["eventType"] === "DialogueSubmitted";
  });
  const dialogue = dialogueSubmittedPayloadSchema.safeParse(asRecord(latestDialogue?.content)["facts"]);
  const names = new Map<string, string>([
    ...[...content.index.factions].map(([id, faction]) => [id, faction.leaderName ?? faction.name] as const),
    ...[...content.index.characters].map(([id, character]) => [id, character.name] as const),
    [content.index.playerPrincipalId, content.locale.playerName],
  ]);
  const history = input.channel !== undefined || !dialogue.success ? [] : frozen.observations.flatMap((observation) => {
    const payload = dialogueSubmittedPayloadSchema.safeParse(asRecord(observation.content)["facts"]);
    if (!payload.success || payload.data.conversationId !== dialogue.data.conversationId ||
      !isDisclosable(observation.releasePolicyId, {
        audience: intent.audience, principalFactions: frozen.world.principalFactions, heldEvidenceIds: frozen.world.knowledge,
      }) || !intent.audience.every((id) => id === payload.data.speakerId ||
        payload.data.deliveries.some(({ principalId, deliverAtTick }) => principalId === id && deliverAtTick <= frozen.frontier.worldTick))) return [];
    return [{ dialogueId: payload.data.dialogueId, speakerName: names.get(payload.data.speakerId) ?? payload.data.speakerId, text: payload.data.text }];
  }).slice(-6);
  return {
    session: frozen.scope, runId: turn.runId, turnId: turn.auth.turnId, agentId, auth: turn.auth,
    intent,
    facts: [...facts.values()],
    history,
    receipts: [],
    secrets: [...content.index.secrets.values()].map((secret) => ({ secretId: secret.secretId, leakTerms: secret.leakTerms })),
    principalFactions: frozen.world.principalFactions,
    heldEvidenceIds: frozen.world.knowledge,
    heldSecretIds: frozen.world.knowledge,
    principalNames: names,
    speechStyle: character?.speechStyle ?? faction?.persona.speechStyle ?? "",
    maxChars: profile.speech.maxChars,
    subjectLine: intent.subjectRef === null ? "" : facts.get(intent.subjectRef)?.summaryZh ?? "",
    channel: input.channel ?? (dialogue.success ? "dialogue" : "message"),
    conversationId: input.channel === undefined && dialogue.success ? dialogue.data.conversationId : null,
    replyToId: input.channel === undefined && dialogue.success ? dialogue.data.dialogueId : null,
  };
}

export function probeQuestion(frozen: FrozenTurnInput): {
  readonly probeId: string; readonly askedAtTick: number;
} | null {
  const observation = frozen.triggerObservations.find((item) => asRecord(item.content)["eventType"] === "ProbeAsked");
  const parsed = probeAskedPayloadSchema.safeParse(asRecord(observation?.content)["facts"]);
  return parsed.success && observation !== undefined
    ? { probeId: parsed.data.probeId, askedAtTick: observation.occurredAtTick }
    : null;
}
