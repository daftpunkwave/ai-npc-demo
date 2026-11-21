/**
 * 把冻结的观察、记忆与自身状态转换为确定性的决策和对白意图。
 * 使用注入的随机源与工具网关，按触发顺序执行提案并保留受理结果。
 * 不使用模型、不拼写对白正文、不读取世界实时状态。
 */
import {
  agreementProposedPayloadSchema,
  dialogueSubmittedPayloadSchema,
  probeAskedPayloadSchema,
  taskInvitationIssuedPayloadSchema,
  taskTypeSchema,
  type AgentTrigger,
  type DecisionSubmission,
  type DialogueIntent,
  type Json,
  type RelationSummary,
  type TaskType,
  type ToolExecutionResult,
} from "@ai-npc/contracts";
import { createStatelessModule, type DeterministicDecisionInput, type AgentDecisionPort } from "@ai-npc/module-sdk";
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { termsWithinDelegations } from "./term-capacity";

const noIntent: DialogueIntent = {
  kind: "none", audience: [], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [],
};

type Stance = DecisionSubmission["stance"];
interface TriggerDecision {
  readonly stance: Stance;
  readonly intent: DialogueIntent;
  readonly citedMemoryIds: readonly DecisionSubmission["citedMemoryIds"][number][];
  readonly tool?: { readonly id: string; readonly arguments: Json };
}

function refusalReason(relation: RelationSummary | undefined): DialogueIntent["reasonCode"] {
  if (relation?.causes.includes("breach")) return "past-breach";
  return (relation?.trust ?? 0) <= -3 ? "low-trust" : "need-guarantee";
}

function taskType(text: string, input: DeterministicDecisionInput): TaskType | null {
  const match = input.lexicons.taskKeywords.find(({ word }) => text.includes(word));
  if (match === undefined) return null;
  if (match.taskType !== "generic") return match.taskType;
  const firstSkill = taskTypeSchema.safeParse(input.self.skills[0]);
  return firstSkill.success ? firstSkill.data : null;
}

function response(
  requesterId: string,
  kind: DialogueIntent["kind"],
  stance: Stance = "none",
  reasonCode: DialogueIntent["reasonCode"] = "none",
  subjectRef: string | null = null,
  citedMemoryIds: TriggerDecision["citedMemoryIds"] = [],
): TriggerDecision {
  return {
    stance,
    intent: { ...noIntent, kind, audience: [requesterId], reasonCode, subjectRef },
    citedMemoryIds,
  };
}

function willingness(
  input: DeterministicDecisionInput,
  relation: RelationSummary | undefined,
  jitter: number,
  task: TaskType | null,
  highRiskRoute = false,
): number {
  const trust = Math.min(8, Math.max(-8, relation?.trust ?? 0));
  const skill = task !== null && input.self.skills.includes(task) ? 1 : 0;
  return 1 + skill + trust / 4 - (input.self.injured ? 2 : 0) - (highRiskRoute ? 1 : 0) + jitter;
}

