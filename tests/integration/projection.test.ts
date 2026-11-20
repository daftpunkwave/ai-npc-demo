/**
 * 验证玩家投影的字段来源、空投影与受众裁剪。
 * 依赖真实 SQLite、世界/地图/通信/资源/行动/协议/剧情模块、内容包与 authority；
 * 开局、任务、协议与通信都经真实命令与 job 推进，再在单个只读事务内绑定端口构建投影。
 * 禁止直接改写聚合，或用静态样例替代真实投影构建。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PlayerProjection } from "@ai-npc/contracts";
import type { ApprovedSpeechReader } from "@ai-npc/module-sdk";
import { buildPlayerProjection } from "@ai-npc/app-server";
import {
  createGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  playerAuth,
  readGameClock,
  setGameClock,
  startNeutralCampaign,
  strategicAuth,
  withGamePorts,
  type GameHarness,
} from "./game-support";
import {
  acceptAgreement,
  acceptTaskInvitation,
  advanceTicks,
  advanceTo,
  dispatchTask,
  PARTIAL_SUPPLY_TRANSPORT,
  proposeAgreement,
  proposeAsPlayer,
} from "./game-agreement-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

async function harness(options: Parameters<typeof createGameHarness>[0] = {}): Promise<GameHarness> {
  const value = await createGameHarness(options);
  active.push(value);
  return value;
}

/** 在宿主同样的只读作用域内构建投影；玩家显示名取内容包 locale。 */
function projection(
  value: GameHarness,
  options: { readonly awaitingReplyCharacters?: readonly string[] } = {},
): PlayerProjection {
  const clock = readGameClock(value);
  return withGamePorts(value, (ports) =>
    buildPlayerProjection({
      content: value.gameContent,
      clock,
      world: ports["game.world"],
      map: ports["game.map"],
      comms: ports["game.comms"],
      resources: ports["game.resources"],
      actions: ports["game.actions"],
      agreements: ports["game.agreements"],
      playerName: value.content.locale.playerName,
      ...(options.awaitingReplyCharacters === undefined
        ? {}
        : { awaitingReplyCharacters: options.awaitingReplyCharacters }),
    }),
  );
}

/** 从内容包取一条证据条目的正文，供断言投影只给玩家可见文本。 */
function evidenceBody(value: GameHarness, evidenceId: string): string {
  const evidence = value.gameContent.evidence.get(evidenceId);
  if (evidence === undefined) {
    throw new Error(`内容包缺少证据 ${evidenceId}`);
  }
  return evidence.content;
}

