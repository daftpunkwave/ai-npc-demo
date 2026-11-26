/**
 * 按渠道表把宿主筛出的合法候选转换为观察与 trigger。
 * 依赖配置、宿主 ID 和已渲染的授权内容；不读取世界全量状态。
 * 禁止为非受众生成观察，或用空内容推进感知水位。
 */
import type {
  AgentObservation,
  Json,
  ModuleCreateInput,
  ModuleInstance,
} from "@world-prism/contracts";
import {
  createStatelessModule,
  type NewAgentTrigger,
  type PerceptionPort,
  type PerceptionRequest,
  type PerceptionResult,
} from "@world-prism/module-sdk";
import { perceptionConfigSchema, type PerceptionConfig } from "./definition";

interface ChannelDecision {
  readonly channel: string;
  readonly epistemic: "witnessed" | "reported" | "inferred";
  readonly confidence: number;
  readonly detail: "full" | "summary";
  readonly delayKey: "broadcast" | "directed" | "briefing" | null;
}

const officialPublicTypes = new Set([
  "MetersChanged",
  "PolicyChanged",
  "PassageGranted",
  "DayPassed",
  "RelayDegraded",
  "RelayDown",
  "RelayRestored",
  "OrchardCrisis",
  "OrchardDamaged",
  "MigrationCrisis",
  "SupplyShortage",
  "GroupRescued",
  "GroupWorsened",
  "CharacterMoved",
  "TeamMoved",
  "CampaignStarted",
  "MotionDecided",
  "ChapterStageEvaluated",
]);

function record(value: Json): Readonly<Record<string, Json>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, Json>>)
    : {};
}

function audienceKinds(event: PerceptionRequest["event"]): readonly string[] {
  return event.audience.map((entry) => {
    const value = record(entry);
    return typeof value["kind"] === "string" ? value["kind"] : "";
  });
}

function deliveryFor(event: PerceptionRequest["event"], agentId: string): number | null {
  const deliveries = record(event.payload)["deliveries"];
  if (!Array.isArray(deliveries)) {
    return null;
  }
  for (const item of deliveries) {
    const value = record(item);
    if (value["principalId"] === agentId && typeof value["deliverAtTick"] === "number") {
      return value["deliverAtTick"];
    }
  }
  return null;
}

/**
 * 观察者当时所在的节点集合。`selfNodeIds` 覆盖「自己」可站立的全部位置
 * （例如队伍在途时的来源与目标节点）；`nodeId` 是主位置。
 */
function observerNodes(observer: PerceptionRequest["observer"]): ReadonlySet<string> {
  const nodes = new Set<string>(observer.selfNodeIds);
  if (observer.nodeId !== null) {
    nodes.add(observer.nodeId);
  }
  return nodes;
}

/**
 * 判断 node 受众事件是否发生在观察者当时所在的节点上。
 * 返回命中的节点 ID；不在同一节点时返回 null，感知渠道表第 10 行据此不成立。
 */
function onSiteNodeOf(
  event: PerceptionRequest["event"],
  observer: PerceptionRequest["observer"],
): string | null {
  const nodes = observerNodes(observer);
  for (const entry of event.audience) {
    const value = record(entry);
    if (value["kind"] !== "node" || typeof value["nodeId"] !== "string") {
      continue;
    }
    if (nodes.has(value["nodeId"])) {
      return value["nodeId"];
    }
  }
  return null;
}

function isSelfSubject(event: PerceptionRequest["event"], agentId: string): boolean {
  const payload = record(event.payload);
  return (
    payload["agentId"] === agentId ||
    payload["speakerId"] === agentId ||
    payload["fromId"] === agentId ||
    payload["dispatcherId"] === agentId ||
    payload["obligorId"] === agentId ||
    (Array.isArray(payload["agentIds"]) && payload["agentIds"].includes(agentId))
  );
}

function channelFor(input: PerceptionRequest): ChannelDecision | null {
  const { event, observer, scope } = input;
  const payload = record(event.payload);
  const audience = audienceKinds(event);
  const delivery = deliveryFor(event, scope.agentId);
  if (event.type === "DialogueSubmitted" && payload["speakerId"] !== scope.agentId) {
    if (delivery !== null) {
      return payload["channel"] === "face-to-face"
        ? { channel: "face-to-face", epistemic: "witnessed", confidence: 0.6, detail: "full", delayKey: null }
        : { channel: "relay", epistemic: "reported", confidence: 0.6, detail: "full", delayKey: "directed" };
    }
    return null;
  }
  if (event.type === "InformationShared" && payload["fromId"] !== scope.agentId && delivery !== null) {
    return { channel: "evidence", epistemic: "reported", confidence: 0.9, detail: "full", delayKey: "directed" };
  }
  if (event.type === "ProbeAsked" && payload["agentId"] === scope.agentId) {
    return { channel: "probe", epistemic: "reported", confidence: 0.6, detail: "full", delayKey: null };
  }
  if (event.type === "MessageSent" && payload["fromId"] !== scope.agentId && delivery !== null) {
    if (payload["channel"] === "broadcast") {
      return { channel: "broadcast", epistemic: "reported", confidence: 0.7, detail: "full", delayKey: "broadcast" };
    }
    return { channel: "relay", epistemic: "reported", confidence: 0.6, detail: "full", delayKey: "directed" };
  }
  if (event.type === "RumorSpread") {
    return { channel: "rumor", epistemic: "reported", confidence: 0.3, detail: "full", delayKey: "broadcast" };
  }
  if (officialPublicTypes.has(event.type) && audience.includes("public")) {
    return { channel: "public-notice", epistemic: "witnessed", confidence: 1, detail: "full", delayKey: "broadcast" };
  }
  if (isSelfSubject(event, scope.agentId)) {
    return { channel: "self", epistemic: "witnessed", confidence: 1, detail: "full", delayKey: null };
  }
  if (audience.includes("principals")) {
    return { channel: "party", epistemic: "witnessed", confidence: 1, detail: "full", delayKey: null };
  }
  if (audience.includes("node") && onSiteNodeOf(event, observer) !== null) {
    return { channel: "on-site", epistemic: "witnessed", confidence: 1, detail: "summary", delayKey: null };
  }
  if (audience.includes("faction")) {
    return { channel: "briefing", epistemic: "witnessed", confidence: 1, detail: "full", delayKey: "briefing" };
  }
  return null;
}

