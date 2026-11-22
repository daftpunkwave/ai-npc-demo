/**
 * 验证命令目录、命令载荷判别联合、协议条款与剧情卡效果 schema。
 * 依赖公共契约包的 commands 主题导出。
 * 禁止在此执行命令或依赖规则实现；样例只检查契约形状与严格字段。
 */
import { describe, expect, it } from "vitest";
import {
  agreementProposePayloadSchema,
  agreementRespondPayloadSchema,
  cardEffectSchema,
  commandPayloadOf,
  commandPayloadSchemas,
  commandRequestSchema,
  commandTypeSchema,
  commandTypes,
  dialogueSayPayloadSchema,
  DomainError,
  informationSharePayloadSchema,
  overrideEffectSchema,
  policySetPayloadSchema,
  probeAskPayloadSchema,
  roadIdFromPolicyKey,
  roadStatusPolicyKey,
  scenarioCompensatePayloadSchema,
  scenarioDraftPayloadSchema,
  scenarioOverridePayloadSchema,
  seatSayPayloadSchema,
  speechCommitPayloadSchema,
  termSchema,
} from "../src/index";
import { expectInvalid, expectValid } from "./support";

/** 命令类型全集，固定顺序用于目录完整性断言。 */
const expectedCommandTypes = [
  "campaign.start",
  "dialogue.say",
  "speech.commit",
  "seat.say",
  "information.share",
  "agreement.propose",
  "agreement.respond",
  "task.dispatch",
  "task.respond",
  "task.cancel",
  "policy.set",
  "scenario.draft",
  "scenario.publish",
  "scenario.withdraw",
  "scenario.compensate",
  "scenario.override",
  "probe.ask",
] as const;

const agentId = "npc-cenyan";
const taskId = "task-k3j9x0a1b2c3";
const agreementId = "agr-k3j9x0a1b2c3";

const deliverTerm = {
  kind: "deliver",
  obligorId: agentId,
  resource: "supply",
  amount: 10,
  fromStockpileId: "sp-rubble",
  toStockpileId: "sp-commons",
  byTick: 48,
};

const broadcastEffect = {
  kind: "broadcast",
  speakerId: "npc-shenli",
  text: "中继读数持续下降。",
};

/** 17 种命令的合法 payload，键必须与目录一一对应。 */
const validPayloads: Record<(typeof expectedCommandTypes)[number], unknown> = {
  "campaign.start": { factionId: "human-neutral" },
  "dialogue.say": { targetAgentId: agentId, text: "你好" },
  "speech.commit": {
    channel: "message",
    conversationId: null,
    audience: ["player-1"],
    approvedSpeechArtifactRef: "art-k3j9x0a1b2c3",
    intentKind: "inform",
    replyToId: null,
  },
  "seat.say": { to: ["player-1"], text: "收到" },
  "information.share": { evidenceId: "ev-flood-log", audience: [agentId] },
  "agreement.propose": {
    parties: ["player-1", "human-neutral"],
    terms: [deliverTerm],
    expiresInTicks: 24,
  },
  "agreement.respond": {
    agreementId,
    response: "counter",
    counterTerms: [
      {
        kind: "escort",
        obligorId: "human-neutral",
        roadId: "r-gh-ps",
        byTick: 48,
      },
    ],
  },
  "task.dispatch": {
    taskType: "transport",
    teamId: "team-commons",
    invitees: ["npc-wenyuan"],
    departAfterTicks: 2,
    params: {
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      cargo: { supply: 10, energy: 0, medical: 0 },
    },
  },
  "task.respond": { taskId, response: "accept", reasonCode: "busy" },
  "task.cancel": { taskId },
  "policy.set": { key: "watergate.allocation", value: "rotation" },
  "scenario.draft": {
    cardId: "card-relay-alarm",
    version: 1,
    triggerAtTick: 6,
    effects: [broadcastEffect],
    note: "运营草稿",
  },
  "scenario.publish": { cardId: "card-relay-alarm", version: 1, triggerAtTick: 2 },
  "scenario.withdraw": { cardId: "card-relay-alarm" },
  "scenario.compensate": { cardId: "card-relay-alarm", effects: [broadcastEffect], note: "补偿" },
  "scenario.override": {
    effects: [{ kind: "meter-set", meter: "relay.stability", value: 45 }],
    note: "调试覆盖",
  },
  "probe.ask": {
    probeId: "prb-k3j9x0a1b2c3",
    agentId,
    askedBy: "system:world",
    question: "你还记得上次的承诺吗？",
  },
};

