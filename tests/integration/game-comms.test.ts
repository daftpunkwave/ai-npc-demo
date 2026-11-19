/**
 * 验证通信模块的开局消息、送达延迟、证据分享、已批准对白提交，以及角色移动后的频道与剧情卡广播的投递冻结。
 * 依赖真实 SQLite、世界/通信/剧情模块、内容包与 authority；不启动网络。
 * 禁止直接调用投影或跳过中继状态。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovedSpeech, ApprovedSpeechReader } from "@ai-npc/module-sdk";
import type { Json } from "@ai-npc/contracts";
import { createCommsPort } from "@ai-npc/mod-game-comms-standard";
import {
  createGameHarness,
  createMemoryTx,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
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

type DeliveryList = readonly { readonly principalId: string; readonly deliverAtTick: number }[];

/** 读取通信事件 payload 中冻结的投递名单。 */
function deliveriesOf(payload: Record<string, Json>): DeliveryList {
  return payload["deliveries"] as unknown as DeliveryList;
}

/** 读取某个主体在冻结投递名单中的送达 tick。 */
function deliveryTick(deliveries: DeliveryList, principalId: string): number | undefined {
  return deliveries.find((delivery) => delivery.principalId === principalId)?.deliverAtTick;
}

/** 读取指定发布者的公开广播事件，用于断言剧情卡广播的投递与受众。 */
function broadcastFrom(
  events: ReturnType<typeof readGameEvents>,
  fromId: string,
): { readonly payload: Record<string, Json>; readonly audience: Json } {
  const event = events.find((candidate) => {
    const payload = candidate.payload as Record<string, Json>;
    return candidate.type === "MessageSent" && payload["channel"] === "broadcast" && payload["fromId"] === fromId;
  });
  if (event === undefined) {
    throw new Error(`没有找到来自 ${fromId} 的广播`);
  }
  return { payload: event.payload as Record<string, Json>, audience: event.audience };
}

