/**
 * 验证玩家投影、Agent 世界视图及其子结构。
 * 依赖公共契约包的 projection 主题导出。
 * 禁止把未授权内容塞入样例；样例只覆盖契约允许的可见字段。
 */
import { describe, expect, it } from "vitest";
import {
  agentEvidenceViewSchema,
  agentFactionViewSchema,
  agentLastKnownViewSchema,
  agentSecretViewSchema,
  agentSelfViewSchema,
  agentStaticMapViewSchema,
  agentWorldViewSchema,
  agreementStatusSchema,
  agreementTermStatusSchema,
  agreementTermViewSchema,
  agreementViewSchema,
  campaignOutcomeSchema,
  campaignStatusSchema,
  campaignViewSchema,
  characterViewSchema,
  clockModeSchema,
  clockViewSchema,
  conversationLineSchema,
  delegationBalanceSchema,
  inboxItemViewSchema,
  invitationViewSchema,
  knownAllocationSchema,
  knownNumberSchema,
  mapNodeViewSchema,
  mapRoadViewSchema,
  meterDisplayLevelSchema,
  meterReadingSchema,
  notebookEntryViewSchema,
  playerMapViewSchema,
  playerMetersViewSchema,
  playerNotificationViewSchema,
  playerProjectionSchema,
  playerTaskViewSchema,
  startOptionSchema,
  stockpileViewSchema,
  teamStatusSchema,
  teamViewSchema,
} from "../src/index";
import { expectInvalid, expectValid } from "./support";

const taskId = "task-k3j9x0a1b2c3";
const agreementId = "agr-k3j9x0a1b2c3";

const transportParams = {
  fromStockpileId: "sp-commons",
  toStockpileId: "sp-earth",
  cargo: { supply: 10, energy: 0, medical: 0 },
};

const ownTask = {
  kind: "own",
  taskId,
  taskType: "transport",
  teamId: "team-commons",
  participants: ["npc-wenyuan"],
  params: transportParams,
  commandStatus: "accepted",
  taskStatus: "pending",
  departTick: 1,
  nominalCompletionTick: 7,
  delayNoticeSent: false,
  route: null,
};

const otherTask = {
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
  route: ["r-gh-an"],
};

const agreement = {
  agreementId,
  version: 1,
  proposerId: "player-1",
  parties: ["player-1", "human-neutral"],
  terms: [
    {
      term: { kind: "escort", obligorId: "player-1", roadId: "r-gh-ps", byTick: 48 },
      status: "open",
      progress: null,
    },
  ],
  status: "proposed",
  expiresAtTick: 24,
  supersedesId: null,
};

const playerProjection = {
  campaign: {
    campaignId: "cmp-k3j9x0a1b2c3",
    factionId: "human-neutral",
    factionName: "灰港公社",
    commission: "整理物资与消息。",
    status: "running",
    outcome: null,
    startTick: 0,
  },
  clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
  map: {
    nodes: [{ nodeId: "grayharbor", name: "灰港中继站", x: 12, y: 12, facilities: ["relay"] }],
    roads: [
      {
        roadId: "r-gh-or",
        fromNodeId: "grayharbor",
        toNodeId: "orchard",
        travelTicks: 5,
        risk: 0,
        status: "open",
      },
    ],
  },
  meters: {
    relayStability: { value: 45, level: "stable" },
    orchardWater: { value: 50, level: "stable" },
    migrationSafety: { value: 50, level: "stable" },
    watergateAllocation: "harbor-first",
  },
  stockpiles: [
    {
      stockpileId: "sp-commons",
      nodeId: "grayharbor",
      ownerFactionId: "human-neutral",
      supplyLevel: "adequate",
      energyLevel: "adequate",
      medicalLevel: "adequate",
      amounts: { supply: 60, energy: 12, medical: 8 },
      delegation: { remaining: { supply: 15, energy: 6, medical: 4 }, untilTick: 168 },
    },
  ],
  teams: [
    {
      teamId: "team-commons",
      nodeId: "grayharbor",
      ownerFactionId: "human-neutral",
      status: "idle",
      delegatedToMe: true,
    },
  ],
  characters: [
    {
      agentId: "npc-wenyuan",
      name: "温原",
      factionId: "human-neutral",
      role: "物资官",
      nodeId: "grayharbor",
      injured: false,
      injuredUntilTick: null,
      publicClaim: "公平透明",
    },
  ],
  tasks: [ownTask, otherTask],
  agreements: [agreement],
  invitations: [
    {
      invitationId: "inv-k3j9x0a1b2c3",
      taskId,
      inviteeId: "player-1",
      taskType: "transport",
      departTick: 2,
      response: null,
    },
  ],
  conversations: [
    {
      seq: 0,
      dialogueId: "dlg-k3j9x0a1b2c3",
      speakerId: "npc-cenyan",
      speakerName: "岑雁",
      text: "你好",
      worldTick: 0,
      channel: "face-to-face",
    },
  ],
  inbox: [{ kind: "message", sourceId: "npc-wenyuan", text: "仓里的供给每天都在少。", worldTick: 0 }],
  notebook: [
    {
      kind: "evidence",
      evidenceId: "ev-flood-log",
      title: "运输队延误记录",
      body: "补给车队因旧堤渗水改道。",
      source: "archive",
    },
    { kind: "witnessed", eventId: "evt-k3j9x0a1b2c3", summaryZh: "任务已完成。", worldTick: 3 },
  ],
  awaitingReplyFrom: ["npc-cenyan"],
  notifications: [{ kind: "urgent", text: "有新的委托", worldTick: 0 }],
};