describe("命令目录", () => {
  it("类型全集与固定目录一致", () => {
    expect([...commandTypes]).toEqual([...expectedCommandTypes]);
    expect([...commandTypeSchema.options]).toEqual([...expectedCommandTypes]);
    for (const type of expectedCommandTypes) {
      expect(commandPayloadSchemas[type]).toBeDefined();
    }
  });

  it("载荷映射键与类型目录完全一致", () => {
    expect(Object.keys(commandPayloadSchemas).sort()).toEqual([...expectedCommandTypes].sort());
    expectInvalid(commandTypeSchema, "campaign.pause");
  });

  it("agreement.propose 的默认有效期为 24，显式值原样保留", () => {
    const base = { parties: ["player-1", "human-neutral"], terms: [deliverTerm] };
    expect(agreementProposePayloadSchema.parse(base).expiresInTicks).toBe(24);
    expect(
      agreementProposePayloadSchema.parse({ ...base, expiresInTicks: 168 }).expiresInTicks,
    ).toBe(168);
  });

  it.each(expectedCommandTypes)("命令 %s 的合法载荷通过且拒绝额外字段", (type) => {
    const payload = validPayloads[type];
    const schema = commandPayloadSchemas[type];
    expectValid(schema, payload);
    expectInvalid(schema, { ...(payload as object), __unexpectedField: true });
    expectInvalid(schema, null);
  });

  it.each(expectedCommandTypes)("命令请求 %s 的 type 与 payload 必须匹配", (type) => {
    expectValid(commandRequestSchema, { type, payload: validPayloads[type] });
    expectInvalid(commandRequestSchema, { type, payload: { factionId: "human-neutral" }, extra: true });
    expectInvalid(commandRequestSchema, { type: "unknown.command", payload: {} });
  });
});

describe("协议条款 Term", () => {
  const terms = [
    deliverTerm,
    { kind: "escort", obligorId: agentId, roadId: "r-gh-ps", byTick: 48 },
    { kind: "rescue", obligorId: "npc-suhui", groupId: "grp-injured-migrants", byTick: 48 },
    { kind: "repair-relay", obligorId: "npc-shenli", byTick: 48 },
    {
      kind: "share-evidence",
      obligorId: "human-neutral",
      evidenceId: "ev-water-ledger",
      toPrincipalId: "player-1",
      byTick: 48,
    },
    {
      kind: "grant-passage",
      obligorId: "species-extraterrestrial",
      roadId: "r-gh-an",
      granteeFactionId: "human-alien-accord",
      untilTick: 100,
    },
    { kind: "water-allocation", obligorId: "human-neutral", policy: "rotation", untilTick: 100 },
    {
      kind: "delegate",
      obligorId: "human-neutral",
      granteeId: "npc-wenyuan",
      teamIds: ["team-commons"],
      stockpileId: "sp-commons",
      maxDraw: { supply: 15, energy: 6, medical: 4 },
      untilTick: 168,
    },
  ];

  it("八种条款都通过且 kind 唯一判别", () => {
    expect(terms).toHaveLength(8);
    expect(new Set(terms.map((term) => term.kind)).size).toBe(8);
    for (const term of terms) {
      expectValid(termSchema, term);
      expectInvalid(termSchema, { ...term, __unexpectedField: true });
      expectInvalid(termSchema, { ...term, kind: "unknown" });
    }
  });

  it("拒绝缺少义务人与越界数值", () => {
    expectInvalid(termSchema, { ...deliverTerm, obligorId: "" });
    expectInvalid(termSchema, { ...deliverTerm, amount: 0 });
    expectInvalid(termSchema, { ...deliverTerm, byTick: -1 });
  });
});

describe("命令输入上限", () => {
  const principals = Array.from({ length: 21 }, (_, index) => `principal-${index}`);
  const withinLimit = principals.slice(0, 20);
  const tooManyTerms = Array.from({ length: 21 }, () => deliverTerm);
  const termsWithinLimit = Array.from({ length: 20 }, () => deliverTerm);
  const longText = "长".repeat(301);
  const maxText = "长".repeat(300);

  it("政策键、自由文本与侦察问题拒绝超长输入", () => {
    expectInvalid(policySetPayloadSchema, { key: "k".repeat(121), value: "rotation" });
    expectValid(policySetPayloadSchema, { key: "k".repeat(120), value: "rotation" });
    expectInvalid(dialogueSayPayloadSchema, { targetAgentId: agentId, text: longText });
    expectInvalid(probeAskPayloadSchema, { ...(validPayloads["probe.ask"] as object), question: longText });
    expectValid(probeAskPayloadSchema, { ...(validPayloads["probe.ask"] as object), question: maxText });
    expectInvalid(scenarioDraftPayloadSchema, {
      ...(validPayloads["scenario.draft"] as object),
      note: longText,
    });
    expectInvalid(scenarioCompensatePayloadSchema, {
      ...(validPayloads["scenario.compensate"] as object),
      note: longText,
    });
    expectInvalid(scenarioOverridePayloadSchema, {
      ...(validPayloads["scenario.override"] as object),
      note: longText,
    });
  });

  it("协议当事人与条款数量有上限，且上限内仍合法", () => {
    expectInvalid(agreementProposePayloadSchema, { parties: principals, terms: [deliverTerm] });
    expectInvalid(agreementProposePayloadSchema, {
      parties: ["player-1", "human-neutral"],
      terms: tooManyTerms,
    });
    expectValid(agreementProposePayloadSchema, {
      parties: withinLimit,
      terms: termsWithinLimit,
      expiresInTicks: 24,
    });
    expectInvalid(agreementRespondPayloadSchema, {
      agreementId,
      response: "counter",
      counterTerms: tooManyTerms,
    });
    expectValid(agreementRespondPayloadSchema, {
      agreementId,
      response: "counter",
      counterTerms: termsWithinLimit,
    });
  });

  it("通信受众名单有上限，且上限内仍合法", () => {
    expectInvalid(speechCommitPayloadSchema, {
      ...(validPayloads["speech.commit"] as object),
      audience: principals,
    });
    expectValid(speechCommitPayloadSchema, {
      ...(validPayloads["speech.commit"] as object),
      audience: withinLimit,
    });
    expectInvalid(informationSharePayloadSchema, { evidenceId: "ev-flood-log", audience: principals });
    expectValid(informationSharePayloadSchema, { evidenceId: "ev-flood-log", audience: withinLimit });
    expectInvalid(seatSayPayloadSchema, { to: principals, text: "收到" });
    expectValid(seatSayPayloadSchema, { to: withinLimit, text: "收到" });
  });
});