describe("玩家投影", () => {
  it("开局前投影合法且为空", async () => {
    const value = await harness();
    const view = projection(value);

    expect(view.campaign).toBeNull();
    expect(view.meters).toBeNull();
    expect(view.clock).toMatchObject({ worldTick: 0, day: 1, hour: 0 });
    expect(view.map.nodes.length).toBeGreaterThan(0);
    expect(view.map.roads.length).toBeGreaterThan(0);
    expect(view.stockpiles).toEqual([]);
    expect(view.teams).toEqual([]);
    expect(view.characters).toEqual([]);
    expect(view.tasks).toEqual([]);
    expect(view.agreements).toEqual([]);
    expect(view.invitations).toEqual([]);
    expect(view.conversations).toEqual([]);
    expect(view.inbox).toEqual([]);
    expect(view.notebook).toEqual([]);
    expect(view.awaitingReplyFrom).toEqual([]);
    expect(view.notifications).toEqual([]);
  });

  it("开局后给出 campaign、指标、库存等级与委托余额、队伍与角色", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const view = projection(value);

    expect(view.campaign).toMatchObject({
      factionId: "human-neutral",
      factionName: "灰港公社",
      status: "running",
      outcome: null,
      startTick: 0,
    });
    expect(view.clock).toMatchObject({ worldTick: 0, day: 1, hour: 0, mode: "running" });
    expect(view.map.nodes.map((node) => node.nodeId)).toEqual(
      expect.arrayContaining(["grayharbor", "orchard", "pass"]),
    );
    expect(view.map.roads.find((road) => road.roadId === "r-gh-ps")).toMatchObject({
      fromNodeId: "grayharbor",
      toNodeId: "pass",
      travelTicks: 6,
      risk: 1,
      status: "open",
    });
    expect(view.meters).toEqual({
      relayStability: { value: 45, level: "stable" },
      orchardWater: { value: 50, level: "stable" },
      migrationSafety: { value: 50, level: "stable" },
      watergateAllocation: "harbor-first",
    });

    // 玩家受委托的库存点给出精确数量与委托余额，其余库存点只有等级。
    expect(view.stockpiles.find((stockpile) => stockpile.stockpileId === "sp-commons")).toEqual({
      stockpileId: "sp-commons",
      nodeId: "grayharbor",
      ownerFactionId: "human-neutral",
      supplyLevel: "adequate",
      energyLevel: "adequate",
      medicalLevel: "adequate",
      amounts: { supply: 60, energy: 12, medical: 8 },
      delegation: { remaining: { supply: 15, energy: 6, medical: 4 }, untilTick: 168 },
    });
    expect(view.stockpiles.find((stockpile) => stockpile.stockpileId === "sp-rubble")).toMatchObject({
      nodeId: "pass",
      ownerFactionId: "human-independent",
      supplyLevel: "adequate",
      amounts: null,
      delegation: null,
    });

    expect(view.teams.find((team) => team.teamId === "team-commons")).toEqual({
      teamId: "team-commons",
      nodeId: "grayharbor",
      ownerFactionId: "human-neutral",
      status: "idle",
      delegatedToMe: true,
    });
    expect(view.teams.find((team) => team.teamId === "team-rubble")?.delegatedToMe).toBe(false);

    expect(view.characters.find((character) => character.agentId === "npc-wenyuan")).toEqual({
      agentId: "npc-wenyuan",
      name: "温原",
      factionId: "human-neutral",
      role: "物资官 / 库房",
      nodeId: "grayharbor",
      injured: false,
      injuredUntilTick: null,
      publicClaim: "公平透明",
    });
    expect(view.characters.find((character) => character.agentId === "species-extraterrestrial")?.publicClaim).toBe("精确");
  });

  it("自己的任务给出完整信息，其他队伍只给在途摘要，完成后状态与伤情正确", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const ownTaskId = dispatchTask(value, playerAuth(value), PARTIAL_SUPPLY_TRANSPORT);
    const otherTaskId = dispatchTask(value, strategicAuth(value, "species-extraterrestrial"), {
      taskType: "transport",
      teamId: "team-star",
      invitees: ["species-extraterrestrial"],
      departAfterTicks: 4,
      params: {
        fromStockpileId: "sp-star",
        toStockpileId: "sp-flora",
        cargo: { supply: 0, energy: 1, medical: 0 },
      },
    });
    acceptTaskInvitation(value, "species-extraterrestrial", otherTaskId);

    const pending = projection(value).tasks.find((task) => task.taskId === ownTaskId);
    expect(pending).toEqual({
      kind: "own",
      taskId: ownTaskId,
      taskType: "transport",
      teamId: "team-commons",
      participants: [],
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        cargo: { supply: 5, energy: 0, medical: 0 },
      },
      commandStatus: "accepted",
      taskStatus: "pending",
      departTick: 1,
      nominalCompletionTick: 7,
      delayNoticeSent: false,
      route: null,
    });
    expect(projection(value).tasks.some((task) => task.kind === "other")).toBe(false);

    advanceTo(value, 1);
    expect(projection(value).tasks.find((task) => task.taskId === ownTaskId)).toMatchObject({
      taskStatus: "running",
      departTick: 1,
    });

    // 其他派系的任务在途时只暴露队伍与路线，不暴露任务类型、参数与参与者。
    advanceTo(value, 4);
    const summary = projection(value).tasks.find((task) => task.kind === "other");
    expect(summary).toEqual({
      kind: "other",
      taskId: null,
      taskType: null,
      teamId: "team-star",
      participants: [],
      params: null,
      commandStatus: null,
      taskStatus: null,
      departTick: null,
      nominalCompletionTick: null,
      delayNoticeSent: false,
      route: ["r-or-an"],
    });

    advanceTo(value, 7);
    expect(projection(value).tasks.find((task) => task.taskId === ownTaskId)).toMatchObject({
      taskStatus: "completed",
      departTick: 1,
      nominalCompletionTick: 7,
      delayNoticeSent: false,
    });

    // 该运输在 r-or-an 上抽样出 2 tick 延误与洛受伤：完成 tick 13，伤到 61。
    advanceTo(value, 13);
    expect(projection(value).tasks.some((task) => task.kind === "other")).toBe(false);
    expect(projection(value).characters.find((character) => character.agentId === "species-extraterrestrial")).toMatchObject({
      injured: true,
      injuredUntilTick: 61,
    });

    advanceTo(value, 61);
    expect(projection(value).characters.find((character) => character.agentId === "species-extraterrestrial")).toMatchObject({
      injured: false,
      injuredUntilTick: null,
    });
  });

  it("协议履约后条款状态与进度正确", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const agreementId = proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
      {
        kind: "deliver",
        obligorId: "player-1",
        resource: "supply",
        amount: 5,
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        byTick: 20,
      },
    ]);
    dispatchTask(value, playerAuth(value), PARTIAL_SUPPLY_TRANSPORT);
    advanceTicks(value, 1, 7, { consumers: true });

    const agreement = projection(value).agreements.find((candidate) => candidate.agreementId === agreementId);
    expect(agreement).toEqual({
      agreementId,
      version: 1,
      proposerId: "player-1",
      parties: ["player-1", "human-neutral"],
      terms: [
        {
          term: {
            kind: "deliver",
            obligorId: "player-1",
            resource: "supply",
            amount: 5,
            fromStockpileId: "sp-commons",
            toStockpileId: "sp-earth",
            byTick: 20,
          },
          status: "fulfilled",
          progress: 0,
        },
      ],
      status: "fulfilled",
      expiresAtTick: 24,
      supersedesId: null,
    });
  });

  it("对话、收件箱与笔记按受众与送达 tick 生成，延迟消息到期前不出现", async () => {
    const speeches: Record<string, import("@ai-npc/module-sdk").ApprovedSpeech> = {
      "art-000000000101": {
        text: "清单在仓里第三排。",
        agentId: "npc-wenyuan",
        turnId: "turn-000000000101",
        branchId: "br-000000000000",
        audience: ["player-1"],
        channel: "dialogue",
        approved: true,
      },
      "art-000000000102": {
        text: "隘口暂时安全，我晚点再确认。",
        agentId: "species-fauna",
        turnId: "turn-000000000102",
        branchId: "br-000000000000",
        audience: ["player-1"],
        channel: "message",
        approved: true,
      },
    };
    const reader: ApprovedSpeechReader = { read: (ref) => speeches[ref] ?? null };
    const value = await harness({ approvedSpeech: reader });
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");

    const say = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text: "物资清单在哪里？" }, value.host.ids("cmd")),
    );
    expect(say.commandStatus).toBe("accepted");
    const conversationId = (say.result as { readonly conversationId: string }).conversationId;

    // 玩家说完最后一句时，只有仍在排队 turn 的角色进入待回复列表。
    expect(projection(value, { awaitingReplyCharacters: ["npc-wenyuan", "species-fauna"] })).toMatchObject({
      awaitingReplyFrom: ["npc-wenyuan"],
    });

    const reply = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "dialogue",
          conversationId,
          audience: ["player-1"],
          approvedSpeechArtifactRef: "art-000000000101",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(reply.commandStatus).toBe("accepted");
    const committed = value.authority.commands.execute(
      strategicAuth(value, "species-fauna"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "message",
          conversationId: null,
          audience: ["player-1"],
          approvedSpeechArtifactRef: "art-000000000102",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(committed.commandStatus).toBe("accepted");

    const view = projection(value, { awaitingReplyCharacters: ["npc-wenyuan"] });
    expect(view.awaitingReplyFrom).toEqual([]);
    expect(view.conversations).toEqual([
      {
        seq: 0,
        dialogueId: expect.stringMatching(/^dlg-/),
        speakerId: "player-1",
        speakerName: value.content.locale.playerName,
        text: "物资清单在哪里？",
        worldTick: 0,
        channel: "face-to-face",
      },
      {
        seq: 1,
        dialogueId: expect.stringMatching(/^dlg-/),
        speakerId: "npc-wenyuan",
        speakerName: "温原",
        text: "清单在仓里第三排。",
        worldTick: 0,
        channel: "face-to-face",
      },
    ]);
    // 开局消息进入收件箱；异地消息按规则 +1 tick 送达，到期前不出现。
    expect(view.inbox.map((item) => item.text)).toEqual([
      "仓里的供给每天都在少，我需要知道哪些承诺是真的。",
      "最近消息很多，没核实的我不会往外发。",
      "党魁，第一周的议程我先列了三项；t144 之前你得凑够三票。",
    ]);
    expect(view.inbox.every((item) => item.kind === "message" && item.sourceId !== "player-1")).toBe(true);
    expect(view.inbox.map((item) => item.text)).not.toContain("隘口暂时安全，我晚点再确认。");

    setGameClock(value, { worldTick: 1, mode: "running" });
    const delivered = projection(value);
    const message = delivered.inbox.find((item) => item.text === "隘口暂时安全，我晚点再确认。");
    expect(message).toEqual({ kind: "message", sourceId: "species-fauna", text: "隘口暂时安全，我晚点再确认。", worldTick: 1 });

    const notebook = delivered.notebook;
    expect(notebook).toHaveLength(1);
    expect(notebook[0]).toEqual({
      kind: "evidence",
      evidenceId: "ev-water-ledger",
      title: "水闸历年分水账",
      body: evidenceBody(value, "ev-water-ledger"),
      source: "start",
    });
  });

  it("提醒按协议状态派生：收到提案与 24 tick 内到期", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const agreementId = proposeAgreement(value, strategicAuth(value, "human-neutral"), ["player-1", "human-neutral"], [
      { kind: "escort", obligorId: "human-neutral", roadId: "r-gh-ps", byTick: 10 },
    ]);
    const proposed = projection(value).notifications;
    expect(proposed.filter((item) => item.kind === "invite")).toHaveLength(1);
    expect(proposed.find((item) => item.kind === "invite")?.text.length).toBeGreaterThan(0);
    expect(proposed.some((item) => item.kind === "deadline")).toBe(false);

    acceptAgreement(value, playerAuth(value), agreementId);
    const activeView = projection(value).notifications;
    expect(activeView.some((item) => item.kind === "invite")).toBe(false);
    expect(activeView.filter((item) => item.kind === "deadline")).toHaveLength(1);
  });

  it("其他主体的私密对话与消息、秘密正文、未触发剧情卡与风险抽样都不出现", async () => {
    const privateSpeeches: Record<string, import("@ai-npc/module-sdk").ApprovedSpeech> = {
      "art-000000000201": {
        text: "别把水路的事告诉外人。",
        agentId: "species-fauna",
        turnId: "turn-000000000201",
        branchId: "br-000000000000",
        audience: ["npc-wenyuan"],
        channel: "dialogue",
        approved: true,
      },
      "art-000000000202": {
        text: "账本我先留着，晚点再谈。",
        agentId: "npc-wenyuan",
        turnId: "turn-000000000202",
        branchId: "br-000000000000",
        audience: ["species-fauna"],
        channel: "message",
        approved: true,
      },
    };
    const reader: ApprovedSpeechReader = { read: (ref) => privateSpeeches[ref] ?? null };
    const value = await harness({ approvedSpeech: reader });
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    for (const artifactRef of ["art-000000000201", "art-000000000202"] as const) {
      const speech = privateSpeeches[artifactRef];
      if (speech === undefined) {
        throw new Error("缺少私密对白样例");
      }
      const commit = value.authority.commands.execute(
        strategicAuth(value, speech.agentId),
        gameCommandEnvelope(
          "speech.commit",
          {
            channel: speech.channel,
            conversationId: null,
            audience: [...speech.audience],
            approvedSpeechArtifactRef: artifactRef,
            intentKind: "answer",
            replyToId: null,
          },
          value.host.ids("cmd"),
        ),
      );
      expect(commit.commandStatus).toBe("accepted");
    }
    dispatchTask(value, strategicAuth(value, "species-extraterrestrial"), {
      taskType: "transport",
      teamId: "team-star",
      invitees: ["species-extraterrestrial"],
      departAfterTicks: 4,
      params: {
        fromStockpileId: "sp-star",
        toStockpileId: "sp-flora",
        cargo: { supply: 0, energy: 1, medical: 0 },
      },
    });
    // 触发 tick 2 的剧情卡尚未发布，投影里不能出现它的广播文本。
    expect(JSON.stringify(projection(value))).not.toContain("中继读数持续下降");
    advanceTo(value, 4);

    const view = projection(value);
    const serialized = JSON.stringify(view);
    expect(view.conversations).toEqual([]);
    expect(serialized).not.toContain("别把水路的事告诉外人。");
    expect(serialized).not.toContain("账本我先留着，晚点再谈。");
    expect(serialized).not.toContain("返航锚点");
    expect(serialized).not.toContain("sec-star-urgency");
    expect(serialized).not.toContain("card-relay-alarm");
    expect(serialized).not.toContain("riskOutcome");
    expect(serialized).not.toContain("delayTicks");
    expect(serialized).not.toContain("injuredAgentIds");
  });
});

describe("提醒与收件箱的内容边界", () => {
  it("未发布的剧情卡在触发 tick 前不出现，触发后以公开广播出现在收件箱", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const before = projection(value).inbox.map((item) => item.text);
    expect(before).not.toContain("中继读数持续下降。照现在的分水方式，几天后远程通信就会变慢。修一次需要能源 10、供给 5。");

    advanceTo(value, 2);
    const after = projection(value).inbox.find(
      (item) => item.text.startsWith("中继读数持续下降"),
    );
    expect(after).toMatchObject({ kind: "broadcast", sourceId: "npc-shenli", worldTick: 2 });
  });

  it("传闻在消费者处理后以 rumor 进入收件箱并标出来源", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    advanceTo(value, 50);
    value.authority.consumers.run(value.branchId);
    const rumor = projection(value).inbox.find((item) => item.kind === "rumor");
    expect(rumor).toEqual({
      kind: "rumor",
      sourceId: "src-trader",
      text: "听说昨夜巡裔在隘口附近袭击了补给车队。",
      worldTick: 50,
    });
  });
});
