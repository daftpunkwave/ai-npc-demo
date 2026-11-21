/**
 * 实现通信模块的送达计算、会话/知识写入、消息、证据分享与分享事实查询。
 * 依赖注入的世界只读视图（指标与角色位置）、通信聚合和本模块 scoped WorldTx。
 * 禁止绕过中继状态、向未授权主体投递、改写已冻结的投递名单或读取其他模块的私有聚合。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { MessageIntentKind, ReasonCode } from "@ai-npc/contracts";
import { DomainError } from "@ai-npc/contracts";
import {
  factionStandingNode,
  principalsAudience,
  type CommsDialogueLineView,
  type CommsKnowledgeView,
  type CommsMessageView,
  type CommsWorldFacts,
  type GameCommsPort,
  type GameContent,
  type GameIdFactory,
  type OwnWorldTxFactory,
  type ShareQuery,
} from "@ai-npc/module-sdk";
import {
  conversationStateSchema,
  readCommsState,
  type ConversationLineState,
  type ConversationState,
  type KnowledgeGrantState,
  type MessageState,
  type ShareState,
} from "./state";

type Delivery = { readonly principalId: string; readonly deliverAtTick: number };

/** 通信端口实现；每个处理器调用绑定同一 storage transaction。 */
class StandardCommsPort implements GameCommsPort {
  private readonly ownTx: OwnWorldTxFactory;
  private readonly content: GameContent;
  private readonly ids: GameIdFactory;
  private readonly world: CommsWorldFacts;

  constructor(ownTx: OwnWorldTxFactory, content: GameContent, ids: GameIdFactory, world: CommsWorldFacts) {
    this.ownTx = ownTx;
    this.content = content;
    this.ids = ids;
    this.world = world;
  }

  private tx() {
    return this.ownTx();
  }

  /**
   * 同一份事务内的位置，按“世界状态优先，无角色记录者取内容包驻地”判定：
   * 有角色记录的 Agent（8 名公社支持者与 3 名外域 Agent）取世界状态当前节点，随任务移动更新；
   * 有角色定义但世界状态缺少记录时位置未知，不拿静态驻地冒充，否则会错误地绕过中继延迟或中断拒绝。
   * 玩家取内容包声明的玩家节点；内容包没有角色定义的人类 AI 党魁以派系 ID 行动，取内容包派系驻地链。
   * 本切片 AI 党魁不参加任务、没有移动路径；将来若允许其移动，必须把位置写入世界状态，
   * 否则这里的派系驻地会与地图位置不一致。未知主体没有位置。
   */
  private principalNode(principalId: string): string | null {
    const character = this.world.character(principalId);
    if (character !== null) {
      return character.nodeId;
    }
    if (principalId === this.content.playerPrincipalId) {
      return this.content.playerNodeId;
    }
    const faction = this.content.factions.get(principalId);
    if (faction === undefined || this.content.characters.has(principalId)) {
      return null;
    }
    return factionStandingNode(faction) ?? null;
  }

  /** 两个主体此刻是否在同一节点；任一方没有位置时都不算同节点。 */
  sameNode(fromId: string, toId: string): boolean {
    const fromNode = this.principalNode(fromId);
    return fromNode !== null && fromNode === this.principalNode(toId);
  }

  private allPrincipals(): string[] {
    return [
      this.content.playerPrincipalId,
      ...this.content.factions.keys(),
      ...this.content.characters.keys(),
    ];
  }

  /**
   * 中继状态：稳定度 ≥ 30 正常、1–29 降级、0 中断。
   * 世界指标尚未初始化表示 campaign 尚未开始、中继还没有建立，按中断处理；
   * 字段缺失同样不默认成 100，避免把未知状态当成稳定。
   */
  relayState(): "normal" | "degraded" | "down" {
    const value = this.world.meters()?.["relay.stability"];
    if (value === undefined || value <= 0) {
      return "down";
    }
    return value < 30 ? "degraded" : "normal";
  }

