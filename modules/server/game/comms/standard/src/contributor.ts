/**
 * 注册通信命令与 campaign.start 后续钩子，实现对话、发言、证据分享与开局消息。
 * 依赖通信/世界端口、内容索引、已批准对白读取器与 authority 事务上下文。
 * 禁止在这里直接写世界状态、绕过已批准对白或把秘密当作可分享证据。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { Json, MessageIntentKind } from "@ai-npc/contracts";
import {
  effectivePrincipalId,
  gameModuleIds,
  requireGameContent,
  type GameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import type { ApprovedSpeech } from "@ai-npc/module-sdk";
import type { MessageState } from "./state";

type CommsContext = HandlerContext<GameModulePorts, unknown>;

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

function normalized(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function speechAllowed(
  speech: ApprovedSpeech | null,
  context: CommsContext,
  audience: readonly string[],
  channel: "dialogue" | "message" | "broadcast",
): speech is ApprovedSpeech {
  return (
    speech !== null &&
    speech.approved &&
    speech.branchId === context.auth.branchId &&
    speech.agentId === effectivePrincipalId(context.auth) &&
    speech.channel === channel &&
    normalized(speech.audience).join("\u0000") === normalized(audience).join("\u0000")
  );
}

function allDeliverable(
  context: CommsContext,
  channel: "dialogue" | "message",
  fromId: string,
  audience: readonly string[],
): boolean {
  const port = asPorts(context)["game.comms"];
  return audience.every((principalId) => port.deliverAt(channel, fromId, principalId) !== "relay-down");
}

function initializeOpening(context: CommsContext): void {
  const content = requireGameContent(context.content);
  const ports = asPorts(context);
  const campaign = ports["game.world"].campaign();
  if (campaign === null) {
    return;
  }
  const start = content.starts.get(campaign.factionId);
  if (start === undefined) {
    return;
  }
  for (const message of start.messages) {
    ports["game.comms"].postMessage({
      fromId: message.from,
      to: [content.playerPrincipalId],
      text: message.text,
      channel: "opening",
      intentKind: "scripted",
    });
  }
  for (const evidenceId of start.knowledge) {
    ports["game.comms"].grantKnowledge({
      principalId: content.playerPrincipalId,
      itemId: evidenceId,
      via: "start",
    });
  }
  for (const evidence of content.evidence.values()) {
    for (const principalId of evidence.heldBy ?? []) {
      ports["game.comms"].grantKnowledge({ principalId, itemId: evidence.evidenceId, via: "start" });
    }
  }
  for (const secret of content.secrets.values()) {
    for (const principalId of secret.heldBy) {
      ports["game.comms"].grantKnowledge({ principalId, itemId: secret.secretId, via: "start" });
    }
  }
}

function dialogueSay(context: CommsContext, payload: Json): HandlerResult {
  const input = payload as { readonly targetAgentId: string; readonly text: string };
  const content = requireGameContent(context.content);
  if (!content.characters.has(input.targetAgentId) && !content.factions.has(input.targetAgentId)) {
    return { kind: "rejected", reasonCode: "unknown-target", safeMessage: "目标主体不存在" };
  }
  const speaker = context.auth.principalId;
  const port = asPorts(context)["game.comms"];
  if (!allDeliverable(context, "dialogue", speaker, [input.targetAgentId])) {
    return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法通话" };
  }
  const channelKind = port.sameNode(speaker, input.targetAgentId) ? "face-to-face" : "relay";
  const result = port.postDialogue({
    speakerId: speaker,
    audience: [input.targetAgentId],
    text: input.text,
    channel: "dialogue",
    channelKind,
    conversationId: null,
    replyToId: null,
  });
  return { kind: "accepted", result: { conversationId: result.conversationId, dialogueId: result.dialogueId } };
}

function speechCommit(context: CommsContext, payload: Json): HandlerResult {
  const input = payload as unknown as {
    readonly channel: "dialogue" | "message" | "broadcast";
    readonly conversationId: string | null;
    readonly audience: readonly string[];
    readonly approvedSpeechArtifactRef: string;
    readonly intentKind: string;
    readonly replyToId: string | null;
  };
  const speech = context.approvedSpeech.read(input.approvedSpeechArtifactRef);
  if (!speechAllowed(speech, context, input.audience, input.channel)) {
    return { kind: "rejected", reasonCode: "speech-not-approved", safeMessage: "对白未批准或受众不匹配" };
  }
  const content = requireGameContent(context.content);
  if (input.channel === "broadcast") {
    const broadcaster = content.characters.get(speech.agentId);
    const allowed = speech.agentId === "human-neutral" || broadcaster?.permissions?.includes("broadcast") === true;
    if (!allowed) {
      return { kind: "rejected", reasonCode: "no-authority", safeMessage: "该主体没有公开广播权限" };
    }
  }
  const ports = asPorts(context);
  if (input.channel === "dialogue") {
    if (!allDeliverable(context, "dialogue", speech.agentId, input.audience)) {
      return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法提交对白" };
    }
    if (input.conversationId !== null && !ports["game.comms"].canJoinConversation(input.conversationId, [speech.agentId, ...input.audience])) {
      return { kind: "rejected", reasonCode: "no-authority", safeMessage: "主体不在该会话中" };
    }
    const result = ports["game.comms"].postDialogue({
      speakerId: speech.agentId,
      audience: input.audience,
      text: speech.text,
      channel: "dialogue",
      channelKind: ports["game.comms"].sameNode(speech.agentId, input.audience[0] ?? "") ? "face-to-face" : "relay",
      conversationId: input.conversationId,
      replyToId: input.replyToId,
    });
    return { kind: "accepted", result: { conversationId: result.conversationId, dialogueId: result.dialogueId } };
  }
  if (input.channel === "message" && !allDeliverable(context, "message", speech.agentId, input.audience)) {
    return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法发送消息" };
  }
  const result = ports["game.comms"].postMessage({
    fromId: speech.agentId,
    to: input.audience,
    text: speech.text,
    channel: input.channel === "broadcast" ? "broadcast" : "message",
    intentKind: input.intentKind as MessageIntentKind,
    speechArtifactRef: input.approvedSpeechArtifactRef,
    ...(input.channel === "broadcast" ? { audience: input.audience } : {}),
  });
  return { kind: "accepted", result: { messageId: result.messageId } };
}

function seatSay(context: CommsContext, payload: Json): HandlerResult {
  const input = payload as unknown as { readonly to: readonly string[]; readonly text: string };
  const fromId = effectivePrincipalId(context.auth);
  if (!allDeliverable(context, "message", fromId, input.to)) {
    return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法发送消息" };
  }
  asPorts(context)["game.comms"].postMessage({
    fromId,
    to: input.to,
    text: input.text,
    channel: "seat",
    intentKind: "scripted",
  });
  return { kind: "accepted" };
}

function informationShare(context: CommsContext, payload: Json): HandlerResult {
  const input = payload as unknown as { readonly evidenceId: string; readonly audience: readonly string[] };
  const content = requireGameContent(context.content);
  if (!content.evidence.has(input.evidenceId)) {
    return { kind: "rejected", reasonCode: "evidence-not-held", safeMessage: "证据不存在" };
  }
  if (content.secrets.has(input.evidenceId)) {
    return { kind: "rejected", reasonCode: "secret-not-shareable", safeMessage: "秘密不能主动分享" };
  }
  const ports = asPorts(context);
  const fromId = effectivePrincipalId(context.auth);
  if (!ports["game.comms"].holds(fromId, input.evidenceId)) {
    return { kind: "rejected", reasonCode: "evidence-not-held", safeMessage: "当前主体不持有该证据" };
  }
  if (!allDeliverable(context, "message", fromId, input.audience)) {
    return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法分享证据" };
  }
  const share = ports["game.comms"].postInformationShare({ fromId, evidenceId: input.evidenceId, audience: input.audience });
  // 知识授权按提交时冻结的投递名单安排：发送者已持有证据，其余收件者各按自己的 deliverAtTick 授权。
  for (const delivery of share.deliveries) {
    if (delivery.principalId === fromId) {
      continue;
    }
    if (delivery.deliverAtTick <= context.tx.worldTick) {
      ports["game.comms"].grantKnowledge({ principalId: delivery.principalId, itemId: input.evidenceId, via: "share" });
    } else {
      context.tx.schedule(
        "comms.knowledge-delivery",
        delivery.deliverAtTick,
        `knowledge-delivery:${share.eventId}:${delivery.principalId}`,
        { principalId: delivery.principalId, itemId: input.evidenceId },
      );
    }
  }
  return { kind: "accepted" };
}

/**
 * 把公开传闻物化为通信日志，供投影的收件箱读取。
 * 传闻不是定向通信，没有冻结的逐主体延迟：提交 tick 立即送达全部在地与战略主体。
 * 聚合 ID 直接复用 rumorId，同一事件重复消费也不会产生第二条记录。
 */
