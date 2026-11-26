/**
 * 覆盖本地感知渠道、延迟、未授权扫描与 trigger 生成。
 * 依赖感知纯函数与固定事件夹具；不启动存储、网络或模型。
 * 禁止用未授权候选伪造观察。
 */
import { describe, expect, it } from "vitest";
import type { PerceptionRequest } from "@world-prism/module-sdk";
import { perceive } from "../src/plugin";
import type { PerceptionConfig } from "../src/definition";

const config: PerceptionConfig = {
  visibleGraphDepth: 0,
  extraDelayTicks: { broadcast: 2, directed: 3, briefing: 4 },
  maxObservationsPerBatch: 12,
  retainUncertainCues: true,
};

function request(overrides: Partial<PerceptionRequest> = {}): PerceptionRequest {
  const base: PerceptionRequest = {
    scope: { worldId: "wld-000000000001", branchId: "br-000000000001", agentId: "human-independent" },
    event: {
      eventId: "evt-000000000001",
      worldSeq: 4,
      worldTick: 10,
      type: "DialogueSubmitted",
      principalId: "player-1",
      causationIds: [],
      audience: [{ kind: "principals", ids: ["player-1", "human-independent"] }],
      payload: {
        dialogueId: "dlg-000000000001",
        conversationId: "conv-000000000001",
        speakerId: "player-1",
        audience: ["player-1", "human-independent"],
        text: "请确认道路。",
        channel: "face-to-face",
        deliveries: [{ principalId: "human-independent", deliverAtTick: 10 }],
        replyToId: null,
      },
    },
    observer: {
      nodeId: "grayharbor",
      factionId: "human-independent",
      eligible: true,
      selfNodeIds: ["grayharbor"],
    },
    rendered: {
      full: {
        summaryZh: "党魁说：“请确认道路。”",
        subjectIds: ["player-1"],
        nodeId: null,
        refs: { conversationId: "conv-000000000001", dialogueId: "dlg-000000000001" },
        facts: {},
        claim: { sourceId: "player-1", senderId: "player-1", text: "请确认道路。" },
      },
      summary: {
        summaryZh: "党魁说：“请确认道路。”",
        subjectIds: ["player-1"],
        nodeId: null,
        refs: {},
        facts: {},
        claim: null,
      },
      releasePolicyId: "parties:human-independent,player-1",
      knownAtTick: 10,
    },
    nowTick: 10,
  };
  return { ...base, ...overrides };
}

describe("agent.perception.local", () => {
  it("玩家当面说话生成 witnessed 对话观察和玩家对白 trigger", () => {
    const result = perceive(request(), config);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      channel: "face-to-face",
      epistemic: "witnessed",
      confidence: 0.6,
    });
    expect(result.triggers).toEqual([
      expect.objectContaining({ kind: "player-dialogue", priority: 100 }),
    ]);
  });

  it("中继对白使用 relay/reported 并应用定向延迟", () => {
    const input = request();
    const result = perceive(
      {
        ...input,
        event: {
          ...input.event,
          payload: { ...(input.event.payload as Record<string, unknown>), channel: "relay" },
        },
      },
      config,
    );
    expect(result.observations[0]).toMatchObject({
      channel: "relay",
      epistemic: "reported",
      knownAtTick: 13,
    });
  });

  it("广播、公开通报、正式通知与派系简报按渠道表降级", () => {
    const message = request();
    const broadcast = perceive(
      {
        ...message,
        event: {
          ...message.event,
          type: "MessageSent",
          audience: [{ kind: "public" }],
          payload: {
            messageId: "msg-000000000001",
            fromId: "npc-wenyuan",
            to: ["public"],
            channel: "broadcast",
            text: "广播",
            deliveries: [{ principalId: "human-independent", deliverAtTick: 10 }],
            intentKind: "inform",
            speechArtifactRef: null,
          },
        },
      },
      config,
    );
    expect(broadcast.observations[0]).toMatchObject({ channel: "broadcast", epistemic: "reported", knownAtTick: 12 });

    const notice = perceive(
      {
        ...message,
        event: {
          ...message.event,
          type: "PolicyChanged",
          audience: [{ kind: "public" }],
          payload: { key: "watergate.allocation", byId: "player-1", oldValue: "rotation", newValue: "harbor-first" },
        },
      },
      config,
    );
    expect(notice.observations[0]).toMatchObject({ channel: "public-notice", confidence: 1 });
  });

  it("未授权事件不产生观察但仍推进内部扫描游标", () => {
    const input = request();
    const result = perceive(
      {
        ...input,
        observer: { ...input.observer, eligible: false },
      },
      config,
    );
    expect(result.observations).toEqual([]);
    expect(result.triggers).toEqual([]);
    expect(result.scannedThroughSeq).toBe(4);
  });
});