const agentWorldView = {
  self: {
    agentId: "npc-cenyan",
    kind: "character",
    nodeId: "pass",
    injured: false,
    injuredUntilTick: null,
    currentTaskId: null,
    delegations: [
      {
        delegationId: "del-k3j9x0a1b2c3",
        grantorFactionId: "human-independent",
        teamIds: ["team-rubble"],
        stockpileId: "sp-rubble",
        maxDraw: { supply: 10, energy: 4, medical: 2 },
        remaining: { supply: 10, energy: 4, medical: 2 },
        untilTick: 168,
      },
    ],
    invitations: [],
    agreements: [],
    recentAgreements: [agreement],
  },
  staticMap: {
    nodes: [{ nodeId: "pass", name: "迁徙隘口", x: 4, y: 8, facilities: ["outpost"] }],
    roads: [
      {
        roadId: "r-gh-ps",
        fromNodeId: "grayharbor",
        toNodeId: "pass",
        travelTicks: 6,
        risk: 1,
      },
    ],
  },
  lastKnown: {
    relayStability: { value: 45, asOfTick: 0 },
    orchardWater: null,
    migrationSafety: null,
    watergateAllocation: { value: "harbor-first", asOfTick: 0 },
    roads: [{ roadId: "r-gh-ps", status: "open", asOfTick: 0 }],
    stockpiles: [
      {
        stockpileId: "sp-rubble",
        supplyLevel: "stable",
        energyLevel: "stable",
        medicalLevel: "stable",
        asOfTick: 0,
      },
    ],
  },
  faction: {
    factionId: "human-independent",
    strategicAgentId: "human-independent",
    characterIds: ["npc-cenyan"],
    stockpiles: [
      {
        stockpileId: "sp-rubble",
        amounts: { supply: 30, energy: 10, medical: 4 },
        asOfTick: 0,
      },
    ],
    teams: [{ teamId: "team-rubble", status: "idle", asOfTick: 0 }],
  },
  evidence: [{ evidenceId: "ev-flood-log", title: "运输队延误记录", body: "补给车队改道。" }],
  secrets: [{ secretId: "sec-fauna-ridge-route", body: "备用路线走山脊道。", shareable: false }],
};

describe("PlayerProjection", () => {
  it("接受完整玩家投影", () => {
    expectValid(playerProjectionSchema, playerProjection);
  });

  it("开局前允许没有世界指标", () => {
    expectValid(playerProjectionSchema, { ...playerProjection, meters: null });
  });

  it("库存等级使用资源等级而不是指标展示等级", () => {
    expectInvalid(playerProjectionSchema, {
      ...playerProjection,
      stockpiles: [{ ...playerProjection.stockpiles[0], supplyLevel: "stable" }],
    });
  });

  it("拒绝非法字段与多余字段", () => {
    expectInvalid(playerProjectionSchema, {
      ...playerProjection,
      campaign: { ...playerProjection.campaign, status: "paused" },
    });
    expectInvalid(playerProjectionSchema, {
      ...playerProjection,
      meters: { ...playerProjection.meters, relayStability: { value: 45, level: "ok" } },
    });
    expectInvalid(playerProjectionSchema, { ...playerProjection, extra: true });
  });

  it("任务参数必须与 taskType 匹配，其他任务不暴露参数", () => {
    expectInvalid(playerTaskViewSchema, { ...ownTask, params: { nodeId: "pass" } });
    expectInvalid(playerTaskViewSchema, { ...otherTask, taskId });
    expectInvalid(playerTaskViewSchema, { ...ownTask, route: ["r-gh-or"] });
    expectValid(playerTaskViewSchema, otherTask);
  });
});