function recordRumor(context: CommsContext, payload: Json): void {
  const input = payload as unknown as {
    readonly rumorId: string;
    readonly sourceId: string;
    readonly aboutIds: readonly string[];
    readonly text: string;
  };
  const content = requireGameContent(context.content);
  const tick = context.tx.worldTick;
  const principalIds = [
    content.playerPrincipalId,
    ...content.factions.keys(),
    ...content.characters.keys(),
  ].sort((left, right) => left.localeCompare(right));
  const state: MessageState = {
    messageId: input.rumorId,
    fromId: input.sourceId,
    to: ["public"],
    channel: "reported",
    text: input.text,
    intentKind: "scenario",
    deliveries: principalIds.map((principalId) => ({ principalId, deliverAtTick: tick })),
    committedAtTick: tick,
    conversationId: null,
  };
  context.tx.put("message", input.rumorId, state);
}

/** 通信模块的规则贡献。 */
export function createCommsContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.comms,
    ownsAggregates: ["conversation", "knowledge-grant", "share", "message"],
    commands: [
      { type: "dialogue.say", handler: (context, payload) => dialogueSay(context as CommsContext, payload) },
      { type: "speech.commit", handler: (context, payload) => speechCommit(context as CommsContext, payload) },
      { type: "seat.say", handler: (context, payload) => seatSay(context as CommsContext, payload) },
      { type: "information.share", handler: (context, payload) => informationShare(context as CommsContext, payload) },
    ],
    afterCommands: [
      {
        type: "campaign.start",
        hook: (context) => {
          initializeOpening(context as CommsContext);
          return { kind: "accepted" };
        },
      },
    ],
    jobs: [
      {
        kind: "comms.knowledge-delivery",
        handler: (context, job) => {
          const input = job.payload as { readonly principalId: string; readonly itemId: string };
          asPorts(context)["game.comms"].grantKnowledge({
            principalId: input.principalId,
            itemId: input.itemId,
            via: "share",
          });
        },
      },
    ],
    consumers: [
      {
        consumerId: "comms-rumor-log",
        eventTypes: ["RumorSpread"],
        handler: (context, event) => {
          recordRumor(context as CommsContext, event.payload);
        },
      },
    ],
  };
}

/** 供测试构造内容适配器使用。 */
export type CommsContent = GameContent;
