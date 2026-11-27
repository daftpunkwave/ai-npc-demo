/**
 * 验证领域事件目录、payload 登记表与每个事件 payload schema。
 * 依赖公共契约包的 events 主题导出。
 * 禁止在此执行事件处理；每个 payload 只使用固定 JSON 样例。
 */
import { describe, expect, it } from "vitest";
import {
  comparePrincipalIds,
  deliveryListSchema,
  deliverySchema,
  domainEventPayloadSchemas,
  domainEventTypeSchema,
  domainEventTypes,
  getDomainEventPayloadSchema,
  scoutReportSchema,
  taskEffectSchema,
} from "../src/index";
import { expectInvalid, expectSchema, expectValid } from "./support";

/** 59 种领域事件，固定顺序用于目录完整性断言。 */
const expectedEventTypes = [
  "CampaignStarted",
  "DelegationCreated",
  "KnowledgeGranted",
  "MessageSent",
  "DialogueSubmitted",
  "InformationShared",
  "RumorSpread",
  "WorldFactRecorded",
  "AgentsSummoned",
  "ProbeAsked",
  "AgreementProposed",
  "AgreementResponded",
  "AgreementActivated",
  "AgreementRejected",
  "AgreementExpired",
  "AgreementSuperseded",
  "AgreementTermFulfilled",
  "AgreementFulfilled",
  "AgreementBreached",
  "PassageGranted",
  "PolicyChanged",
  "TaskDispatched",
  "ResourcesReserved",
  "ResourcesReleased",
  "TaskInvitationIssued",
  "TaskInvitationAnswered",
  "TaskInvitationExpired",
  "TaskDeparted",
  "TaskDelayed",
  "TaskCompleted",
  "TaskFailed",
  "TaskCancelled",
  "ResourcesTransferred",
  "ResourcesConsumed",
  "StockpileAdjusted",
  "CharacterMoved",
  "TeamMoved",
  "CharacterInjured",
  "CharacterRecovered",
  "TeamRecovered",
  "EvidenceDiscovered",
  "ScoutReported",
  "GroupRescued",
  "GroupWorsened",
  "MetersChanged",
  "RelayDegraded",
  "RelayDown",
  "RelayRestored",
  "OrchardCrisis",
  "OrchardDamaged",
  "MigrationCrisis",
  "SupplyShortage",
  "DayPassed",
  "ScenarioCardTriggered",
  "ScenarioCardPublished",
  "ScenarioCardWithdrawn",
  "ScenarioCompensationApplied",
  "ScenarioOverrideApplied",
  "ChapterStageEvaluated",
] as const;

type EventType = (typeof expectedEventTypes)[number];

const taskId = "task-k3j9x0a1b2c3";
const agreementId = "agr-k3j9x0a1b2c3";
const invitationId = "inv-k3j9x0a1b2c3";
const evidenceId = "ev-flood-log";
const groupId = "grp-injured-migrants";

const escortTerm = { kind: "escort", obligorId: "player-1", roadId: "r-gh-ps", byTick: 48 };

const openings = [
  { principalId: "npc-wenyuan", deliverAtTick: 0 },
  { principalId: "player-1", deliverAtTick: 0 },
];

const meters = {
  "relay.stability": 42,
  "orchard.water": 41,
  "migration.safety": 50,
  "watergate.allocation": "harbor-first",
};

const changes = [{ meter: "relay.stability", from: 45, to: 42, cause: "daily" }];