describe("AgentWorldView", () => {
  it("接受完整世界视图", () => {
    expectValid(agentWorldViewSchema, agentWorldView);
  });

  it("拒绝未知状态、负水位与多余字段", () => {
    expectInvalid(agentWorldViewSchema, {
      ...agentWorldView,
      self: { ...agentWorldView.self, kind: "npc" },
    });
    expectInvalid(agentWorldViewSchema, {
      ...agentWorldView,
      lastKnown: {
        ...agentWorldView.lastKnown,
        relayStability: { value: 45, asOfTick: -1 },
      },
    });
    expectInvalid(agentWorldViewSchema, { ...agentWorldView, extra: true });
  });
});

describe("投影子结构", () => {
  it.each([
    [clockViewSchema, playerProjection.clock],
    [campaignViewSchema, playerProjection.campaign],
    [startOptionSchema, { factionId: "human-neutral", name: "灰港公社", commission: "调停", contacts: [] }],
    [conversationLineSchema, playerProjection.conversations[0]],
    [playerMapViewSchema, playerProjection.map],
    [mapNodeViewSchema, playerProjection.map.nodes[0]],
    [mapRoadViewSchema, playerProjection.map.roads[0]],
    [meterReadingSchema, playerProjection.meters.relayStability],
    [playerMetersViewSchema, playerProjection.meters],
    [stockpileViewSchema, playerProjection.stockpiles[0]],
    [delegationBalanceSchema, playerProjection.stockpiles[0].delegation],
    [teamViewSchema, playerProjection.teams[0]],
    [characterViewSchema, playerProjection.characters[0]],
    [agreementTermViewSchema, agreement.terms[0]],
    [agreementViewSchema, agreement],
    [invitationViewSchema, playerProjection.invitations[0]],
    [inboxItemViewSchema, playerProjection.inbox[0]],
    [notebookEntryViewSchema, playerProjection.notebook[0]],
    [playerNotificationViewSchema, playerProjection.notifications[0]],
    [knownNumberSchema, agentWorldView.lastKnown.relayStability],
    [knownAllocationSchema, agentWorldView.lastKnown.watergateAllocation],
    [agentSelfViewSchema, agentWorldView.self],
    [agentStaticMapViewSchema, agentWorldView.staticMap],
    [agentLastKnownViewSchema, agentWorldView.lastKnown],
    [agentFactionViewSchema, agentWorldView.faction],
    [agentEvidenceViewSchema, agentWorldView.evidence[0]],
    [agentSecretViewSchema, agentWorldView.secrets[0]],
  ])("子结构拒绝多余字段", (schema, value) => {
    expectValid(schema, value);
    expectInvalid(schema, { ...(value as object), __unexpectedField: true });
    expectInvalid(schema, null);
  });

  it("投影枚举逐项覆盖并拒绝未知值", () => {
    const expectedValues: ReadonlyArray<readonly [typeof clockModeSchema | typeof campaignStatusSchema | typeof campaignOutcomeSchema | typeof meterDisplayLevelSchema | typeof teamStatusSchema | typeof agreementStatusSchema | typeof agreementTermStatusSchema, readonly string[]]> = [
      [clockModeSchema, ["running", "pausing", "paused", "resuming", "stepping"]],
      [campaignStatusSchema, ["running", "evaluated"]],
      [campaignOutcomeSchema, ["equilibrium", "strained"]],
      [meterDisplayLevelSchema, ["critical", "strained", "stable"]],
      [teamStatusSchema, ["idle", "assigned", "traveling", "working", "recovering"]],
      [agreementStatusSchema, ["proposed", "active", "fulfilled", "rejected", "expired", "superseded", "breached"]],
      [agreementTermStatusSchema, ["open", "fulfilled", "breached"]],
    ];
    for (const [schema, values] of expectedValues) {
      for (const value of values) {
        expect(schema.safeParse(value).success).toBe(true);
      }
      expect(schema.safeParse("unknown-value").success).toBe(false);
    }
  });
});