/** 读取分支中已安排的通信知识投递 job，用于断言延迟授权按冻结名单调度。 */
function knowledgeJobs(value: GameHarness): readonly { readonly idempotencyKey: string; readonly dueTick: number }[] {
  return value.storage
    .transact((tx) =>
      tx
        .branch(value.branchId)
        .table("jobs")
        .list({})
        .map((row) => ({
          idempotencyKey: String(row["idempotency_key"]),
          dueTick: Number(row["due_tick"]),
        })),
    )
    .filter((job) => job.idempotencyKey.startsWith("knowledge-delivery:"));
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

  it("角色随任务移动后，同一对话从当面变为中继并按中继状态延迟", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const say = (text: string) =>
      value.authority.commands.execute(
        playerAuth(value),
        gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text }, value.host.ids("cmd")),
      );

    expect(say("先对一下物资清单").commandStatus).toBe("accepted");
    const faceToFace = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(faceToFace).toMatchObject({ channel: "face-to-face" });
    expect(deliveriesOf(faceToFace).every((delivery) => delivery.deliverAtTick === 0)).toBe(true);

    // 用真实运输任务把温原从灰港送到果园：出发 tick 2，含货行程 6 tick，完成 tick 8。
    const dispatch = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "task.dispatch",
        {
          taskType: "transport",
          teamId: "team-commons",
          invitees: ["npc-wenyuan"],
          params: { fromStockpileId: "sp-commons", toStockpileId: "sp-earth", cargo: { supply: 1, energy: 0, medical: 0 } },
        },
        value.host.ids("cmd"),
      ),
    );
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    expect(
      value.authority.commands.execute(
        strategicAuth(value, "npc-wenyuan"),
        gameCommandEnvelope("task.respond", { taskId, response: "accept" }, value.host.ids("cmd")),
      ).commandStatus,
    ).toBe("accepted");
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    setGameClock(value, { worldTick: 8, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 8);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed" });
    expect(readGameAggregate(value, "character", "npc-wenyuan")).toMatchObject({ nodeId: "orchard" });

    expect(say("你到果园了？").commandStatus).toBe("accepted");
    const relayed = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(relayed).toMatchObject({ channel: "relay" });
    expect(deliveryTick(deliveriesOf(relayed), "npc-wenyuan")).toBe(8);

    setRelay(value, 25);
    expect(say("中继不稳，再确认一次").commandStatus).toBe("accepted");
    const degraded = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(degraded).toMatchObject({ channel: "relay" });
    expect(deliveryTick(deliveriesOf(degraded), "npc-wenyuan")).toBe(10);
  });

  it("中继正常、降级与中断决定异地对话的送达 tick 与拒绝", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 3, mode: "running" });
    const say = (text: string) =>
      value.authority.commands.execute(
        playerAuth(value),
        gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-cenyan", text }, value.host.ids("cmd")),
      );

    expect(say("隘口的名额还在吗？").commandStatus).toBe("accepted");
    const normal = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(normal).toMatchObject({ channel: "relay" });
    expect(deliveryTick(deliveriesOf(normal), "npc-cenyan")).toBe(3);
    expect(deliveryTick(deliveriesOf(normal), "player-1")).toBe(3);

    setRelay(value, 25);
    expect(say("中继降级了，收到回话").commandStatus).toBe("accepted");
    const degraded = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(deliveryTick(deliveriesOf(degraded), "npc-cenyan")).toBe(5);

    setRelay(value, 0);
    const dialogueCount = () => readGameEvents(value).filter((event) => event.type === "DialogueSubmitted").length;
    const before = dialogueCount();
    const down = say("听得到吗？");
    expect(down.commandStatus).toBe("rejected");
    expect(down.reasonCode).toBe("relay-down");
    expect(dialogueCount()).toBe(before);
  });

  it("中继中断时混合受众的定向消息与证据分享整条拒绝", async () => {
    const speech: ApprovedSpeech = {
      text: "清单和隘口的事一起说。",
      agentId: "npc-wenyuan",
      turnId: "turn-000000000002",
      branchId: "br-000000000000",
      audience: ["player-1", "npc-cenyan"],
      channel: "message",
      approved: true,
    };
    const reader: ApprovedSpeechReader = {
      read: (ref) => (ref === "art-000000000002" ? speech : null),
    };
    const value = await harness({ approvedSpeech: reader });
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 0);

    const messagesBefore = readGameEvents(value).filter((event) => event.type === "MessageSent").length;
    const commit = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "message",
          conversationId: null,
          audience: ["player-1", "npc-cenyan"],
          approvedSpeechArtifactRef: "art-000000000002",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(commit.commandStatus).toBe("rejected");
    expect(commit.reasonCode).toBe("relay-down");
    expect(readGameEvents(value).filter((event) => event.type === "MessageSent")).toHaveLength(messagesBefore);

    const share = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "information.share",
        { evidenceId: "ev-water-ledger", audience: ["npc-wenyuan", "npc-cenyan"] },
        value.host.ids("cmd"),
      ),
    );
    expect(share.commandStatus).toBe("rejected");
    expect(share.reasonCode).toBe("relay-down");
    expect(readGameEvents(value).filter((event) => event.type === "InformationShared")).toHaveLength(0);
    expect(
      readGameEvents(value).filter(
        (event) => event.type === "KnowledgeGranted" && (event.payload as { readonly via?: string }).via === "share",
      ),
    ).toHaveLength(0);
    expect(knowledgeJobs(value)).toHaveLength(0);
  });

  it("剧情卡广播从 grayharbor 发布：中断只留同节点，正常 +1，降级 +3", async () => {
    const broadcastWithRelay = async (
      relay: number,
    ): Promise<{ readonly payload: Record<string, Json>; readonly audience: Json }> => {
      const value = await harness();
      expect(start(value).commandStatus).toBe("accepted");
      setGameClock(value, { worldTick: 6, mode: "running" });
      setRelay(value, relay);
      value.authority.jobs.runDue(value.branchId, 6);
      return broadcastFrom(readGameEvents(value), "npc-suhui");
    };

    const normal = await broadcastWithRelay(45);
    const normalDeliveries = deliveriesOf(normal.payload);
    expect(normal.audience).toEqual([{ kind: "public" }]);
    expect(normalDeliveries).toHaveLength(21);
    expect(deliveryTick(normalDeliveries, "npc-wenyuan")).toBe(6);
    expect(deliveryTick(normalDeliveries, "npc-suhui")).toBe(7);
    expect(deliveryTick(normalDeliveries, "npc-cenyan")).toBe(7);
    expect(deliveryTick(normalDeliveries, "human-neutral")).toBe(7);

    const degraded = await broadcastWithRelay(25);
    const degradedDeliveries = deliveriesOf(degraded.payload);
    expect(deliveryTick(degradedDeliveries, "npc-wenyuan")).toBe(6);
    expect(deliveryTick(degradedDeliveries, "npc-suhui")).toBe(9);
    expect(deliveryTick(degradedDeliveries, "species-fauna")).toBe(9);

    const down = await broadcastWithRelay(0);
    expect(deliveriesOf(down.payload)).toEqual([
      { principalId: "npc-shenli", deliverAtTick: 6 },
      { principalId: "npc-tangzhen", deliverAtTick: 6 },
      { principalId: "npc-wenyuan", deliverAtTick: 6 },
      { principalId: "npc-yinuo", deliverAtTick: 6 },
      { principalId: "player-1", deliverAtTick: 6 },
    ]);
    expect(down.audience).toEqual([
      { kind: "principals", ids: ["npc-shenli", "npc-tangzhen", "npc-wenyuan", "npc-yinuo", "player-1"] },
    ]);
  });

  it("证据分享按冻结投递延迟授权，随后中继中断也不重算", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 25);
    const share = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "information.share",
        { evidenceId: "ev-water-ledger", audience: ["npc-cenyan"] },
        value.host.ids("cmd"),
      ),
    );
    expect(share.commandStatus).toBe("accepted");
    const frozen = deliveriesOf(payloadOf(readGameEvents(value), "InformationShared"));
    expect(deliveryTick(frozen, "npc-cenyan")).toBe(3);
    expect(knowledgeJobs(value)).toHaveLength(1);
    expect(knowledgeJobs(value)[0]?.dueTick).toBe(3);

    setRelay(value, 0);
    const shareGrants = () =>
      readGameEvents(value).filter((event) => {
        const payload = event.payload as { readonly principalId?: string; readonly via?: string };
        return event.type === "KnowledgeGranted" && payload.principalId === "npc-cenyan" && payload.via === "share";
      });
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(shareGrants()).toHaveLength(0);
    setGameClock(value, { worldTick: 3, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 3);
    expect(shareGrants()).toHaveLength(1);
  });

  it("开局前缺少世界指标时中继按中断处理", async () => {
    const value = await harness();
    const port = createCommsPort(() => createMemoryTx(), value.gameContent, value.host.ids);
    expect(port.relayState()).toBe("down");
    expect(port.deliverAt("dialogue", "player-1", "npc-cenyan")).toBe("relay-down");
    expect(port.sameNode("player-1", "npc-wenyuan")).toBe(false);

    const say = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-cenyan", text: "喂？" }, value.host.ids("cmd")),
    );
    expect(say.commandStatus).toBe("rejected");
    expect(say.reasonCode).toBe("relay-down");
    expect(readGameEvents(value).filter((event) => event.type === "DialogueSubmitted")).toHaveLength(0);
  });
});
