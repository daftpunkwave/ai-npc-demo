/**
 * 核心职责：从通信端口构建会话对白、收件箱、知识笔记与待回复角色的玩家可见视图。
 * 交互契约：依赖内容索引与通信端口；只保留已按冻结投递名单送达玩家的记录。
 * 约束与禁忌：秘密与其他非证据知识不进入笔记；不伪造事件摘要或消息来源。
 */
import type { ConversationLine, InboxItemView, NotebookEntryView } from "@ai-npc/contracts";
import type { GameCommsPort, GameContent } from "@ai-npc/module-sdk";

/** 会话对白与收件箱的保留条数；取最近 50 条。 */
const conversationLineLimit = 50;
const inboxItemLimit = 50;

function speakerNameOf(
  content: GameContent,
  speakerId: string,
  playerPrincipalId: string,
  playerName: string | undefined,
): string {
  const character = content.characters.get(speakerId);
  if (character !== undefined) {
    return character.name;
  }
  return speakerId === playerPrincipalId ? (playerName ?? speakerId) : speakerId;
}

/**
 * 会话：玩家参与的会话最近 50 条对白。
 * 只保留已按冻结投递名单送达玩家的对白，未到送达 tick 的行不出现。
 */
export function conversationLines(input: {
  readonly content: GameContent;
  readonly comms: GameCommsPort | undefined;
  readonly playerPrincipalId: string;
  readonly playerName: string | undefined;
  readonly tick: number;
}): ConversationLine[] {
  const { content, comms, playerPrincipalId, playerName, tick } = input;
  if (comms === undefined) {
    return [];
  }
  const delivered: { readonly conversationId: string; readonly line: ConversationLine }[] = [];
  for (const conversationId of comms.conversationsOf(playerPrincipalId)) {
    for (const line of comms.conversationMessages(conversationId, conversationLineLimit)) {
      const delivery = line.deliveries.find((candidate) => candidate.principalId === playerPrincipalId);
      if (delivery === undefined || delivery.deliverAtTick > tick) {
        continue;
      }
      delivered.push({
        conversationId,
        line: {
          seq: line.seq,
          dialogueId: line.dialogueId,
          speakerId: line.speakerId,
          speakerName: speakerNameOf(content, line.speakerId, playerPrincipalId, playerName),
          text: line.text,
          worldTick: line.worldTick,
          channel: line.channel,
        },
      });
    }
  }
  return delivered
    .sort(
      (left, right) =>
        left.line.worldTick - right.line.worldTick ||
        left.conversationId.localeCompare(right.conversationId) ||
        left.line.seq - right.line.seq,
    )
    .map((entry) => entry.line)
    .slice(-conversationLineLimit);
}

/** 收件箱：已送达玩家的消息、公开广播与传闻；来源与「传闻」由 kind 标明。 */
export function inboxItems(comms: GameCommsPort | undefined, playerPrincipalId: string): InboxItemView[] {
  if (comms === undefined) {
    return [];
  }
  const items: InboxItemView[] = [];
  for (const message of comms.messagesFor(playerPrincipalId, inboxItemLimit)) {
    if (message.fromId === playerPrincipalId) {
      continue;
    }
    items.push({
      kind:
        message.channel === "broadcast"
          ? "broadcast"
          : message.channel === "reported"
            ? "rumor"
            : "message",
      sourceId: message.fromId,
      text: message.text,
      worldTick: message.deliverAtTick,
    });
  }
  // 同一世界 tick 内保持通信日志的提交顺序，不按来源重排。
  return items.sort((left, right) => left.worldTick - right.worldTick);
}

/**
 * 笔记：玩家持有知识授权的证据，正文来自内容索引；秘密与其他知识不进入笔记。
 * 来源优先取证据条目声明的发现位置，没有位置时退化为授予途径（start/share/discovery/setup）。
 * 亲历事件摘要需要事件读取游标，当前端口不提供，因此不输出，也不伪造事件 ID 与摘要。
 */
export function notebookEntries(
  content: GameContent,
  comms: GameCommsPort | undefined,
  playerPrincipalId: string,
): NotebookEntryView[] {
  if (comms === undefined) {
    return [];
  }
  const entries: NotebookEntryView[] = [];
  for (const knowledge of comms.knowledgeOf(playerPrincipalId)) {
    const evidence = content.evidence.get(knowledge.itemId);
    if (evidence === undefined) {
      continue;
    }
    entries.push({
      kind: "evidence",
      evidenceId: evidence.evidenceId,
      title: evidence.title,
      body: evidence.content,
      source: evidence.nodeId ?? knowledge.via,
    });
  }
  return entries.sort((left, right) => {
    if (left.kind !== "evidence" || right.kind !== "evidence") {
      return 0;
    }
    return left.evidenceId.localeCompare(right.evidenceId);
  });
}

/**
 * 待回复角色：玩家在会话里说完最后一句，且该角色仍有排队或进行中的 turn。
 * 只暴露「正在处理」，不含 turn 内容；宿主没提供调度状态时为空。
 */
export function awaitingReplyFrom(input: {
  readonly content: GameContent;
  readonly comms: GameCommsPort | undefined;
  readonly playerPrincipalId: string;
  readonly awaitingReplyCharacters: readonly string[];
}): string[] {
  const { content, comms, playerPrincipalId, awaitingReplyCharacters } = input;
  if (comms === undefined || awaitingReplyCharacters.length === 0) {
    return [];
  }
  const pending = new Set(awaitingReplyCharacters);
  const waiting = new Set<string>();
  for (const conversationId of comms.conversationsOf(playerPrincipalId)) {
    const lines = comms.conversationMessages(conversationId, conversationLineLimit);
    const last = lines[lines.length - 1];
    if (last === undefined || last.speakerId !== playerPrincipalId) {
      continue;
    }
    for (const delivery of last.deliveries) {
      if (
        delivery.principalId !== playerPrincipalId &&
        pending.has(delivery.principalId) &&
        content.characters.has(delivery.principalId)
      ) {
        waiting.add(delivery.principalId);
      }
    }
  }
  return [...waiting].sort((left, right) => left.localeCompare(right));
}
