/**
 * 核心职责：逐行验证感知渠道表：每种情形得到的 channel、epistemic、confidence、detail 与延迟键。
 * 交互契约：使用感知纯函数与固定事件夹具；不启动存储、网络或模型。
 * 约束与禁忌：每行断言必须对应规格渠道表的同一行，禁止用其它行放行通过；未授权候选不得伪造观察。
 */
import { describe, expect, it } from "vitest";
import type { PerceptionRequest } from "@world-prism/module-sdk";
import type { PerceptionConfig } from "../src/definition";
import { perceive } from "../src/plugin";

const config: PerceptionConfig = {
  visibleGraphDepth: 0,
  extraDelayTicks: { broadcast: 2, directed: 3, briefing: 4 },
  maxObservationsPerBatch: 12,
  retainUncertainCues: true,
};

const agentId = "human-independent";

/** 构造一个可复用的基础请求：默认是玩家在灰港当面说话。 */
function request(overrides: Partial<PerceptionRequest> = {}): PerceptionRequest {
  const base: PerceptionRequest = {
    scope: { worldId: "wld-000000000001", branchId: "br-000000000001", agentId },
    event: {
      eventId: "evt-000000000001",
      worldSeq: 4,
      worldTick: 10,
      type: "DialogueSubmitted",
      principalId: "player-1",
      causationIds: [],
      audience: [{ kind: "principals", ids: ["player-1", agentId] }],
      payload: {
        dialogueId: "dlg-000000000001",
        conversationId: "conv-000000000001",
        speakerId: "player-1",
        audience: ["player-1", agentId],
        text: "请确认道路。",
        channel: "face-to-face",
        deliveries: [{ principalId: agentId, deliverAtTick: 10 }],
        replyToId: null,
      },
    },
    observer: { nodeId: "grayharbor", factionId: "human-independent", eligible: true, selfNodeIds: ["grayharbor"] },
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

/** 只替换事件字段，保留观察者与渲染结果。 */
function withEvent(
  input: PerceptionRequest,
  event: Partial<PerceptionRequest["event"]> & { readonly payload?: Record<string, unknown> },
): PerceptionRequest {
  return {
    ...input,
    event: {
      ...input.event,
      ...event,
      payload: (event.payload ?? input.event.payload) as PerceptionRequest["event"]["payload"],
    },
  };
}

/** 只取观察表中与渠道表相关的四项加获知 tick；细度取自观察内容的 detail。 */
function channelOf(input: PerceptionRequest): unknown {
  const result = perceive(input, config);
  expect(result.observations).toHaveLength(1);
  const [observation] = result.observations;
  return {
    channel: observation?.channel,
    epistemic: observation?.epistemic,
    confidence: observation?.confidence,
    detail: (observation?.content as { readonly detail?: string } | undefined)?.detail,
    knownAtTick: observation?.knownAtTick,
  };
}

describe("感知渠道表逐行断言", () => {
  it("第 1 行：当面说话记为 witnessed，置信度 0.6，无额外延迟", () => {
    expect(channelOf(request())).toEqual({
      channel: "face-to-face", epistemic: "witnessed", confidence: 0.6, detail: "full", knownAtTick: 10,
    });
  });

  it("第 2 行：中继对白与定向消息记为 reported，置信度 0.6，按 directed 延迟", () => {
    const relayDialogue = request();
    expect(channelOf(withEvent(relayDialogue, {
      payload: { ...(relayDialogue.event.payload as Record<string, unknown>), channel: "relay" },
    }))).toEqual({
      channel: "relay", epistemic: "reported", confidence: 0.6, detail: "full", knownAtTick: 13,
    });

    const directed = request();
    expect(channelOf(withEvent(directed, {
      type: "MessageSent",
      payload: {
        messageId: "msg-000000000001", fromId: "npc-wenyuan", to: [agentId], channel: "message", text: "定向消息",
        deliveries: [{ principalId: agentId, deliverAtTick: 10 }], intentKind: "inform", speechArtifactRef: null,
      },
    }))).toEqual({
      channel: "relay", epistemic: "reported", confidence: 0.6, detail: "full", knownAtTick: 13,
    });
  });

  it("第 3 行：他人分享的证据记为 reported，置信度 0.9，按 directed 延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "InformationShared",
      payload: {
        shareId: "shr-000000000001", fromId: "npc-wenyuan", evidenceId: "ev-flood-log", audience: [agentId],
        deliveries: [{ principalId: agentId, deliverAtTick: 10 }],
      },
    }))).toEqual({
      channel: "evidence", epistemic: "reported", confidence: 0.9, detail: "full", knownAtTick: 13,
    });
  });

  it("第 4 行：探针提问记为 reported，置信度 0.6，无额外延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "ProbeAsked",
      principalId: "system:world",
      payload: { probeId: "p-recall-promise", agentId, askedBy: "player-1", question: "你记得什么？" },
    }))).toEqual({
      channel: "probe", epistemic: "reported", confidence: 0.6, detail: "full", knownAtTick: 10,
    });
  });

  it("第 5 行：广播消息记为 reported，置信度 0.7，按 broadcast 延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "MessageSent",
      audience: [{ kind: "public" }],
      payload: {
        messageId: "msg-000000000002", fromId: "npc-wenyuan", to: ["public"], channel: "broadcast", text: "广播内容",
        deliveries: [{ principalId: agentId, deliverAtTick: 10 }], intentKind: "inform", speechArtifactRef: null,
      },
    }))).toEqual({
      channel: "broadcast", epistemic: "reported", confidence: 0.7, detail: "full", knownAtTick: 12,
    });
  });

  it("第 6 行：传闻记为 reported，置信度 0.3，按 broadcast 延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "RumorSpread",
      principalId: "src-trader",
      audience: [{ kind: "public" }],
      payload: {
        rumorId: "rum-000000000001", sourceId: "src-trader", aboutIds: ["species-fauna"], text: "听说巡裔袭击了车队。",
      },
    }))).toEqual({
      channel: "rumor", epistemic: "reported", confidence: 0.3, detail: "full", knownAtTick: 12,
    });
  });

  it("第 7 行：官方公开通报记为 witnessed，置信度 1，按 broadcast 延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "PolicyChanged",
      audience: [{ kind: "public" }],
      payload: { key: "watergate.allocation", byId: "player-1", oldValue: "rotation", newValue: "harbor-first" },
    }))).toEqual({
      channel: "public-notice", epistemic: "witnessed", confidence: 1, detail: "full", knownAtTick: 12,
    });
  });

  it("第 8 行：自己是事件主体时记为 witnessed，置信度 1，无额外延迟", () => {
    const input = request();
    // 自己受伤：主体字段直接是自己。
    expect(channelOf(withEvent(input, {
      type: "CharacterInjured",
      audience: [{ kind: "principals", ids: [agentId] }],
      payload: { agentId, injury: "wounded", untilTick: 30 },
    }))).toEqual({
      channel: "self", epistemic: "witnessed", confidence: 1, detail: "full", knownAtTick: 10,
    });

    // 自己发出的命令产生的事件：主体经 speakerId 命中。
    expect(channelOf(withEvent(input, {
      type: "DialogueSubmitted",
      payload: {
        dialogueId: "dlg-000000000002", conversationId: "conv-000000000002", speakerId: agentId,
        audience: [agentId, "player-1"], text: "我明白了。", channel: "face-to-face",
        deliveries: [{ principalId: agentId, deliverAtTick: 10 }], replyToId: null,
      },
    }))).toMatchObject({ channel: "self" });
  });

  it("第 8 行：AgentsSummoned 点名自己时也记为 self", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "AgentsSummoned",
      audience: [{ kind: "principals", ids: [agentId] }],
      payload: { agentIds: [agentId, "human-pacifist"], reason: "council" },
    }))).toMatchObject({ channel: "self", epistemic: "witnessed", confidence: 1 });
  });

  it("第 9 行：其余 principals 受众的正式通知记为 witnessed，置信度 1，无额外延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "TaskInvitationIssued",
      audience: [{ kind: "principals", ids: [agentId] }],
      payload: {
        taskId: "tsk-000000000001", taskType: "transport", dispatcherId: "player-1", inviteeId: agentId,
        expiresAtTick: 40,
      },
    }))).toEqual({
      channel: "party", epistemic: "witnessed", confidence: 1, detail: "full", knownAtTick: 10,
    });
  });

  it("第 10 行：node 受众且自己在该节点时记为 witnessed，细度为 summary 且不含明细", () => {
    const input = request();
    const observed = withEvent(input, {
      type: "WorldFactRecorded",
      audience: [{ kind: "node", nodeId: "grayharbor" }],
      payload: { factType: "ConvoyDelayed", nodeId: "grayharbor", facts: { roadId: "r-gh-wg", delayTicks: 6 } },
    });
    // 观察者不在该节点时该行不成立，不产生观察。
    const elsewhere = perceive({
      ...observed,
      observer: { ...observed.observer, nodeId: "pass", selfNodeIds: ["pass"] },
    }, config);
    expect(elsewhere.observations).toEqual([]);

    // 明细只放在 full 上：若实现误用 full，下面的断言会读到 roadId 而失败。
    const detailedFacts = { roadId: "r-gh-wg", delayTicks: 6, cargo: { supply: 8 } };
    const result = perceive({
      ...observed,
      rendered: {
        ...observed.rendered,
        full: { ...observed.rendered.full, facts: detailedFacts },
        summary: { ...observed.rendered.summary, facts: {} },
      },
    }, config);
    expect(result.observations).toHaveLength(1);
    const [observation] = result.observations;
    expect(observation).toMatchObject({
      channel: "on-site", epistemic: "witnessed", confidence: 1, knownAtTick: 10,
    });
    const content = observation?.content as { readonly detail?: string; readonly facts?: unknown } | undefined;
    expect(content?.detail).toBe("summary");
    // 细度为 summary 时宿主只提供摘要，明细不进观察内容。
    expect(content?.facts).toEqual({});
    expect(content?.facts).not.toEqual(detailedFacts);
  });

  it("第 10 行：事件节点命中 selfNodeIds 中的非主位置时同样记为 on-site", () => {
    // 主位置是 grayharbor，但队伍同时在 pass，因此 pass 上的 node 受众事件也算亲眼所见。
    const input = request();
    const observed = withEvent(input, {
      type: "WorldFactRecorded",
      audience: [{ kind: "node", nodeId: "pass" }],
      payload: { factType: "ConvoyDelayed", nodeId: "pass" },
    });
    expect(channelOf({
      ...observed,
      observer: { ...observed.observer, nodeId: "grayharbor", selfNodeIds: ["grayharbor", "pass"] },
    })).toEqual({
      channel: "on-site", epistemic: "witnessed", confidence: 1, detail: "summary", knownAtTick: 10,
    });
  });

  it("第 11 行：派系受众记为 witnessed，置信度 1，按 briefing 延迟", () => {
    const input = request();
    expect(channelOf(withEvent(input, {
      type: "TeamMoved",
      audience: [{ kind: "faction", factionId: "human-independent" }],
      payload: { teamId: "team-commons", fromNodeId: "grayharbor", toNodeId: "pass" },
    }))).toEqual({
      channel: "briefing", epistemic: "witnessed", confidence: 1, detail: "full", knownAtTick: 14,
    });
  });
});