function decideTrigger(input: DeterministicDecisionInput, trigger: AgentTrigger, jitter: number): TriggerDecision | null {
  const observation = input.observations.find((item) =>
    item.sourceEventIds.some((eventId) => eventId === trigger.sourceRef),
  );
  const content = observation?.content;
  const facts = content !== null && typeof content === "object" && !Array.isArray(content) ? content["facts"] : null;
  const relationOf = (requesterId: string): RelationSummary | undefined =>
    input.memory.relationSummary.find((relation) => relation.targetId === requesterId);

  switch (trigger.kind) {
    case "player-dialogue": {
      const dialogue = dialogueSubmittedPayloadSchema.safeParse(facts);
      if (!dialogue.success) return null;
      const { speakerId, text } = dialogue.data;
      const task = taskType(text, input);
      if (task !== null) {
        const relation = relationOf(speakerId);
        const accept = willingness(input, relation, jitter, task) >= 1.5;
        return response(speakerId, accept ? "agree" : "refuse", accept ? "accept" : "decline",
          accept ? "none" : refusalReason(relation), null, relation?.reasonMemoryIds ?? []);
      }
      return input.lexicons.questionMarkers.some((marker) => text.includes(marker))
        ? answer(speakerId, input)
        : response(speakerId, "acknowledge");
    }
    case "probe": {
      const probe = probeAskedPayloadSchema.safeParse(facts);
      return probe.success ? answer(probe.data.askedBy, input) : null;
    }
    case "task-invite": {
      const invitation = taskInvitationIssuedPayloadSchema.safeParse(facts);
      if (!invitation.success || invitation.data.inviteeId !== input.session.agentId) return null;
      const task = input.taskInvitations.find((item) => item.taskId === invitation.data.taskId);
      if (task === undefined) return null;
      const relation = relationOf(task.dispatcherId);
      const accept = willingness(input, relation, jitter, invitation.data.taskType, task.highRiskRoute) >= 1.5;
      const reason = accept ? "none" : refusalReason(relation);
      return {
        ...response(task.dispatcherId, accept ? "agree" : "refuse", accept ? "accept" : "decline",
          reason, task.taskId, relation?.reasonMemoryIds ?? []),
        tool: { id: "task.respond", arguments: { taskId: task.taskId, response: accept ? "accept" : "decline", reasonCode: reason } },
      };
    }
    case "agreement-proposal": {
      const proposal = agreementProposedPayloadSchema.safeParse(facts);
      if (!proposal.success || proposal.data.proposerId === input.session.agentId ||
        !proposal.data.parties.includes(input.session.agentId)) return null;
      const { agreementId, proposerId, terms } = proposal.data;
      const relation = relationOf(proposerId);
      const obligations = terms.filter((term) => term.obligorId === input.session.agentId);
      const covered = termsWithinDelegations(obligations, input);
      const accept = obligations.length === 0
        ? (relation?.trust ?? 0) > -8
        : covered && willingness(input, relation, jitter, null) >= 1;
      const reason = accept ? "none" : covered ? refusalReason(relation) : "lack-resources";
      return {
        ...response(proposerId, accept ? "none" : "refuse", accept ? "accept" : "decline",
          reason, agreementId, relation?.reasonMemoryIds ?? []),
        tool: { id: "agreement.respond", arguments: { agreementId, response: accept ? "accept" : "reject", counterTerms: null } },
      };
    }
    case "prospective": {
      const promise = input.prospective.find((item) => item.memoryId === trigger.sourceRef);
      if (promise === undefined) return null;
      const mine = promise.obligorId === input.session.agentId;
      if (!mine && promise.dueTick !== input.frontier.worldTick) return null;
      const relation = relationOf(promise.counterpartId);
      const warn = !mine && (relation?.trust ?? 0) < 0;
      const selected = response(promise.counterpartId, warn ? "warn" : "remind",
        "inform", "none", promise.subjectRef, [...(relation?.reasonMemoryIds ?? [])]);
      const { audience, ...intent } = { ...selected.intent, factRefs: [promise.memoryId] };
      return { ...selected, intent: { ...intent, audience }, tool: { id: "message.send", arguments: { to: audience, intent } } };
    }
    default:
      return null;
  }
}

function answer(requesterId: string, input: DeterministicDecisionInput): TriggerDecision {
  const factRefs = input.memory.items.slice(0, 2).map(({ memoryId }) => memoryId);
  const selected = response(requesterId, "answer", "inform", "none", null, factRefs);
  return { ...selected, intent: { ...selected.intent, factRefs } };
}

export function createDeterministicDecisionModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: AgentDecisionPort<DeterministicDecisionInput> = {
    async decide(turn) {
      const rng = input.host.rng(turn.runSeed, "jitter", turn.session.agentId,
        String(turn.frontier.worldTick), String(turn.agentTurnIndex));
      const jitter = rng() * 0.5 - 0.25;
      let selected: TriggerDecision = { stance: "none", intent: noIntent, citedMemoryIds: [] };
      let priority = -1;
      const toolResults: ToolExecutionResult[] = [];
      const retrieved = new Set(turn.memory.items.map(({ memoryId }) => memoryId));
      const cited = new Set<DecisionSubmission["citedMemoryIds"][number]>();
      for (const trigger of turn.triggers) {
        const candidate = decideTrigger(turn, trigger, jitter);
        if (candidate === null) continue;
        for (const id of candidate.citedMemoryIds) {
          if (retrieved.has(id)) cited.add(id);
        }
        let choice = candidate;
        if (candidate.tool !== undefined) {
          const { result } = await turn.executeTool({
            toolId: candidate.tool.id, arguments: candidate.tool.arguments, providerCallId: trigger.triggerId,
            attemptId: turn.attemptId, round: 1,
          });
          toolResults.push(result);
          const requester = candidate.intent.audience[0];
          if (result.commandStatus !== "accepted" && requester !== undefined) {
            choice = {
              ...choice,
              stance: "defer",
              intent: response(requester, "refuse", "defer", "busy", candidate.intent.subjectRef).intent,
            };
          }
        }
        if (trigger.priority >= priority) {
          selected = choice;
          priority = trigger.priority;
        }
      }
      const citedMemoryIds = [...cited].slice(0, 8);
      return {
        status: "ok",
        reason: null,
        decision: {
          stance: selected.stance,
          dialogueIntent: selected.intent,
          noteworthy: [],
          citedMemoryIds,
          decisionNote: citedMemoryIds.join(" ").slice(0, 120),
        },
        stages: [],
        contextArtifacts: [],
        toolResults,
        messages: [],
      };
    },
  };
  return createStatelessModule(input, port);
}
