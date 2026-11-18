/**
 * 实现通信模块的送达计算、会话/知识写入、消息与证据分享。
 * 依赖世界指标与角色位置、通信聚合和注入的 scoped WorldTx。
 * 禁止绕过中继状态、向未授权主体投递或改写已冻结的投递名单。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { MessageIntentKind, ReasonCode } from "@ai-npc/contracts";
import { DomainError } from "@ai-npc/contracts";
import {
  gameModuleIds,
  principalsAudience,
  type GameCommsPort,
  type GameContent,
  type GameIdFactory,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import {
  conversationStateSchema,
  readCommsState,
  type ConversationState,
  type KnowledgeGrantState,
} from "./state";

type Delivery = { readonly principalId: string; readonly deliverAtTick: number };

/** 通信端口实现；每个处理器调用绑定同一 storage transaction。 */
class StandardCommsPort implements GameCommsPort {
  private readonly txFor: ScopedWorldTxFactory;
  private readonly content: GameContent;
  private readonly ids: GameIdFactory;

  constructor(txFor: ScopedWorldTxFactory, content: GameContent, ids: GameIdFactory) {
    this.txFor = txFor;
    this.content = content;
    this.ids = ids;
  }

  private tx() {
    return this.txFor(gameModuleIds.comms);
  }

  private world() {
    return this.txFor(gameModuleIds.world);
  }

  private principalNode(principalId: string): string | null {
    const character = this.content.characters.get(principalId);
    if (character !== undefined) {
      return character.spawnNodeId;
    }
    if (principalId === this.content.playerPrincipalId) {
      return this.content.playerNodeId;
    }
    return null;
  }

  private allPrincipals(): string[] {
    return [
      this.content.playerPrincipalId,
      ...this.content.factions.keys(),
      ...this.content.characters.keys(),
    ];
  }

  relayState(): "normal" | "degraded" | "down" {
    const meters = (this.world().get<unknown>("meters", "meters")?.state ?? null) as {
      readonly "relay.stability"?: unknown;
    } | null;
    const value = typeof meters?.["relay.stability"] === "number" ? meters["relay.stability"] : 100;
    if (value <= 0) {
      return "down";
    }
    return value < 30 ? "degraded" : "normal";
  }

  deliverAt(channel: "dialogue" | "message" | "broadcast", fromId: string, toId: string): number | "relay-down" {
    const tick = this.tx().worldTick;
    if (fromId === toId) {
      return tick;
    }
    const fromNode = this.principalNode(fromId);
    const toNode = this.principalNode(toId);
    const sameNode = fromNode !== null && fromNode === toNode;
    if (sameNode) {
      return tick;
    }
    const state = this.relayState();
    if (state === "down") {
      return "relay-down";
    }
    if (channel === "dialogue") {
      return state === "degraded" ? tick + 2 : tick;
    }
    return state === "degraded" ? tick + 3 : tick + 1;
  }

  private deliveries(
    channel: "dialogue" | "message" | "broadcast",
    fromId: string,
    recipients: readonly string[],
  ): readonly Delivery[] | null {
    const unique = [...new Set([fromId, ...recipients])].sort((left, right) => left.localeCompare(right));
    const output: Delivery[] = [];
    for (const principalId of unique) {
      const at = this.deliverAt(channel, fromId, principalId);
      if (at === "relay-down") {
        if (channel !== "broadcast") {
          return null;
        }
        continue;
      }
      output.push({ principalId, deliverAtTick: at });
    }
    if (channel !== "broadcast" && !output.some((item) => item.principalId === fromId)) {
      output.push({ principalId: fromId, deliverAtTick: this.tx().worldTick });
      output.sort((left, right) => left.principalId.localeCompare(right.principalId));
    }
    return output;
  }

  private saveConversation(conversationId: string, participants: readonly string[]): ConversationState {
    const existing = readCommsState(this.tx(), "conversation", conversationId, conversationStateSchema);
    const next: ConversationState = existing === null
      ? { conversationId, participants: [...new Set(participants)], lastSeq: 1 }
      : {
          conversationId,
          participants: [...new Set([...existing.participants, ...participants])],
          lastSeq: existing.lastSeq + 1,
        };
    this.tx().put("conversation", conversationId, next);
    return next;
  }

  holds(principalId: string, itemId: string): boolean {
    return this.tx()
      .list<KnowledgeGrantState>("knowledge-grant")
      .some((entry) => entry.state.principalId === principalId && entry.state.itemId === itemId);
  }

  canJoinConversation(conversationId: string, principalIds: readonly string[]): boolean {
    const existing = readCommsState(this.tx(), "conversation", conversationId, conversationStateSchema);
    if (existing === null) {
      return true;
    }
    return principalIds.every((principalId) => existing.participants.includes(principalId));
  }