  /** 同节点立即送达；异地按渠道与中继状态延迟，中断时不可达。 */
  private arrivalAt(channel: "dialogue" | "message" | "broadcast", samePlace: boolean): number | "relay-down" {
    const tick = this.tx().worldTick;
    if (samePlace) {
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

  /** 定向通信：发送者立即回显，其余收件者按同节点与中继状态计算。 */
  private directedArrival(channel: "dialogue" | "message", fromId: string, toId: string): number | "relay-down" {
    if (fromId === toId) {
      return this.tx().worldTick;
    }
    return this.arrivalAt(channel, this.sameNode(fromId, toId));
  }

  /** 广播的同节点判定以发布位置为准；发布位置未知时任何收件者都按异地处理。 */
  private broadcastArrival(originNodeId: string | null, toId: string): number | "relay-down" {
    const toNode = this.principalNode(toId);
    return this.arrivalAt("broadcast", originNodeId !== null && toNode === originNodeId);
  }

  deliverAt(channel: "dialogue" | "message" | "broadcast", fromId: string, toId: string): number | "relay-down" {
    if (channel === "broadcast") {
      return this.broadcastArrival(this.principalNode(fromId), toId);
    }
    return this.directedArrival(channel, fromId, toId);
  }

  /**
   * 冻结投递名单：按 principalId 排序去重。定向通信中任一收件者不可达就整条返回 null，
   * 广播则只保留与发布位置同节点的主体。
   */
  private deliveries(
    channel: "dialogue" | "message" | "broadcast",
    fromId: string,
    recipients: readonly string[],
    originNodeId?: string | null,
  ): readonly Delivery[] | null {
    const unique = [...new Set([fromId, ...recipients])].sort((left, right) => left.localeCompare(right));
    const output: Delivery[] = [];
    for (const principalId of unique) {
      const at = channel === "broadcast"
        ? this.broadcastArrival(originNodeId ?? null, principalId)
        : this.directedArrival(channel, fromId, principalId);
      if (at === "relay-down") {
        if (channel !== "broadcast") {
          return null;
        }
        continue;
      }
      output.push({ principalId, deliverAtTick: at });
    }
    return output;
  }

  /** 追加一条已固化的对白；序号从 0 开始，lastSeq 记录下一条对白的序号。 */
  private appendConversationLine(
    conversationId: string,
    participants: readonly string[],
    line: Omit<ConversationLineState, "seq" | "deliveries"> & {
      readonly deliveries: readonly Delivery[];
    },
  ): ConversationState {
    const existing = readCommsState(this.tx(), "conversation", conversationId, conversationStateSchema);
    const seq = existing === null ? 0 : existing.lastSeq;
    const next: ConversationState = {
      conversationId,
      participants: [...new Set([...(existing?.participants ?? []), ...participants])],
      lastSeq: seq + 1,
      lines: [...(existing?.lines ?? []), { ...line, seq, deliveries: [...line.deliveries] }],
    };
    this.tx().put("conversation", conversationId, next);
    return next;
  }

  holds(principalId: string, itemId: string): boolean {
    return this.tx()
      .list<KnowledgeGrantState>("knowledge-grant")
      .some((entry) => entry.state.principalId === principalId && entry.state.itemId === itemId);
  }

  /**
   * 已送达给该主体的通信日志；未到送达 tick 或不在投递名单里的记录照常保留在聚合中但不返回。
   * 保留窗口按送达 tick 取最近 limit 条：提交早但送达晚的消息在送达当刻仍落在窗口内，
   * 不会被之后提交、更早送达的消息挤出收件箱。
   */
  messagesFor(principalId: string, limit: number): readonly CommsMessageView[] {
    const limitValue = Math.max(0, Math.trunc(limit));
    if (limitValue === 0) {
      return [];
    }
    const tick = this.tx().worldTick;
    const delivered: CommsMessageView[] = [];
    for (const entry of this.tx().list<MessageState>("message")) {
      const state = entry.state;
      const delivery = state.deliveries.find((candidate) => candidate.principalId === principalId);
      if (delivery === undefined || delivery.deliverAtTick > tick) {
        continue;
      }
      delivered.push({
        messageId: state.messageId,
        fromId: state.fromId,
        to: state.to,
        channel: state.channel,
        text: state.text,
        intentKind: state.intentKind,
        committedAtTick: state.committedAtTick,
        deliverAtTick: delivery.deliverAtTick,
        conversationId: state.conversationId,
      });
    }
    return delivered
      .sort(
        (left, right) =>
          left.deliverAtTick - right.deliverAtTick ||
          left.committedAtTick - right.committedAtTick ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(-limitValue);
  }

  conversationsOf(principalId: string): readonly string[] {
    return this.tx()
      .list<ConversationState>("conversation")
      .map((entry) => entry.state)
      .filter((state) => state.participants.includes(principalId))
      .map((state) => state.conversationId)
      .sort((left, right) => left.localeCompare(right));
  }

  conversationMessages(conversationId: string, limit: number): readonly CommsDialogueLineView[] {
    const limitValue = Math.max(0, Math.trunc(limit));
    if (limitValue === 0) {
      return [];
    }
    const state = readCommsState(this.tx(), "conversation", conversationId, conversationStateSchema);
    if (state === null) {
      return [];
    }
    return [...state.lines]
      .sort((left, right) => left.seq - right.seq)
      .slice(-limitValue)
      .map((line) => ({
        seq: line.seq,
        dialogueId: line.dialogueId,
        speakerId: line.speakerId,
        text: line.text,
        channel: line.channel,
        worldTick: line.worldTick,
        deliveries: line.deliveries,
      }));
  }

  knowledgeOf(principalId: string): readonly CommsKnowledgeView[] {
    return this.tx()
      .list<KnowledgeGrantState>("knowledge-grant")
      .map((entry) => entry.state)
      .filter((state) => state.principalId === principalId)
      .sort(
        (left, right) =>
          left.grantedAtTick - right.grantedAtTick || left.itemId.localeCompare(right.itemId),
      )
      .map((state) => ({ itemId: state.itemId, via: state.via, grantedAtTick: state.grantedAtTick }));
  }

  /** 已提交的分享事实：分享者、证据、受众与提交 tick，均在同一事务内读取；只认 sinceTick 之后的分享。 */
  hasShare(query: ShareQuery): boolean {
    return this.tx()
      .list<ShareState>("share")
      .some(
        (entry) =>
          entry.state.fromId === query.fromId &&
          entry.state.evidenceId === query.evidenceId &&
          entry.state.audience.includes(query.toPrincipalId) &&
          entry.state.sharedAtTick >= query.sinceTick &&
          entry.state.sharedAtTick <= query.byTick,
      );
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
    readonly originNodeId?: string;
  }): { readonly eventId: string; readonly messageId: string; readonly deliveries: readonly Delivery[] } {
    const wantsPublic = input.channel !== "broadcast" || input.audience === undefined || input.audience.includes("public");
    const recipients = input.channel === "broadcast"
      ? (wantsPublic ? this.allPrincipals() : (input.audience ?? []))
      : [...input.to];
    // 广播的同节点判定以发布位置为准；缺省时按发送者当前位置发布。
    const originNodeId = input.channel === "broadcast"
      ? (input.originNodeId ?? this.principalNode(input.fromId))
      : null;
    const deliveries = input.channel === "opening"
      ? [...new Set([input.fromId, ...recipients])]
          .sort((left, right) => left.localeCompare(right))
          .map((principalId) => ({ principalId, deliverAtTick: 0 }))
      : this.deliveries(input.channel === "broadcast" ? "broadcast" : "message", input.fromId, recipients, originNodeId);
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
    // 通信日志与事件同事务落库：读接口与投影只读这份日志，不回放事件。
    const message: MessageState = {
      messageId,
      fromId: input.fromId,
      to: publicBroadcast ? ["public"] : [...input.to],
      channel: input.channel,
      text: input.text,
      intentKind: input.intentKind,
      deliveries: deliveries.map((delivery) => ({ ...delivery })),
      committedAtTick: this.tx().worldTick,
      conversationId: null,
    };
    this.tx().put("message", messageId, message);
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
    const deliveries = this.deliveries("dialogue", input.speakerId, input.audience);
    if (deliveries === null) {
      throw new DomainError("invalid-state", "中继中断时不能提交对白");
    }
    const dialogueId = this.ids("dlg");
    // 会话聚合按 seq 固化正文与冻结投递；读接口与投影据此还原玩家收到的对白。
    this.appendConversationLine(conversationId, [input.speakerId, ...input.audience], {
      dialogueId,
      speakerId: input.speakerId,
      text: input.text,
      channel: input.channelKind,
      worldTick: this.tx().worldTick,
      deliveries,
    });
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
    const sharedAtTick = this.tx().worldTick;
    // 分享聚合同事务写入：协议期限 job 与章节统计据此复核已提交的分享事实。
    const share: ShareState = {
      shareId,
      fromId: input.fromId,
      evidenceId: input.evidenceId,
      audience: [...input.audience],
      sharedAtTick,
    };
    this.tx().put("share", shareId, share);
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

/** 构造绑定到当前事务的通信端口；world 为组合根注入的世界只读视图。 */
export function createCommsPort(
  ownTx: OwnWorldTxFactory,
  content: GameContent,
  ids: GameIdFactory,
  world: CommsWorldFacts,
): GameCommsPort {
  return new StandardCommsPort(ownTx, content, ids, world);
}

/** 通信拒绝原因码；保留类型收窄供处理器使用。 */
export type CommsReasonCode = Extract<ReasonCode, "relay-down" | "evidence-not-held" | "secret-not-shareable" | "no-authority">;
