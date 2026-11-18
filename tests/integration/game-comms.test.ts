/**
 * 验证通信模块的开局消息、送达延迟、证据分享与已批准对白提交。
 * 依赖真实 SQLite、世界/通信模块、内容包与 authority；不启动网络。
 * 禁止直接调用投影或跳过中继状态。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovedSpeech, ApprovedSpeechReader } from "@ai-npc/module-sdk";
import type { Json } from "@ai-npc/contracts";
import {
  createGameHarness,
  gameCommandEnvelope,
  playerAuth,
  readGameEvents,
  setGameClock,
  strategicAuth,
  type GameHarness,
} from "./game-support";
const active: GameHarness[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (harness) => harness.dispose()));
});

async function harness(options: { readonly approvedSpeech?: ApprovedSpeechReader } = {}): Promise<GameHarness> {
  const created = await createGameHarness(options);
  active.push(created);
  return created;
}

function start(value: GameHarness): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return value.authority.commands.execute(
    playerAuth(value),
    gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd")),
  );
}

function setRelay(value: GameHarness, relay: number): void {
  value.storage.transact((tx) => {
    const table = tx.branch(value.branchId).table("aggregate_state");
    const row = table.get({ aggregate_type: "meters", aggregate_id: "meters" });
    if (row === null) {
      throw new Error("测试缺少 meters 聚合");
    }
    const state = row["state_json"] as Record<string, Json>;
    state["relay.stability"] = relay;
    table.put({ ...row, state_json: state, version: Number(row["version"]) + 1 });
  });
}

function payloadOf(events: ReturnType<typeof readGameEvents>, type: string): Record<string, Json> {
  const event = [...events].reverse().find((candidate) => candidate.type === type);
  if (event === undefined) {
    throw new Error(`没有找到事件 ${type}`);
  }
  return event.payload as Record<string, Json>;
}

describe("通信", () => {
  it("campaign.start 写入两条开局消息与开局知识", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const events = readGameEvents(value);
    const messages = events.filter((event) => event.type === "MessageSent");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.payload).toMatchObject({ channel: "opening", intentKind: "scripted" });
      const deliveries = (message.payload as unknown as { readonly deliveries: readonly { readonly deliverAtTick: number }[] }).deliveries;
      expect(deliveries.every((delivery) => delivery.deliverAtTick === 0)).toBe(true);
    }
    expect(events.filter((event) => event.type === "KnowledgeGranted").length).toBeGreaterThan(0);
  });

  it("同节点对话立即送达，异地对话在中继正常时立即送达", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const local = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text: "物资清单在哪里？" }, value.host.ids("cmd")),
    );
    expect(local.commandStatus).toBe("accepted");
    const localPayload = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(localPayload).toMatchObject({
      speakerId: "player-1",
      text: "物资清单在哪里？",
      channel: "face-to-face",
    });
    expect((localPayload["deliveries"] as unknown as readonly { readonly principalId: string; readonly deliverAtTick: number }[]).every((item) => item.deliverAtTick === 0)).toBe(true);

    const remote = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-cenyan", text: "隘口情况如何？" }, value.host.ids("cmd")),
    );
    expect(remote.commandStatus).toBe("accepted");
    const remotePayload = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(remotePayload).toMatchObject({ channel: "relay" });
    const remoteDeliveries = remotePayload["deliveries"] as unknown as readonly { readonly principalId: string; readonly deliverAtTick: number }[];
    expect(remoteDeliveries.find((item) => item.principalId === "npc-cenyan")?.deliverAtTick).toBe(0);
  });

  it("中继降级时异地对话延迟 2 tick，中断时拒绝", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 25);
    const degraded = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-cenyan", text: "听得到吗？" }, value.host.ids("cmd")),
    );
    expect(degraded.commandStatus).toBe("accepted");
    const deliveries = payloadOf(readGameEvents(value), "DialogueSubmitted")["deliveries"] as unknown as readonly {
      readonly principalId: string;
      readonly deliverAtTick: number;
    }[];
    expect(deliveries.find((item) => item.principalId === "npc-cenyan")?.deliverAtTick).toBe(2);
    setRelay(value, 0);
    const down = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-cenyan", text: "还在吗？" }, value.host.ids("cmd")),
    );
    expect(down.commandStatus).toBe("rejected");
    expect(down.reasonCode).toBe("relay-down");
  });

  it("持有证据时才能分享，分享后受众获得知识", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const accepted = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("information.share", { evidenceId: "ev-water-ledger", audience: ["npc-cenyan"] }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    const events = readGameEvents(value);
    expect(events.filter((event) => event.type === "InformationShared")).toHaveLength(1);
    expect(events.filter((event) => event.type === "KnowledgeGranted").length).toBeGreaterThan(1);
  });

  it("异地证据分享的授权在送达 tick 才生效", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 25);
    const accepted = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("information.share", { evidenceId: "ev-water-ledger", audience: ["npc-cenyan"] }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    const before = readGameEvents(value).filter((event) => event.type === "KnowledgeGranted");
    expect(before.some((event) => (event.payload as { readonly principalId?: string }).principalId === "npc-cenyan")).toBe(false);
    setGameClock(value, { worldTick: 3, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 3);
    const after = readGameEvents(value).filter((event) => event.type === "KnowledgeGranted");
    expect(after.some((event) => (event.payload as { readonly principalId?: string }).principalId === "npc-cenyan")).toBe(true);
  });

  it("已批准对白以消息提交，受众不匹配时拒绝", async () => {
    const speech: ApprovedSpeech = {
      text: "我会核对清单。",
      agentId: "npc-wenyuan",
      turnId: "turn-000000000001",
      branchId: "br-000000000000",
      audience: ["player-1"],
      channel: "message",
      approved: true,
    };
    const reader: ApprovedSpeechReader = {
      read: (ref) => (ref === "art-000000000001" ? speech : null),
    };
    const value = await harness({ approvedSpeech: reader });
    expect(start(value).commandStatus).toBe("accepted");
    const accepted = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "message",
          conversationId: null,
          audience: ["player-1"],
          approvedSpeechArtifactRef: "art-000000000001",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(accepted.commandStatus).toBe("accepted");
    const invalid = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "message",
          conversationId: null,
          audience: ["npc-cenyan"],
          approvedSpeechArtifactRef: "art-000000000001",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(invalid.commandStatus).toBe("rejected");
    expect(invalid.reasonCode).toBe("speech-not-approved");
  });
});