function triggerFor(
  input: PerceptionRequest,
  channel: ChannelDecision,
): NewAgentTrigger | null {
  const { event, scope } = input;
  const payload = record(event.payload);
  let kind: NewAgentTrigger["kind"] | null = null;
  let priority = 0;
  if (event.type === "DialogueSubmitted" && event.principalId === "player-1" && payload["speakerId"] === "player-1") {
    kind = "player-dialogue";
    priority = 100;
  } else if (event.type === "MessageSent" && channel.channel === "relay") {
    kind = "message";
    priority = 60;
  } else if (event.type === "InformationShared" && channel.channel === "evidence") {
    kind = "message";
    priority = 60;
  } else if (event.type === "TaskInvitationIssued") {
    kind = "task-invite";
    priority = 80;
  } else if (event.type === "AgreementProposed" || (event.type === "AgreementResponded" && payload["response"] === "counter")) {
    kind = "agreement-proposal";
    priority = 70;
  } else if (event.type === "AgentsSummoned") {
    kind = "scenario";
    priority = 60;
  } else if (event.type === "ProbeAsked" && payload["agentId"] === scope.agentId) {
    kind = "probe";
    priority = 100;
  } else if (
    event.type === "TaskFailed" ||
    event.type === "CharacterInjured" ||
    event.type === "RelayDown" ||
    event.type === "OrchardCrisis" ||
    event.type === "MigrationCrisis"
  ) {
    kind = "alert";
    priority = 90;
  }
  if (kind === null) {
    return null;
  }
  return {
    kind,
    priority,
    sourceRef: event.eventId,
    createdTick: input.nowTick,
    dedupeKey: `${kind}:${scope.agentId}:${event.eventId}`,
  };
}

/** 单个主体、单个事件的确定性感知。 */
export function perceive(input: PerceptionRequest, config: PerceptionConfig): PerceptionResult {
  if (!input.observer.eligible) {
    return { observations: [], triggers: [], scannedThroughSeq: input.event.worldSeq };
  }
  const decision = channelFor(input);
  if (decision === null) {
    return { observations: [], triggers: [], scannedThroughSeq: input.event.worldSeq };
  }
  const extra = decision.delayKey === null ? 0 : config.extraDelayTicks[decision.delayKey];
  const knownAtTick = Math.max(input.rendered.knownAtTick, input.nowTick, input.event.worldTick) + extra;
  const selected = decision.detail === "summary" ? input.rendered.summary : input.rendered.full;
  const observation: AgentObservation = {
    observationId: input.event.eventId.replace(/^evt-/, "obs-") as AgentObservation["observationId"],
    scope: input.scope,
    observationSeq: 0,
    sourceEventIds: [input.event.eventId as AgentObservation["sourceEventIds"][number]],
    sourceObservationIds: [],
    occurredAtTick: input.event.worldTick,
    sensedAtTick: knownAtTick,
    knownAtTick,
    channel: decision.channel,
    epistemic: decision.epistemic,
    confidence: decision.confidence,
    releasePolicyId: input.rendered.releasePolicyId,
    content: {
      eventType: input.event.type,
      summaryZh: selected.summaryZh,
      subjectIds: [...selected.subjectIds],
      nodeId: selected.nodeId,
      refs: selected.refs,
      facts: selected.facts,
      claim: selected.claim,
      detail: decision.detail,
    },
  };
  const trigger = triggerFor(input, decision);
  return {
    observations: [observation],
    triggers: trigger === null ? [] : [trigger],
    scannedThroughSeq: input.event.worldSeq,
  };
}

class LocalPerceptionPort implements PerceptionPort {
  constructor(
    private readonly config: PerceptionConfig,
  ) {}

  perceive(input: PerceptionRequest): PerceptionResult {
    return perceive(input, this.config);
  }
}

export function createPerceptionModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = perceptionConfigSchema.parse(input.config);
  return createStatelessModule(input, new LocalPerceptionPort(config));
}