/** 59 种事件的合法 payload，键必须与目录一一对应。 */
const validPayloads: Record<EventType, unknown> = {
  CampaignStarted: { campaignId: "cmp-k3j9x0a1b2c3", factionId: "human-neutral", playerId: "player-1" },
  DelegationCreated: {
    delegationId: "del-k3j9x0a1b2c3",
    grantorFactionId: "human-neutral",
    granteeId: "npc-wenyuan",
    teamIds: ["team-commons"],
    stockpileId: "sp-commons",
    maxDraw: { supply: 15, energy: 6, medical: 4 },
    untilTick: 168,
  },
  KnowledgeGranted: {
    grantId: "kg-k3j9x0a1b2c3",
    principalId: "player-1",
    itemId: evidenceId,
    via: "start",
  },
  MessageSent: {
    messageId: "msg-k3j9x0a1b2c3",
    fromId: "npc-wenyuan",
    to: ["player-1"],
    channel: "opening",
    text: "仓里的供给每天都在少。",
    deliveries: openings,
    intentKind: "scripted",
    speechArtifactRef: null,
  },
  DialogueSubmitted: {
    dialogueId: "dlg-k3j9x0a1b2c3",
    conversationId: "conv-k3j9x0a1b2c3",
    speakerId: "player-1",
    audience: ["npc-cenyan"],
    text: "你好",
    channel: "face-to-face",
    deliveries: [
      { principalId: "npc-cenyan", deliverAtTick: 0 },
      { principalId: "player-1", deliverAtTick: 0 },
    ],
    replyToId: null,
  },
  InformationShared: {
    shareId: "shr-k3j9x0a1b2c3",
    fromId: "player-1",
    evidenceId,
    audience: ["npc-cenyan"],
    deliveries: [
      { principalId: "npc-cenyan", deliverAtTick: 1 },
      { principalId: "player-1", deliverAtTick: 0 },
    ],
  },
  RumorSpread: {
    rumorId: "rum-k3j9x0a1b2c3",
    sourceId: "src-trader",
    aboutIds: ["species-fauna"],
    text: "听说巡裔袭击了补给车队。",
  },
  WorldFactRecorded: { factId: "fact-k3j9x0a1b2c3", factType: "ConvoyDelayed", payload: { text: "延误 6 小时" } },
  AgentsSummoned: {
    agentIds: ["human-neutral", "species-fauna"],
    reason: "council",
    cardId: "card-council",
  },
  ProbeAsked: {
    probeId: "p-recall-promise",
    agentId: "npc-cenyan",
    askedBy: "system:world",
    question: "你还记得上次的承诺吗？",
  },
  AgreementProposed: {
    agreementId,
    version: 1,
    proposerId: "player-1",
    parties: ["player-1", "human-neutral"],
    terms: [escortTerm],
    expiresAtTick: 24,
    supersedesId: null,
  },
  AgreementResponded: { agreementId, partyId: "human-neutral", response: "accept" },
  AgreementActivated: {
    agreementId,
    version: 1,
    parties: ["player-1", "human-neutral"],
    terms: [escortTerm],
  },
  AgreementRejected: { agreementId, byId: "human-neutral" },
  AgreementExpired: { agreementId, byId: null },
  AgreementSuperseded: { agreementId, byId: "human-neutral" },
  AgreementTermFulfilled: {
    agreementId,
    termIndex: 0,
    obligorId: "player-1",
    term: escortTerm,
    evidenceEventIds: ["evt-k3j9x0a1b2c3"],
  },
  AgreementFulfilled: { agreementId },
  AgreementBreached: { agreementId, termIndex: 0, obligorId: "player-1", term: escortTerm },
  PassageGranted: {
    grantId: "pg-k3j9x0a1b2c3",
    roadId: "r-gh-an",
    granteeFactionId: "human-alien-accord",
    untilTick: 100,
  },
  PolicyChanged: {
    key: "watergate.allocation",
    oldValue: "harbor-first",
    newValue: "rotation",
    byId: "human-neutral",
  },
  TaskDispatched: {
    taskId,
    taskType: "transport",
    teamId: "team-commons",
    dispatcherId: "player-1",
    invitees: [],
    params: {
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      cargo: { supply: 10, energy: 0, medical: 0 },
    },
    departTick: 1,
  },
  ResourcesReserved: {
    stockpileId: "sp-commons",
    delta: { supply: 10, energy: 0, medical: 0 },
    taskId,
  },
  ResourcesReleased: {
    stockpileId: "sp-commons",
    delta: { supply: 10, energy: 0, medical: 0 },
    taskId,
  },
  TaskInvitationIssued: {
    invitationId,
    taskId,
    inviteeId: "npc-wenyuan",
    taskType: "transport",
    departTick: 2,
  },
  TaskInvitationAnswered: {
    invitationId,
    taskId,
    inviteeId: "npc-wenyuan",
    response: "accept",
    reasonCode: null,
  },
  TaskInvitationExpired: {
    invitationId,
    taskId,
    inviteeId: "npc-wenyuan",
    response: null,
    reasonCode: null,
  },
  TaskDeparted: {
    taskId,
    participants: ["npc-wenyuan"],
    route: ["r-gh-or"],
    nominalCompletionTick: 7,
  },
  TaskDelayed: { taskId, newCompletionTick: 9, cause: "road-risk" },
  TaskCompleted: {
    taskId,
    taskType: "transport",
    completedAtTick: 7,
    effects: [{ kind: "transport" }],
  },
  TaskFailed: { taskId, reasonCode: "route-closed" },
  TaskCancelled: { taskId, byId: "player-1" },
  ResourcesTransferred: {
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    delta: { supply: 10, energy: 0, medical: 0 },
    taskId,
    dispatcherId: "player-1",
  },
  ResourcesConsumed: {
    stockpileId: "sp-truce",
    delta: { supply: 0, energy: 0, medical: 6 },
    reason: "救援消耗",
    taskId,
  },
  StockpileAdjusted: { stockpileId: "sp-commons", delta: { supply: -10 }, reason: "仓储受潮" },
  CharacterMoved: { id: "npc-cenyan", fromNodeId: "pass", toNodeId: "grayharbor" },
  TeamMoved: { id: "team-commons", fromNodeId: "grayharbor", toNodeId: "orchard" },
  CharacterInjured: { agentId: "npc-cenyan", untilTick: 96, cause: "road-risk" },
  CharacterRecovered: { agentId: "npc-cenyan", untilTick: 96, cause: "road-risk" },
  TeamRecovered: { teamId: "team-commons" },
  EvidenceDiscovered: { evidenceId, discoveredBy: "npc-guxun", taskId },
  ScoutReported: {
    taskId,
    nodeId: "pass",
    report: {
      roads: [{ roadId: "r-gh-ps", status: "open" }],
      characterIds: ["npc-cenyan"],
      groups: [{ groupId, status: "waiting" }],
    },
  },
  GroupRescued: { groupId, taskId, dispatcherId: "player-1" },
  GroupWorsened: { groupId },
  MetersChanged: { changes },
  RelayDegraded: { value: 25 },
  RelayDown: { value: 0 },
  RelayRestored: { value: 30 },
  OrchardCrisis: { value: 20 },
  OrchardDamaged: { value: 0 },
  MigrationCrisis: { value: 20 },
  SupplyShortage: { value: 0 },
  DayPassed: { day: 1, meters, consumption: { supply: 6, energy: 0, medical: 0 }, changes },
  ScenarioCardTriggered: { cardId: "card-relay-alarm", version: 1, note: "" },
  ScenarioCardPublished: { cardId: "card-relay-alarm", version: 1, note: "已发布" },
  ScenarioCardWithdrawn: { cardId: "card-relay-alarm", version: 1, note: "已撤回" },
  ScenarioCompensationApplied: { cardId: "card-relay-alarm", version: 1, note: "补偿" },
  ScenarioOverrideApplied: { cardId: null, version: null, note: "调试覆盖" },
  ChapterStageEvaluated: {
    outcome: "equilibrium",
    meters,
    unmet: [],
    fulfilledCount: 2,
    breachedCount: 0,
  },
};

