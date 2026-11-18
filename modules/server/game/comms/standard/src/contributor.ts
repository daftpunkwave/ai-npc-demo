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

function nodeOf(context: CommsContext, principalId: string): string | null {
  const content = requireGameContent(context.content);
  const character = content.characters.get(principalId);
  if (character !== undefined) {
    return character.spawnNodeId;
  }
  return principalId === content.playerPrincipalId ? content.playerNodeId : null;
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
  const at = asPorts(context)["game.comms"].deliverAt("dialogue", speaker, input.targetAgentId);
  if (at === "relay-down") {
    return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法通话" };
  }
  const speakerNode = content.playerNodeId;
  const targetNode = nodeOf(context, input.targetAgentId);
  const channelKind = targetNode !== null && targetNode === speakerNode ? "face-to-face" : "relay";
  const result = asPorts(context)["game.comms"].postDialogue({
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
  const ports = asPorts(context);
  if (input.channel === "dialogue") {
    const at = ports["game.comms"].deliverAt("dialogue", speech.agentId, input.audience[0] ?? "");
    if (at === "relay-down") {
      return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法提交对白" };
    }
    const result = ports["game.comms"].postDialogue({
      speakerId: speech.agentId,
      audience: input.audience,
      text: speech.text,
      channel: "dialogue",
      channelKind: at === context.tx.worldTick ? "face-to-face" : "relay",
      conversationId: input.conversationId,
      replyToId: input.replyToId,
    });
    return { kind: "accepted", result: { conversationId: result.conversationId, dialogueId: result.dialogueId } };
  }
  const result = ports["game.comms"].postMessage({
    fromId: speech.agentId,
    to: input.audience,
    text: speech.text,
    channel: input.channel === "broadcast" ? "broadcast" : "message",
    intentKind: input.intentKind as MessageIntentKind,
    speechArtifactRef: input.approvedSpeechArtifactRef,
  });
  return { kind: "accepted", result: { messageId: result.eventId } };
}

function seatSay(context: CommsContext, payload: Json): HandlerResult {
  const input = payload as unknown as { readonly to: readonly string[]; readonly text: string };
  const fromId = effectivePrincipalId(context.auth);
  const at = asPorts(context)["game.comms"].deliverAt("message", fromId, input.to[0] ?? "");
  if (at === "relay-down") {
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
  for (const principalId of input.audience) {
    if (ports["game.comms"].deliverAt("message", fromId, principalId) === "relay-down") {
      return { kind: "rejected", reasonCode: "relay-down", safeMessage: "中继中断，无法分享证据" };
    }
  }
  ports["game.comms"].postInformationShare({ fromId, evidenceId: input.evidenceId, audience: input.audience });
  for (const principalId of input.audience) {
    ports["game.comms"].grantKnowledge({ principalId, itemId: input.evidenceId, via: "share" });
  }
  return { kind: "accepted" };
}

/** 通信模块的规则贡献。 */
export function createCommsContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.comms,
    ownsAggregates: ["conversation", "knowledge-grant"],
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
    consumers: [
      {
        consumerId: "comms-audit",
        eventTypes: ["DialogueSubmitted", "MessageSent", "InformationShared"],
        handler: () => {
          // 通信事件自身已经携带冻结投递名单；保留消费者用于后续投影与审计扩展。
        },
      },
    ],
  };
}

/** 供测试构造内容适配器使用。 */
export type CommsContent = GameContent;
