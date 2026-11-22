/**
 * 核心职责：验证 summary 观察不包含仅限 full 的引用、事实与声明。
 * 交互契约：依赖真实内容包及携带全部引用字段的对白事件。
 * 约束与禁忌：断言授权明细只在 full 中保留，不使用生产数据库。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PerceptionRequest } from "@ai-npc/module-sdk";
import { loadContentPack } from "@ai-npc/experiment";
import { renderObservation } from "../src/observation-renderer";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function dialogueEvent(): PerceptionRequest["event"] {
  return {
    eventId: "evt-000000000001",
    worldSeq: 1,
    worldTick: 4,
    type: "DialogueSubmitted",
    principalId: "player-1",
    causationIds: [],
    audience: [{ kind: "principals", ids: ["player-1", "human-independent"] }],
    payload: {
      speakerId: "npc-yinuo",
      text: "海上要起雾了。",
      agreementId: "agr-000000000001",
      taskId: "tsk-000000000001",
      evidenceId: "evd-000000000001",
      conversationId: "cnv-000000000001",
      dialogueId: "dlg-000000000001",
      messageId: "msg-000000000001",
      deliveries: [{ principalId: "human-independent", deliverAtTick: 7 }],
    },
  };
}

describe("观察渲染隔离", () => {
  it("summary 不包含 refs、facts 或 claim，full 保留授权明细", () => {
    const event = dialogueEvent();
    const rendered = renderObservation({
      content: loadContentPack(resolve(repoRoot, "content"), "earth-2964-v1"),
      event,
      agentId: "human-independent",
      full: true,
    });

    expect(rendered.full.refs).toEqual({
      agreementId: "agr-000000000001",
      taskId: "tsk-000000000001",
      evidenceId: "evd-000000000001",
      conversationId: "cnv-000000000001",
      dialogueId: "dlg-000000000001",
      messageId: "msg-000000000001",
    });
    expect(rendered.full.facts).toBe(event.payload);
    expect(rendered.full.claim).toEqual({
      sourceId: "npc-yinuo",
      senderId: "npc-yinuo",
      text: "海上要起雾了。",
    });
    expect(rendered.summary.refs).toEqual({});
    expect(rendered.summary.facts).toEqual({});
    expect(rendered.summary.claim).toBeNull();
  });
});