describe("剧情卡效果", () => {
  const effects = [
    broadcastEffect,
    { kind: "message", from: "npc-guxun", to: ["human-neutral"], text: "请考虑轮换供水。" },
    { kind: "rumor", sourceId: "src-trader", aboutIds: ["species-fauna"], text: "听说巡裔袭击了车队。" },
    {
      kind: "world-fact",
      factType: "ConvoyDelayed",
      audience: { kind: "node", nodeId: "watergate" },
      payload: { roadId: "r-gh-wg", text: "车队延误 6 小时。" },
    },
    {
      kind: "stockpile-adjust",
      stockpileId: "sp-commons",
      delta: { supply: -10 },
      reason: "仓储受潮",
    },
    { kind: "wake-agents", agentIds: ["human-neutral", "species-fauna"], reason: "council" },
  ];

  it("六种效果都通过且拒绝未知效果与额外字段", () => {
    expect(effects).toHaveLength(6);
    for (const effect of effects) {
      expectValid(cardEffectSchema, effect);
      expectInvalid(cardEffectSchema, { ...effect, __unexpectedField: true });
      expectInvalid(cardEffectSchema, { ...effect, kind: "meter-set" });
    }
  });

  it("覆盖效果额外允许 meter-set 与 road-status-set", () => {
    const overrideEffects = [
      ...effects,
      { kind: "meter-set", meter: "relay.stability", value: 45 },
      { kind: "road-status-set", roadId: "r-gh-ps", status: "closed" },
    ];
    expect(overrideEffects).toHaveLength(8);
    for (const effect of overrideEffects) {
      expectValid(overrideEffectSchema, effect);
    }
    expectInvalid(overrideEffectSchema, { kind: "meter-set", meter: "watergate.allocation", value: 45 });
    expectInvalid(overrideEffectSchema, { kind: "road-status-set", roadId: "r-gh-ps", status: "blocked" });
  });
});

describe("道路政策键", () => {
  it("构造与解析互逆，且与 PolicyChanged/policy.set 使用同一格式", () => {
    const key = roadStatusPolicyKey("r-gh-ps");
    expect(key).toBe("road.status:r-gh-ps");
    expect(roadIdFromPolicyKey(key)).toBe("r-gh-ps");
    expectValid(policySetPayloadSchema, { key, value: "closed" });
  });

  it("非道路政策键解析为 null", () => {
    expect(roadIdFromPolicyKey("watergate.allocation")).toBeNull();
    expect(roadIdFromPolicyKey("road.status:")).toBe("");
    expect(roadIdFromPolicyKey("road")).toBeNull();
  });
});

describe("commandPayloadOf", () => {
  it("按命令类型复验并收窄 payload", () => {
    const payload = commandPayloadOf("task.cancel", { taskId: "task-000000000001" });
    expect(payload.taskId).toBe("task-000000000001");

    const dispatch = commandPayloadOf("task.dispatch", {
      taskType: "scout",
      teamId: "team-000000000001",
      params: { nodeId: "grayharbor" },
    });
    expect(dispatch.taskType).toBe("scout");
    expect(dispatch.params).toEqual({ nodeId: "grayharbor" });
  });

  it("拒绝不符合契约的 payload 并给出路径详情", () => {
    expect(() => commandPayloadOf("task.cancel", {})).toThrow(DomainError);
    try {
      commandPayloadOf("task.cancel", { taskId: 123 });
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("invalid-state");
      expect(JSON.stringify(domainError.details)).toContain("taskId");
      return;
    }
    throw new Error("非法 payload 没有被拒绝");
  });

  it("接受委托类型的全部命令目录键", () => {
    for (const type of commandTypes) {
      expect(() => commandPayloadOf(type, { __unexpected: true })).toThrow(DomainError);
    }
  });
});