describe("领域事件目录", () => {
  it("类型全集与固定目录一致", () => {
    expect([...domainEventTypes]).toEqual([...expectedEventTypes]);
    for (const type of expectedEventTypes) {
      expect(domainEventTypeSchema.safeParse(type).success).toBe(true);
      expect(getDomainEventPayloadSchema(type)).toBeDefined();
    }
  });

  it("登记表键集合与目录完全一致", () => {
    expect(Object.keys(domainEventPayloadSchemas).sort()).toEqual([...expectedEventTypes].sort());
    expect(getDomainEventPayloadSchema("UnknownEvent")).toBeUndefined();
    expectInvalid(domainEventTypeSchema, "unknown.event");
  });

  it.each(expectedEventTypes)("%s 的 payload 通过且拒绝未知字段", (type) => {
    const payload = validPayloads[type];
    const schema = domainEventPayloadSchemas[type];
    expectValid(schema, payload);
    expectInvalid(schema, { ...(payload as object), __unexpectedField: true });
    expectInvalid(schema, null);
  });

  it("旧 ChapterStageEvaluated 缺少 cityResources 时按 null 解析", () => {
    const parsed = domainEventPayloadSchemas.ChapterStageEvaluated.parse(validPayloads.ChapterStageEvaluated);
    expect(parsed.cityResources).toBeNull();
  });

  it("ChapterStageEvaluated 携带完整六种城市资源快照", () => {
    const cityResources = { energy: 140, materials: 160, food: 120, supply: 60, medical: 40, water: 72 };
    const parsed = domainEventPayloadSchemas.ChapterStageEvaluated.parse({
      ...validPayloads.ChapterStageEvaluated,
      cityResources,
    });
    expect(parsed.cityResources).toEqual(cityResources);
    expectInvalid(domainEventPayloadSchemas.ChapterStageEvaluated, {
      ...validPayloads.ChapterStageEvaluated,
      cityResources: { ...cityResources, water: -1 },
    });
  });

  it("无需移动的出发允许空路线", () => {
    expectValid(domainEventPayloadSchemas.TaskDeparted, {
      taskId,
      participants: [],
      route: [],
      nominalCompletionTick: 1,
    });
  });

  it("投递名单必须按 principalId 排序去重", () => {
    expectSchema(deliverySchema, { principalId: "player-1", deliverAtTick: 0 }, { principalId: "", deliverAtTick: 0 });
    expectValid(deliveryListSchema, openings);
    expectInvalid(deliveryListSchema, [...openings].reverse());
    expectInvalid(deliveryListSchema, [openings[0], openings[0]]);
  });

  it("主体 ID 按 UTF-16 码元比较，与 locale 排序无关", () => {
    expect(comparePrincipalIds("NPC-1", "npc_x")).toBeLessThan(0);
    expect(comparePrincipalIds("npc_x", "NPC-1")).toBeGreaterThan(0);
    expect(comparePrincipalIds("npc-1", "npc-1")).toBe(0);
    expect(["npc_x", "player-1", "NPC-1", "npc1"].sort(comparePrincipalIds)).toEqual(["NPC-1", "npc1", "npc_x", "player-1"]);
  });

  it("投递名单的大小写与标点混排按码元序校验", () => {
    const mixed = ["NPC-1", "npc1", "npc_x"].map((principalId) => ({ principalId, deliverAtTick: 0 }));
    expectValid(deliveryListSchema, mixed);
    // localeCompare 在 zh-CN 等 locale 下会把 "NPC-1" 排到 "npc_x" 之后，这样的名单必须被拒绝。
    expectInvalid(deliveryListSchema, [mixed[2], mixed[0]]);
  });

  it("任务效果与侦察报告的结构", () => {
    expectSchema(taskEffectSchema, { kind: "repair" }, { kind: "travel" });
    const report = {
      roads: [{ roadId: "r-gh-ps", status: "open" }],
      characterIds: ["npc-cenyan"],
      groups: [{ groupId, status: "waiting" }],
    };
    expectSchema(scoutReportSchema, report, { roads: [] });
  });
});