  grantKnowledge(input: {
    readonly principalId: string;
    readonly itemId: string;
    readonly via: "start" | "share" | "discovery" | "setup";
    readonly grantedAtTick?: number;
  }): { readonly grantId: string } {
    const existing = this.tx()
      .list<KnowledgeGrantState>("knowledge-grant")
      .find(
        (entry) =>
          entry.state.principalId === input.principalId &&
          entry.state.itemId === input.itemId &&
          entry.state.via === input.via,
      );
    if (existing !== undefined) {
      return { grantId: existing.state.grantId };
    }
    const grantId = this.ids("kg");
    const state: KnowledgeGrantState = {
      grantId,
      principalId: input.principalId,
      itemId: input.itemId,
      via: input.via,
      grantedAtTick: input.grantedAtTick ?? this.tx().worldTick,
    };
    this.tx().put("knowledge-grant", grantId, state);
    this.tx().emit(
      "KnowledgeGranted",
      { grantId, principalId: input.principalId, itemId: input.itemId, via: input.via },
      [...principalsAudience([input.principalId])],
    );
    return { grantId };
  }

  postMessage(input: {
    readonly fromId: string;
    readonly to: readonly string[];
    readonly text: string;
    readonly channel: "message" | "broadcast" | "seat" | "opening";
    readonly intentKind: MessageIntentKind;
    readonly speechArtifactRef?: string | null;
    readonly audience?: readonly string[];
  }): { readonly eventId: string; readonly messageId: string; readonly deliveries: readonly Delivery[] } {
    const wantsPublic = input.channel !== "broadcast" || input.audience === undefined || input.audience.includes("public");
    const recipients = input.channel === "broadcast"
      ? (wantsPublic ? this.allPrincipals() : (input.audience ?? []))
      : [...input.to];
    const deliveries = input.channel === "opening"
      ? [...new Set([input.fromId, ...recipients])]
          .sort((left, right) => left.localeCompare(right))
          .map((principalId) => ({ principalId, deliverAtTick: 0 }))
      : this.deliveries(input.channel === "broadcast" ? "broadcast" : "message", input.fromId, recipients);
    if (deliveries === null) {
      throw new DomainError("invalid-state", "中继中断时不能发送定向通信");
    }
    const messageId = this.ids("msg");
    const publicBroadcast = input.channel === "broadcast" && wantsPublic;
    const relayDown = input.channel === "broadcast" && this.relayState() === "down";
    const audience = publicBroadcast && !relayDown
      ? [{ kind: "public" } as const]
      : [...principalsAudience(deliveries.map((delivery) => delivery.principalId))];
    const eventId = this.tx().emit(
      "MessageSent",
      {
        messageId,
        fromId: input.fromId,
        to: publicBroadcast ? ["public"] : [...input.to],
        channel: input.channel,
        text: input.text,
        deliveries: [...deliveries],
        intentKind: input.intentKind,
        speechArtifactRef: input.speechArtifactRef ?? null,
      },
      audience,
    );
    return { eventId, messageId, deliveries };
  }

  postDialogue(input: {
    readonly speakerId: string;
    readonly audience: readonly string[];
    readonly text: string;
    readonly channel: "dialogue" | "message";
    readonly channelKind: "face-to-face" | "relay";
    readonly conversationId: string | null;
    readonly replyToId: string | null;
  }): { readonly eventId: string; readonly conversationId: string; readonly dialogueId: string; readonly deliveries: readonly Delivery[] } {
    const conversationId = input.conversationId ?? this.ids("conv");
    if (!this.canJoinConversation(conversationId, [input.speakerId, ...input.audience])) {
      throw new DomainError("forbidden", "主体不在该会话中，不能追加对白");
    }
    this.saveConversation(conversationId, [input.speakerId, ...input.audience]);
    const deliveries = this.deliveries("dialogue", input.speakerId, input.audience);
    if (deliveries === null) {
      throw new DomainError("invalid-state", "中继中断时不能提交对白");
    }
    const dialogueId = this.ids("dlg");
    const eventId = this.tx().emit(
      "DialogueSubmitted",
      {
        dialogueId,
        conversationId,
        speakerId: input.speakerId,
        audience: [...new Set([input.speakerId, ...input.audience])],
        text: input.text,
        channel: input.channelKind,
        deliveries: [...deliveries],
        replyToId: input.replyToId,
      },
      [...principalsAudience([input.speakerId, ...input.audience])],
    );
    return { eventId, conversationId, dialogueId, deliveries };
  }

  postInformationShare(input: {
    readonly fromId: string;
    readonly evidenceId: string;
    readonly audience: readonly string[];
  }): { readonly eventId: string; readonly messageId: null; readonly deliveries: readonly Delivery[] } {
    const deliveries = this.deliveries("message", input.fromId, input.audience);
    if (deliveries === null) {
      throw new DomainError("invalid-state", "中继中断时不能分享证据");
    }
    const shareId = this.ids("shr");
    const eventId = this.tx().emit(
      "InformationShared",
      {
        shareId,
        fromId: input.fromId,
        evidenceId: input.evidenceId,
        audience: [...input.audience],
        deliveries: [...deliveries],
      },
      [...principalsAudience([input.fromId, ...input.audience])],
    );
    return { eventId, messageId: null, deliveries };
  }
}

/** 构造绑定到当前事务的通信端口。 */
export function createCommsPort(
  txFor: ScopedWorldTxFactory,
  content: GameContent,
  ids: GameIdFactory,
): GameCommsPort {
  return new StandardCommsPort(txFor, content, ids);
}

/** 通信拒绝原因码；保留类型收窄供处理器使用。 */
export type CommsReasonCode = Extract<ReasonCode, "relay-down" | "evidence-not-held" | "secret-not-shareable" | "no-authority">;
