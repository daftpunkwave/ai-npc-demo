/**
 * 核心职责：定义通信模块的游戏端口、日志视图与知识授权视图类型。
 * 交互契约：依赖公共契约的消息意图词表与世界端口的最小只读事实视图。
 * 约束与禁忌：禁止在这里实现送达计算或读取通信模块之外的聚合。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 接口参数名表达调用契约；Codacy 缺少 workspace 类型解析时会把泛型联合误判为 any。 */
import type { MessageIntentKind } from "@world-prism/contracts";
import type { GameWorldPort } from "./game-world-port";

/**
 * 通信模块读取世界事实的最小只读视图：指标与角色位置。
 * 组合根注入已绑定的世界端口；通信模块不再按世界模块 ID 直接读取聚合。
 * 世界状态只记录有角色记录的主体位置；内容包没有角色定义的人类 AI 党魁由内容包派系驻地补足。
 */
export type CommsWorldFacts = Pick<GameWorldPort, "meters" | "character">;

/** 通信端口：送达计算、知识授权与剧情/对白写入。 */
export interface CommsPostResult {
  readonly eventId: string;
  readonly messageId: string | null;
  readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[];
}

/** 证据分享的提交结果；shareId 供回执与工具视图引用本次分享事实。 */
export interface CommsSharePostResult extends CommsPostResult {
  readonly shareId: string;
}

/** 证据分享的一次查询；分享必须落在 [sinceTick, byTick] 内，早于协议生效的分享不构成履约。 */
export interface ShareQuery {
  readonly fromId: string;
  readonly evidenceId: string;
  readonly toPrincipalId: string;
  /** 协议生效 tick；早于它的分享不算履约。 */
  readonly sinceTick: number;
  /** 条款截止 tick；晚于它的分享不算履约。 */
  readonly byTick: number;
}

/** 通信日志的渠道；reported 是剧情卡下发的传闻，来源不是在地主体。 */
export type CommsMessageChannel = "message" | "broadcast" | "seat" | "opening" | "reported";

/** 一条已提交的通信日志；deliverAtTick 是该主体被冻结的送达 tick。 */
export interface CommsMessageView {
  readonly messageId: string;
  readonly fromId: string;
  readonly to: readonly string[];
  readonly channel: CommsMessageChannel;
  readonly text: string;
  readonly intentKind: MessageIntentKind;
  readonly committedAtTick: number;
  readonly deliverAtTick: number;
  readonly conversationId: string | null;
}

/** 一条已固化的对白；deliveries 是提交时冻结的逐主体送达 tick。 */
export interface CommsDialogueLineView {
  readonly seq: number;
  readonly dialogueId: string;
  readonly speakerId: string;
  readonly text: string;
  readonly channel: "face-to-face" | "relay";
  readonly worldTick: number;
  readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[];
}

/** 一条知识授权；itemId 指向内容包的证据或秘密。 */
export interface CommsKnowledgeView {
  readonly itemId: string;
  readonly via: "start" | "share" | "discovery" | "setup";
  readonly grantedAtTick: number;
}

export interface GameCommsPort {
  relayState(): "normal" | "degraded" | "down";
  /** 两个主体此刻是否在同一节点；位置未知的主体（未知主体、内容包有角色定义但世界状态缺少记录的主体）与任何人都不同节点。 */
  sameNode(fromId: string, toId: string): boolean;
  deliverAt(channel: "dialogue" | "message" | "broadcast", fromId: string, toId: string): number | "relay-down";
  holds(principalId: string, itemId: string): boolean;
  /** 已送达给该主体的通信日志：只含投递名单里有该主体且已到送达 tick 的记录，按送达 tick 升序取最近 limit 条。 */
  messagesFor(principalId: string, limit: number): readonly CommsMessageView[];
  /** 该主体参与的会话 ID，按 ID 升序。 */
  conversationsOf(principalId: string): readonly string[];
  /** 会话最近 limit 条对白，按 seq 升序。 */
  conversationMessages(conversationId: string, limit: number): readonly CommsDialogueLineView[];
  /** 该主体持有的知识授权，按授予 tick 与 itemId 升序。 */
  knowledgeOf(principalId: string): readonly CommsKnowledgeView[];
  /** 是否存在由 fromId 在 sinceTick 到 byTick 之间提交、受众包含 toPrincipalId 的证据分享。 */
  hasShare(query: ShareQuery): boolean;
  canJoinConversation(conversationId: string, principalIds: readonly string[]): boolean;
  grantKnowledge(input: {
    readonly principalId: string;
    readonly itemId: string;
    readonly via: "start" | "share" | "discovery" | "setup";
    readonly grantedAtTick?: number;
  }): { readonly grantId: string };
  postMessage(input: {
    readonly fromId: string;
    readonly to: readonly string[];
    readonly text: string;
    readonly channel: "message" | "broadcast" | "seat" | "opening";
    readonly intentKind: MessageIntentKind;
    readonly speechArtifactRef?: string | null;
    readonly audience?: readonly string[];
    /** 广播的发布位置；缺省用发送者当前位置，中继中断时只送达与该位置同节点的主体。 */
    readonly originNodeId?: string;
  }): CommsPostResult;
  postDialogue(input: {
    readonly speakerId: string;
    readonly audience: readonly string[];
    readonly text: string;
    readonly channel: "dialogue" | "message";
    readonly channelKind: "face-to-face" | "relay";
    readonly conversationId: string | null;
    readonly replyToId: string | null;
  }): { readonly eventId: string; readonly conversationId: string; readonly dialogueId: string; readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[] };
  postInformationShare(input: {
    readonly fromId: string;
    readonly evidenceId: string;
    readonly audience: readonly string[];
  }): CommsSharePostResult;
}
