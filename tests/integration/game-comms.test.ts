/**
 * 验证通信模块的开局消息、位置口径与送达延迟、证据分享、已批准对白提交，以及角色移动后的频道与剧情卡广播的投递冻结。
 * 依赖真实 SQLite、世界/通信/剧情模块、内容包与 authority；不启动网络。
 * 禁止直接调用投影或跳过中继状态。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovedSpeech, ApprovedSpeechReader, CommsWorldFacts, GameCommsPort } from "@world-prism/module-sdk";
import type { AuthContext, Json } from "@world-prism/contracts";
import { createSystemAuth } from "@world-prism/authority";
import { createCommsPort } from "@world-prism/mod-game-comms-standard";
import {
  createGameHarness,
  createMemoryTx,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
  readGameEvents,
  setGameClock,
  strategicAuth,
  withGamePorts,
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

/** 登记真人席位控制器租约，供被代发 Agent 的 speech.commit 通过 fencing。 */
function seedHumanSeat(value: GameHarness, agentId: string, controllerEpoch: number): void {
  value.storage.transact((tx) => {
    tx.branch(value.branchId)
      .table("controller_leases")
      .put({
        agent_id: agentId,
        controller_kind: "human",
        controller_principal_id: "operator-1",
        controller_epoch: controllerEpoch,
        lease_expires_at: null,
      });
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
  it("campaign.start 写入三条开局消息与开局知识", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const events = readGameEvents(value);
    const messages = events.filter((event) => event.type === "MessageSent");
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.payload).toMatchObject({ channel: "opening", intentKind: "scripted" });
      const deliveries = (message.payload as unknown as { readonly deliveries: readonly { readonly deliverAtTick: number }[] }).deliveries;
      expect(deliveries.every((delivery) => delivery.deliverAtTick === 0)).toBe(true);
    }
    expect(events.filter((event) => event.type === "KnowledgeGranted").length).toBeGreaterThan(0);
  });

  it("玩家公开广播写入 MessageSent 并按广播规则冻结投递", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const broadcast = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("broadcast.say", { text: "今晚之前把水闸条款交到议事桌。" }, value.host.ids("cmd")),
    );
    expect(broadcast.commandStatus).toBe("accepted");
    const sent = payloadOf(readGameEvents(value), "MessageSent");
    expect(sent).toMatchObject({
      fromId: "player-1",
      channel: "broadcast",
      intentKind: "none",
      to: ["public"],
    });
    const deliveries = deliveriesOf(sent);
    // 发布地在灰港：同节点的温原立即收到，异地的追风按中继正常 +1 tick。
    expect(deliveryTick(deliveries, "player-1")).toBe(0);
    expect(deliveryTick(deliveries, "npc-wenyuan")).toBe(0);
    expect(deliveryTick(deliveries, "species-fauna")).toBe(1);
    const event = readGameEvents(value).find(
      (candidate) => candidate.type === "MessageSent" && (candidate.payload as Record<string, Json>)["channel"] === "broadcast",
    );
    expect(event?.audience).toEqual([{ kind: "public" }]);
  });

  it("非玩家主体不能发行公开广播，未开局时广播被拒绝", async () => {
    const notStarted = await harness();
    const paused = notStarted.authority.commands.execute(
      playerAuth(notStarted),
      gameCommandEnvelope("broadcast.say", { text: "未开局广播" }, notStarted.host.ids("cmd")),
    );
    // 未开局时没有 campaign，处理器按无权限拒绝，且不写通信事件。
    expect(paused).toMatchObject({ commandStatus: "rejected", reasonCode: "no-authority" });

    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const system = value.authority.commands.execute(
      createSystemAuth(value.worldId, value.branchId),
      gameCommandEnvelope("broadcast.say", { text: "系统广播" }, value.host.ids("cmd")),
    );
    expect(system).toMatchObject({ commandStatus: "rejected", reasonCode: "no-authority" });
    expect(readGameEvents(value).some((event) => event.type === "MessageSent" && (event.payload as Record<string, Json>)["channel"] === "broadcast")).toBe(false);
  });

  it("公开广播不读取 Agent 批准对白", async () => {
    const value = await harness({
      approvedSpeech: {
        read: () => {
          throw new Error("公开广播不应读取 speech 批准结果");
        },
      },
    });
    expect(start(value).commandStatus).toBe("accepted");
    const broadcast = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("broadcast.say", { text: "不经过模型批准流程的广播" }, value.host.ids("cmd")),
    );
    expect(broadcast.commandStatus).toBe("accepted");
    const sent = payloadOf(readGameEvents(value), "MessageSent");
    expect(sent["speechArtifactRef"]).toBeNull();
  });

  it("广播正文超限或带额外字段在网关被拒绝且不写事件", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const tooLong = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("broadcast.say", { text: "字".repeat(301) }, value.host.ids("cmd")),
    );
    expect(tooLong).toMatchObject({ commandStatus: "rejected", reasonCode: "invalid-params" });
    const extra = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("broadcast.say", { text: "广播", audience: ["public"] } as unknown as Json, value.host.ids("cmd")),
    );
    expect(extra).toMatchObject({ commandStatus: "rejected", reasonCode: "invalid-params" });
    expect(
      readGameEvents(value).some(
        (event) => event.type === "MessageSent" && (event.payload as Record<string, Json>)["channel"] === "broadcast",
      ),
    ).toBe(false);
  });

  it("中继中断时广播只冻结发布地同节点收件者", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 0);
    const broadcast = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("broadcast.say", { text: "中继中断时的广播" }, value.host.ids("cmd")),
    );
    expect(broadcast.commandStatus).toBe("accepted");
    const sent = payloadOf(readGameEvents(value), "MessageSent");
    const deliveries = deliveriesOf(sent);
    expect(deliveries.map((delivery) => delivery.principalId)).toContain("npc-wenyuan");
    expect(deliveries.map((delivery) => delivery.principalId)).not.toContain("species-fauna");
    const event = readGameEvents(value).find(
      (candidate) => candidate.type === "MessageSent" && (candidate.payload as Record<string, Json>)["channel"] === "broadcast",
    );
    expect(event?.audience).not.toEqual([{ kind: "public" }]);
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
      gameCommandEnvelope("dialogue.say", { targetAgentId: "species-fauna", text: "隘口情况如何？" }, value.host.ids("cmd")),
    );
    expect(remote.commandStatus).toBe("accepted");
    const remotePayload = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(remotePayload).toMatchObject({ channel: "relay" });
    const remoteDeliveries = remotePayload["deliveries"] as unknown as readonly { readonly principalId: string; readonly deliverAtTick: number }[];
    expect(remoteDeliveries.find((item) => item.principalId === "species-fauna")?.deliverAtTick).toBe(0);
  });

  it("中继降级时异地对话延迟 2 tick，中断时拒绝", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 25);
    const degraded = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "species-fauna", text: "听得到吗？" }, value.host.ids("cmd")),
    );
    expect(degraded.commandStatus).toBe("accepted");
    const deliveries = payloadOf(readGameEvents(value), "DialogueSubmitted")["deliveries"] as unknown as readonly {
      readonly principalId: string;
      readonly deliverAtTick: number;
    }[];
    expect(deliveries.find((item) => item.principalId === "species-fauna")?.deliverAtTick).toBe(2);
    setRelay(value, 0);
    const down = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "species-fauna", text: "还在吗？" }, value.host.ids("cmd")),
    );
    expect(down.commandStatus).toBe("rejected");
    expect(down.reasonCode).toBe("relay-down");
  });

  it("玩家与开局 AI 党魁同在灰港时当面交谈，中继降级也不延迟", async () => {
    const speech: ApprovedSpeech = {
      text: "我的人在隘口等你的人。",
      agentId: "human-independent",
      turnId: "turn-000000000003",
      branchId: "br-000000000000",
      audience: ["species-fauna"],
      channel: "dialogue",
      approved: true,
    };
    const reader: ApprovedSpeechReader = {
      read: (ref) => (ref === "art-000000000003" ? speech : null),
    };
    const value = await harness({ approvedSpeech: reader });
    expect(start(value).commandStatus).toBe("accepted");
    const say = (text: string) =>
      value.authority.commands.execute(
        playerAuth(value),
        gameCommandEnvelope("dialogue.say", { targetAgentId: "human-independent", text }, value.host.ids("cmd")),
      );

    expect(say("岑雁，隘口的名额还在吗？").commandStatus).toBe("accepted");
    const faceToFace = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(faceToFace).toMatchObject({ channel: "face-to-face" });
    expect(deliveryTick(deliveriesOf(faceToFace), "human-independent")).toBe(0);
    expect(deliveryTick(deliveriesOf(faceToFace), "player-1")).toBe(0);

    // 中继降级只影响异地通信；无角色记录的 AI 党魁按派系驻地与玩家同在灰港，仍当面送达。
    setRelay(value, 25);
    expect(say("中继降级了，你听得到吗？").commandStatus).toBe("accepted");
    const degradedSameNode = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(degradedSameNode).toMatchObject({ channel: "face-to-face" });
    expect(deliveryTick(deliveriesOf(degradedSameNode), "human-independent")).toBe(0);

    // AI 党魁作为说话者向异地主体发言时仍按中继降级延迟 2 tick。
    const commit = value.authority.commands.execute(
      strategicAuth(value, "human-independent"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "dialogue",
          conversationId: null,
          audience: ["species-fauna"],
          approvedSpeechArtifactRef: "art-000000000003",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(commit.commandStatus).toBe("accepted");
    const relayed = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(relayed).toMatchObject({ channel: "relay", speakerId: "human-independent" });
    expect(deliveryTick(deliveriesOf(relayed), "species-fauna")).toBe(2);
    expect(deliveryTick(deliveriesOf(relayed), "human-independent")).toBe(0);

    setRelay(value, 0);
    const down = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "species-fauna", text: "喂？" }, value.host.ids("cmd")),
    );
    expect(down.commandStatus).toBe("rejected");
    expect(down.reasonCode).toBe("relay-down");
  });

  it("持有证据时才能分享，分享后受众获得知识", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const accepted = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("information.share", { evidenceId: "ev-water-ledger", audience: ["human-independent"] }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    const events = readGameEvents(value);
    expect(events.filter((event) => event.type === "InformationShared")).toHaveLength(1);
    expect(events.filter((event) => event.type === "KnowledgeGranted").length).toBeGreaterThan(1);
  });

  it("受众含不存在的主体时整条拒绝，不排送达任务，送达 tick 也不会出错", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 25);
    // 真实模型曾把角色显示名当作主体 ID 提交；旧实现受理后在送达 tick 建索引键时抛错。
    const rejected = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("information.share", { evidenceId: "ev-water-ledger", audience: ["species-fauna", "洛"] }, value.host.ids("cmd")),
    );
    expect(rejected).toMatchObject({ commandStatus: "rejected", reasonCode: "unknown-target" });
    const events = readGameEvents(value);
    expect(events.filter((event) => event.type === "InformationShared")).toHaveLength(0);
    setGameClock(value, { worldTick: 3, mode: "running" });
    expect(() => value.authority.jobs.runDue(value.branchId, 3)).not.toThrow();
    expect(readGameEvents(value).filter((event) =>
      event.type === "KnowledgeGranted" && (event.payload as { readonly via?: string }).via === "share")).toHaveLength(0);
  });

  it("异地证据分享的授权在送达 tick 才生效", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setRelay(value, 25);
    const accepted = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("information.share", { evidenceId: "ev-water-ledger", audience: ["species-fauna"] }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    const shareGrants = () =>
      readGameEvents(value).filter((event) => {
        const payload = event.payload as { readonly principalId?: string; readonly via?: string };
        return event.type === "KnowledgeGranted" && payload.principalId === "species-fauna" && payload.via === "share";
      });
    expect(shareGrants()).toHaveLength(0);
    setGameClock(value, { worldTick: 3, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 3);
    expect(shareGrants()).toHaveLength(1);
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
          audience: ["human-independent"],
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

  it("system 与真人席位复用同一批准判定：匹配时提交，未批准或主体不符时拒绝", async () => {
    const speech: ApprovedSpeech = {
      text: "系统代发的回话。",
      agentId: "npc-wenyuan",
      turnId: "turn-000000000002",
      branchId: "br-000000000000",
      audience: ["player-1"],
      channel: "message",
      approved: true,
    };
    const reader: ApprovedSpeechReader = {
      read: (ref) => {
        switch (ref) {
          case "art-000000000003":
          case "art-000000000005":
            return speech;
          case "art-000000000004":
            return { ...speech, approved: false };
          case "art-000000000006":
            return { ...speech, agentId: "npc-yinuo" };
          default:
            return null;
        }
      },
    };
    const value = await harness({ approvedSpeech: reader });
    expect(start(value).commandStatus).toBe("accepted");
    const commit = (auth: AuthContext, artifactRef: string) =>
      value.authority.commands.execute(
        auth,
        gameCommandEnvelope(
          "speech.commit",
          {
            channel: "message",
            conversationId: null,
            audience: ["player-1"],
            approvedSpeechArtifactRef: artifactRef,
            intentKind: "answer",
            replyToId: null,
          },
          value.host.ids("cmd"),
        ),
      );
    const sentWith = (artifactRef: string) =>
      readGameEvents(value).filter(
        (event) =>
          event.type === "MessageSent" &&
          (event.payload as { readonly speechArtifactRef?: string }).speechArtifactRef === artifactRef,
      );

    // system 由宿主代发：artifact 属于 npc-wenyuan，system 认证不比对 agentId。
    expect(commit(createSystemAuth(value.worldId, value.branchId), "art-000000000003").commandStatus).toBe("accepted");
    expect(sentWith("art-000000000003")).toHaveLength(1);
    expect(sentWith("art-000000000003")[0]?.payload).toMatchObject({
      fromId: "npc-wenyuan",
      text: "系统代发的回话。",
      channel: "message",
    });
    const unapproved = commit(createSystemAuth(value.worldId, value.branchId), "art-000000000004");
    expect(unapproved.commandStatus).toBe("rejected");
    expect(unapproved.reasonCode).toBe("speech-not-approved");

    // 真人席位代发按被代发 Agent 比对：匹配时提交，artifact 属于其他 Agent 时拒绝。
    seedHumanSeat(value, "npc-wenyuan", 1);
    const seat: AuthContext = {
      ...strategicAuth(value, "npc-wenyuan"),
      principalId: "operator-1",
      kind: "operator",
      roles: ["operator"],
      actingAsAgentId: "npc-wenyuan",
      controllerEpoch: 1,
    };
    expect(commit(seat, "art-000000000005").commandStatus).toBe("accepted");
    expect(sentWith("art-000000000005")).toHaveLength(1);
    const wrongAgent = commit(seat, "art-000000000006");
    expect(wrongAgent.commandStatus).toBe("rejected");
    expect(wrongAgent.reasonCode).toBe("speech-not-approved");
    expect(sentWith("art-000000000004")).toHaveLength(0);
    expect(sentWith("art-000000000006")).toHaveLength(0);
  });

  it("网关校验后处理器重新读取到不同批准结果时仍拒绝", async () => {
    const speech: ApprovedSpeech = {
      text: "不应被提交的回话。",
      agentId: "npc-wenyuan",
      turnId: "turn-000000000003",
      branchId: "br-000000000000",
      audience: ["player-1"],
      channel: "message",
      approved: true,
    };
    let reads = 0;
    const reader: ApprovedSpeechReader = {
      read: (ref) => {
        if (ref !== "art-000000000007") {
          return null;
        }
        reads += 1;
        // 第一次读取发生在网关批准校验，第二次发生在处理器内；模拟索引在两次读取间变化。
        return reads === 1 ? speech : { ...speech, approved: false };
      },
    };
    const value = await harness({ approvedSpeech: reader });
    expect(start(value).commandStatus).toBe("accepted");
    const receipt = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "message",
          conversationId: null,
          audience: ["player-1"],
          approvedSpeechArtifactRef: "art-000000000007",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("speech-not-approved");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(
      readGameEvents(value).filter(
        (event) =>
          event.type === "MessageSent" &&
          (event.payload as { readonly speechArtifactRef?: string }).speechArtifactRef === "art-000000000007",
      ),
    ).toHaveLength(0);
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
        gameCommandEnvelope("dialogue.say", { targetAgentId: "species-fauna", text }, value.host.ids("cmd")),
      );

    expect(say("隘口的名额还在吗？").commandStatus).toBe("accepted");
    const normal = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(normal).toMatchObject({ channel: "relay" });
    expect(deliveryTick(deliveriesOf(normal), "species-fauna")).toBe(3);
    expect(deliveryTick(deliveriesOf(normal), "player-1")).toBe(3);

    setRelay(value, 25);
    expect(say("中继降级了，收到回话").commandStatus).toBe("accepted");
    const degraded = payloadOf(readGameEvents(value), "DialogueSubmitted");
    expect(deliveryTick(deliveriesOf(degraded), "species-fauna")).toBe(5);

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
      audience: ["player-1", "species-fauna"],
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
          audience: ["player-1", "species-fauna"],
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
        { evidenceId: "ev-water-ledger", audience: ["npc-wenyuan", "species-fauna"] },
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
    // 17 名主体 + 署名的剧情卡来源 npc-suhui；署名来源没有位置，按异地投递。
    // 人类 AI 党魁按内容包派系驻地与玩家同在灰港，外域 Agent 按世界状态在各自领地。
    expect(normalDeliveries).toHaveLength(18);
    expect(deliveryTick(normalDeliveries, "npc-wenyuan")).toBe(6);
    expect(deliveryTick(normalDeliveries, "npc-suhui")).toBe(7);
    expect(deliveryTick(normalDeliveries, "human-independent")).toBe(6);
    expect(deliveryTick(normalDeliveries, "human-neutral")).toBe(6);
    expect(deliveryTick(normalDeliveries, "species-fauna")).toBe(7);

    const degraded = await broadcastWithRelay(25);
    const degradedDeliveries = deliveriesOf(degraded.payload);
    expect(deliveryTick(degradedDeliveries, "npc-wenyuan")).toBe(6);
    expect(deliveryTick(degradedDeliveries, "npc-suhui")).toBe(9);
    expect(deliveryTick(degradedDeliveries, "species-fauna")).toBe(9);
    expect(deliveryTick(degradedDeliveries, "human-independent")).toBe(6);

    const down = await broadcastWithRelay(0);
    expect(deliveriesOf(down.payload)).toEqual([
      { principalId: "human-alien-accord", deliverAtTick: 6 },
      { principalId: "human-earth-alliance", deliverAtTick: 6 },
      { principalId: "human-independent", deliverAtTick: 6 },
      { principalId: "human-neutral", deliverAtTick: 6 },
      { principalId: "human-pacifist", deliverAtTick: 6 },
      { principalId: "npc-ahe", deliverAtTick: 6 },
      { principalId: "npc-luchen", deliverAtTick: 6 },
      { principalId: "npc-muzhi", deliverAtTick: 6 },
      { principalId: "npc-qilu", deliverAtTick: 6 },
      { principalId: "npc-taoan", deliverAtTick: 6 },
      { principalId: "npc-wenyuan", deliverAtTick: 6 },
      { principalId: "npc-wenzhao", deliverAtTick: 6 },
      { principalId: "npc-yinuo", deliverAtTick: 6 },
      { principalId: "player-1", deliverAtTick: 6 },
    ]);
    expect(down.audience).toEqual([
      {
        kind: "principals",
        ids: [
          "human-alien-accord",
          "human-earth-alliance",
          "human-independent",
          "human-neutral",
          "human-pacifist",
          "npc-ahe",
          "npc-luchen",
          "npc-muzhi",
          "npc-qilu",
          "npc-taoan",
          "npc-wenyuan",
          "npc-wenzhao",
          "npc-yinuo",
          "player-1",
        ],
      },
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
        { evidenceId: "ev-water-ledger", audience: ["species-fauna"] },
        value.host.ids("cmd"),
      ),
    );
    expect(share.commandStatus).toBe("accepted");
    expect(share.result as { readonly shareId: string; readonly deliverAtTick: number }).toEqual({
      shareId: expect.any(String),
      deliverAtTick: 3,
    });
    const frozen = deliveriesOf(payloadOf(readGameEvents(value), "InformationShared"));
    expect(deliveryTick(frozen, "species-fauna")).toBe(3);
    expect(knowledgeJobs(value)).toHaveLength(1);
    expect(knowledgeJobs(value)[0]?.dueTick).toBe(3);

    setRelay(value, 0);
    const shareGrants = () =>
      readGameEvents(value).filter((event) => {
        const payload = event.payload as { readonly principalId?: string; readonly via?: string };
        return event.type === "KnowledgeGranted" && payload.principalId === "species-fauna" && payload.via === "share";
      });
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(shareGrants()).toHaveLength(0);
    setGameClock(value, { worldTick: 3, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 3);
    expect(shareGrants()).toHaveLength(1);
  });

  it("替换 world 只读端口后仍按指标与位置计算中继和送达", async () => {
    const value = await harness();
    const talker = {
      agentId: "npc-wenyuan",
      factionId: "human-neutral",
      nodeId: "grayharbor",
      injuredUntilTick: null,
      currentTaskId: null,
    };
    const world: CommsWorldFacts = {
      meters: () => ({
        "relay.stability": 25,
        "orchard.water": 50,
        "migration.safety": 50,
        "watergate.allocation": "harbor-first",
      }),
      character: (agentId) => (agentId === talker.agentId ? talker : null),
    };
    const port = createCommsPort(() => createMemoryTx(10), value.gameContent, value.host.ids, world);

    expect(port.relayState()).toBe("degraded");
    // 玩家由内容包声明在灰港，替换端口返回的温原也在灰港：同节点立即送达。
    expect(port.sameNode("player-1", "npc-wenyuan")).toBe(true);
    expect(port.deliverAt("dialogue", "player-1", "npc-wenyuan")).toBe(10);
    // 岑雁没有角色记录，按内容包派系驻地（灰港）与玩家同节点，不按异地延迟。
    expect(port.sameNode("player-1", "human-independent")).toBe(true);
    expect(port.deliverAt("dialogue", "player-1", "human-independent")).toBe(10);
    // 追风在内容包有角色定义，但替换端口没有返回其世界状态位置；按位置未知处理，不退回静态领地。
    expect(port.sameNode("player-1", "species-fauna")).toBe(false);
    expect(port.deliverAt("dialogue", "player-1", "species-fauna")).toBe(12);

    // AI 党魁一旦有世界状态记录（例如未来允许其移动），世界状态优先于内容包的静态驻地。
    const movedLeader = { ...talker, agentId: "human-independent", factionId: "human-independent", nodeId: "pass" };
    const movedPort = createCommsPort(() => createMemoryTx(10), value.gameContent, value.host.ids, {
      ...world,
      character: (agentId) =>
        agentId === movedLeader.agentId ? movedLeader : agentId === talker.agentId ? talker : null,
    });
    expect(movedPort.sameNode("player-1", "human-independent")).toBe(false);
    expect(movedPort.deliverAt("dialogue", "player-1", "human-independent")).toBe(12);

    // 指标由替换端口提供：缺失即按中继中断处理，不读取任何世界聚合。
    // 有角色定义但缺少世界状态记录的主体同样没有位置，中继中断时不可达。
    const down = createCommsPort(() => createMemoryTx(10), value.gameContent, value.host.ids, {
      ...world,
      meters: () => null,
    });
    expect(down.relayState()).toBe("down");
    expect(down.deliverAt("dialogue", "player-1", "species-fauna")).toBe("relay-down");
    expect(down.deliverAt("message", "player-1", "species-fauna")).toBe("relay-down");
  });

  it("分享端口返回公共结果类型中的稳定 shareId", async () => {
    const value = await harness();
    const world: CommsWorldFacts = {
      meters: () => ({
        "relay.stability": 45,
        "orchard.water": 50,
        "migration.safety": 50,
        "watergate.allocation": "harbor-first",
      }),
      character: () => null,
    };
    const port = createCommsPort(() => createMemoryTx(10), value.gameContent, value.host.ids, world);
    const share = port.postInformationShare({
      fromId: "player-1",
      evidenceId: "ev-water-ledger",
      audience: ["species-fauna"],
    });
    expect(share.shareId).toMatch(/^shr-/);
    expect(share.messageId).toBeNull();
    expect(share.deliveries).toHaveLength(2);
  });

  it("开局前缺少世界指标时中继按中断处理", async () => {
    const value = await harness();
    const port = createCommsPort(
      () => createMemoryTx(),
      value.gameContent,
      value.host.ids,
      { meters: () => null, character: () => null },
    );
    expect(port.relayState()).toBe("down");
    expect(port.deliverAt("dialogue", "player-1", "species-fauna")).toBe("relay-down");
    expect(port.sameNode("player-1", "npc-wenyuan")).toBe(false);

    const say = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text: "喂？" }, value.host.ids("cmd")),
    );
    expect(say.commandStatus).toBe("rejected");
    expect(say.reasonCode).toBe("relay-down");
    expect(readGameEvents(value).filter((event) => event.type === "DialogueSubmitted")).toHaveLength(0);
  });

  it("会话聚合只存参与者与序号，对白按行聚合存放并可按会话读取", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    for (const text of ["第一句", "第二句", "第三句"]) {
      expect(
        value.authority.commands.execute(
          playerAuth(value),
          gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text }, value.host.ids("cmd")),
        ).commandStatus,
      ).toBe("accepted");
    }
    const conversationIds = withGamePorts(value, (ports) => ports["game.comms"].conversationsOf("player-1"));
    expect(conversationIds).toHaveLength(3);
    const firstConversationId = conversationIds[0] as string;

    // 会话聚合不再嵌入对白正文；对白按补零序号成为可前缀索引的行聚合。
    const conversation = readGameAggregate(value, "conversation", firstConversationId) as Record<string, unknown>;
    expect(conversation).toMatchObject({ participants: ["player-1", "npc-wenyuan"], lastSeq: 1 });
    expect(conversation["lines"]).toBeUndefined();
    const lineIds = value.storage.transact((tx) =>
      tx.branch(value.branchId)
        .table("aggregate_state")
        .list({ aggregate_type: "conversation-line" })
        .map((row) => String(row["aggregate_id"])),
    );
    expect(lineIds).toEqual(conversationIds.map((id) => `${id}:0000000000`));
    const membershipIds = value.storage.transact((tx) =>
      tx.branch(value.branchId)
        .table("aggregate_state")
        .list({ aggregate_type: "conversation-membership" })
        .map((row) => String(row["aggregate_id"])),
    );
    expect(membershipIds).toEqual([
      ...conversationIds.map((id) => `npc-wenyuan:${id}`),
      ...conversationIds.map((id) => `player-1:${id}`),
    ]);

    withGamePorts(value, (ports) => {
      const lines = ports["game.comms"].conversationMessages(firstConversationId, 50);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ seq: 0, speakerId: "player-1", text: "第一句", channel: "face-to-face" });
      expect(ports["game.comms"].conversationMessages("conv-missing", 50)).toEqual([]);
    });
  });

  it("收件箱按送达顺序取最近窗口，未送达消息不返回", async () => {
    const value = await harness();
    const wenyuan = {
      agentId: "npc-wenyuan",
      factionId: "human-neutral",
      nodeId: "grayharbor",
      injuredUntilTick: null,
      currentTaskId: null,
    };
    const fauna = {
      agentId: "species-fauna",
      factionId: "species-fauna",
      nodeId: "pass",
      injuredUntilTick: null,
      currentTaskId: null,
    };
    const world: CommsWorldFacts = {
      meters: () => ({
        "relay.stability": 25,
        "orchard.water": 50,
        "migration.safety": 50,
        "watergate.allocation": "harbor-first",
      }),
      character: (agentId) => (agentId === wenyuan.agentId ? wenyuan : agentId === fauna.agentId ? fauna : null),
    };
    const base = createMemoryTx(10);
    let tick = 10;
    const port = createCommsPort(() => ({ ...base, worldTick: tick }), value.gameContent, value.host.ids, world);
    const post = (fromId: string, text: string) =>
      port.postMessage({ fromId, to: ["player-1"], text, channel: "message", intentKind: "scripted" });

    // 追风在隘口：降级中继下该消息送达 tick 为 13，当刻尚未送达。
    port.postMessage({ fromId: "species-fauna", to: ["player-1"], text: "异地未送达", channel: "message", intentKind: "scripted" });
    post("npc-wenyuan", "甲");
    tick = 11;
    post("npc-wenyuan", "乙");
    tick = 12;
    post("npc-wenyuan", "丙");
    tick = 13;
    post("npc-wenyuan", "丁");
    tick = 14;
    post("npc-wenyuan", "戊");

    // 送达 tick 10：只有甲已送达，异地消息不进入收件箱。
    tick = 10;
    const atTen = port.messagesFor("player-1", 50);
    expect(atTen.map((message) => message.text)).toEqual(["甲"]);
    expect(atTen[0]).toMatchObject({ deliverAtTick: 10, committedAtTick: 10 });

    // 送达 tick 13：异地消息送达，窗口按 (送达 tick, 提交 tick, 消息 ID) 升序。
    tick = 13;
    expect(port.messagesFor("player-1", 50).map((message) => message.text)).toEqual([
      "甲",
      "乙",
      "丙",
      "异地未送达",
      "丁",
    ]);

    // 最近 3 条 = 戊(14)、丁(13)、异地(13)：同送达 tick 按提交 tick 决先后。
    tick = 14;
    expect(port.messagesFor("player-1", 3).map((message) => message.text)).toEqual(["异地未送达", "丁", "戊"]);

    // 同一 (送达 tick, 提交 tick) 组内按消息 ID 决先后：投递索引的二进制序与端口原实现的
    // localeCompare 序一致（运行 ID 为小写 base32，两种比较器同序）。
    post("npc-wenyuan", "己");
    post("npc-wenyuan", "庚");
    post("npc-wenyuan", "辛");
    const messages = port.messagesFor("player-1", 50);
    expect(messages.map((message) => message.messageId)).toEqual(
      [...messages]
        .sort(
          (left, right) =>
            left.deliverAtTick - right.deliverAtTick ||
            left.committedAtTick - right.committedAtTick ||
            left.messageId.localeCompare(right.messageId),
        )
        .map((message) => message.messageId),
    );
  });

  it("收件箱上界在世界 tick 边界不溢出排序键", async () => {
    const value = await harness();
    const wenyuan = {
      agentId: "npc-wenyuan",
      factionId: "human-neutral",
      nodeId: "grayharbor",
      injuredUntilTick: null,
      currentTaskId: null,
    };
    const world: CommsWorldFacts = {
      meters: () => ({
        "relay.stability": 80,
        "orchard.water": 50,
        "migration.safety": 50,
        "watergate.allocation": "harbor-first",
      }),
      character: (agentId) => (agentId === wenyuan.agentId ? wenyuan : null),
    };
    const base = createMemoryTx(0);
    let tick = 9999999999;
    const port = createCommsPort(() => ({ ...base, worldTick: tick }), value.gameContent, value.host.ids, world);
    port.postMessage({ fromId: "npc-wenyuan", to: ["player-1"], text: "边界", channel: "message", intentKind: "scripted" });
    // 送达 tick 恰为排序键宽度的最大值：上界构造不得因 tick 加一溢出而失败。
    expect(port.messagesFor("player-1", 10).map((message) => message.text)).toEqual(["边界"]);
  });

  it("负的世界 tick 在构造索引键时被拒绝，不写出顺序错乱的键", async () => {
    const value = await harness();
    const wenyuan = {
      agentId: "npc-wenyuan",
      factionId: "human-neutral",
      nodeId: "grayharbor",
      injuredUntilTick: null,
      currentTaskId: null,
    };
    const world: CommsWorldFacts = {
      meters: () => ({
        "relay.stability": 80,
        "orchard.water": 50,
        "migration.safety": 50,
        "watergate.allocation": "harbor-first",
      }),
      character: (agentId) => (agentId === wenyuan.agentId ? wenyuan : null),
    };
    // 负 tick 补零后符号位落在末尾（如 00000000-3），字典序与数值序不再一致，必须拒绝。
    const negative = createCommsPort(() => ({ ...createMemoryTx(0), worldTick: -3 }), value.gameContent, value.host.ids, world);
    expect(() => negative.postMessage({
      fromId: "npc-wenyuan", to: ["player-1"], text: "负数", channel: "message", intentKind: "scripted",
    })).toThrow(/非负安全整数/);
  });

  it("知识授权按聚合主键去重，holds 与 knowledgeOf 按主体前缀读取", async () => {
    const value = await harness();
    const base = createMemoryTx(7);
    const port = createCommsPort(() => base, value.gameContent, value.host.ids, {
      meters: () => null,
      character: () => null,
    });

    // 同一 (主体, 条目, 途径) 的授权是 O(1) 主键去重：重复授予返回同一 grantId。
    const first = port.grantKnowledge({ principalId: "player-1", itemId: "ev-1", via: "start" });
    const duplicate = port.grantKnowledge({ principalId: "player-1", itemId: "ev-1", via: "start" });
    expect(duplicate.grantId).toBe(first.grantId);

    // 不同途径是不同授权。
    const otherVia = port.grantKnowledge({ principalId: "player-1", itemId: "ev-1", via: "discovery" });
    expect(otherVia.grantId).not.toBe(first.grantId);

    // holds 只认当前主体的持有事实。
    expect(port.holds("player-1", "ev-1")).toBe(true);
    expect(port.holds("player-2", "ev-1")).toBe(false);
    expect(port.holds("player-1", "ev-missing")).toBe(false);

    // 其他主体的授权不进入 player-1 的前缀查询；knowledgeOf 按 (授予 tick, 条目) 排序。
    port.grantKnowledge({ principalId: "npc-wenyuan", itemId: "ev-1", via: "start" });
    port.grantKnowledge({ principalId: "player-1", itemId: "ev-0", via: "share", grantedAtTick: 3 });
    expect(port.knowledgeOf("player-1").map((knowledge) => `${knowledge.itemId}:${knowledge.via}`)).toEqual([
      "ev-0:share",
      "ev-1:discovery",
      "ev-1:start",
    ]);
    expect(port.knowledgeOf("npc-wenyuan").map((knowledge) => knowledge.itemId)).toEqual(["ev-1"]);
  });

  it("索引键组件在写入期拒绝冒号与非可打印 ASCII", async () => {
    const value = await harness();
    const wenyuan = {
      agentId: "npc-wenyuan",
      factionId: "human-neutral",
      nodeId: "grayharbor",
      injuredUntilTick: null,
      currentTaskId: null,
    };
    const world: CommsWorldFacts = {
      meters: () => ({
        "relay.stability": 80,
        "orchard.water": 50,
        "migration.safety": 50,
        "watergate.allocation": "harbor-first",
      }),
      character: (agentId) => (agentId === wenyuan.agentId ? wenyuan : null),
    };
    // 每个断言用独立事务：键校验失败时该次调用的其他键写入不参与后续断言。
    const reject = (run: (port: GameCommsPort) => unknown): void => {
      const port = createCommsPort(() => createMemoryTx(3), value.gameContent, value.host.ids, world);
      expect(() => run(port)).toThrow(/索引键/);
    };

    // 授权键（主体:条目:途径）的组件违规在写入时失败，而不是留下无法按前缀查询的键。
    reject((port) => port.grantKnowledge({ principalId: "player:1", itemId: "ev-1", via: "start" }));
    reject((port) => port.grantKnowledge({ principalId: "玩家", itemId: "ev-1", via: "start" }));
    reject((port) => port.grantKnowledge({ principalId: "player-1", itemId: "ev:1", via: "start" }));

    // 会话成员键同样拒绝：对白追加先写键组件，中继正常时才会到达该校验。
    reject((port) =>
      port.postDialogue({
        speakerId: "player:1",
        audience: ["npc-wenyuan"],
        text: "你好",
        channel: "dialogue",
        channelKind: "face-to-face",
        conversationId: null,
        replyToId: null,
      }),
    );
    reject((port) =>
      port.postDialogue({
        speakerId: "player-1",
        audience: ["npc:wenyuan"],
        text: "你好",
        channel: "dialogue",
        channelKind: "face-to-face",
        conversationId: null,
        replyToId: null,
      }),
    );
  });
});
