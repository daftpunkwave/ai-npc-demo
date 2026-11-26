/**
 * 验证记忆作用域、输入边界、受众、观察与记忆记录的 schema。
 * 依赖公共契约包的 frontier、audience、observation 与 memory 主题导出。
 * 禁止依赖真实世界状态；观察与记忆样例为手写固定值。
 */
import { describe, expect, it } from "vitest";
import {
  agentObservationSchema,
  audienceSpecSchema,
  contentRefSchema,
  inputFrontierSchema,
  memoryEpistemicSchema,
  memoryOwnerSchema,
  memoryRecordKindSchema,
  memoryRecordSchema,
  memoryRecordStatusSchema,
  memoryScopeSchema,
  observationEpistemicSchema,
} from "../src/index";
import { expectInvalid, expectSchema } from "./support";

const scope = {
  worldId: "wld-k3j9x0a1b2c3",
  branchId: "br-k3j9x0a1b2c3",
  agentId: "npc-cenyan",
};

describe("MemoryScope 与 ContentRef", () => {
  it("接受合法作用域并拒绝缺失主体", () => {
    expectSchema(memoryScopeSchema, scope, { ...scope, agentId: "" });
    expectInvalid(memoryScopeSchema, { ...scope, extra: 1 });
  });

  it("ContentRef 的 itemId 可选但其余字段必填", () => {
    expectSchema(
      contentRefSchema,
      { contentId: "watergate-v1", contentVersion: "1" },
      { contentId: "watergate-v1" },
    );
    expectInvalid(contentRefSchema, { contentId: "", contentVersion: "1" });
  });
});

describe("InputFrontier", () => {
  const frontier = {
    worldSeq: 20,
    worldTick: 5,
    observationSeq: 12,
    perceptionRevision: 4,
    memoryRevision: 7,
    conversationCursor: "conv-cursor-1",
    knowledgeGrantRevision: 2,
  };

  it("接受冻结边界与空会话游标", () => {
    expectSchema(inputFrontierSchema, frontier, { ...frontier, worldSeq: -1 });
    expectInvalid(inputFrontierSchema, { ...frontier, conversationCursor: "" });
  });
});

describe("AudienceSpec", () => {
  it("接受四种对外受众与 system 受众", () => {
    expectSchema(audienceSpecSchema, { kind: "public" }, { kind: "public", extra: 1 });
    expectSchema(audienceSpecSchema, { kind: "node", nodeId: "grayharbor" }, { kind: "node", nodeId: "Node" });
    expectSchema(audienceSpecSchema, { kind: "principals", ids: ["player-1"] }, { kind: "principals", ids: [] });
    expectSchema(audienceSpecSchema, { kind: "faction", factionId: "human-neutral" }, { kind: "faction", factionId: "" });
    expectSchema(audienceSpecSchema, { kind: "system" }, { kind: "nobody" });
  });
});

describe("AgentObservation", () => {
  const observation = {
    observationId: "obs-k3j9x0a1b2c3",
    scope,
    observationSeq: 3,
    sourceEventIds: ["evt-k3j9x0a1b2c3"],
    sourceObservationIds: [],
    occurredAtTick: 2,
    sensedAtTick: 3,
    knownAtTick: 4,
    channel: "relay",
    epistemic: "witnessed",
    confidence: 0.6,
    releasePolicyId: "public",
    content: { summaryZh: "岑雁说：小心。", detail: "full" },
  };

  it("接受合法观察并拒绝时间倒序", () => {
    expectSchema(agentObservationSchema, observation, {
      ...observation,
      occurredAtTick: 5,
    });
    expectInvalid(agentObservationSchema, { ...observation, sensedAtTick: 1 });
    expectInvalid(agentObservationSchema, { ...observation, knownAtTick: 2 });
  });

  it("拒绝越界置信度与非有限数字", () => {
    expectInvalid(agentObservationSchema, { ...observation, confidence: 1.5 });
    expectInvalid(agentObservationSchema, { ...observation, confidence: Number.POSITIVE_INFINITY });
  });

  it("亲历观察必须有来源", () => {
    expectInvalid(agentObservationSchema, {
      ...observation,
      sourceEventIds: [],
      sourceObservationIds: [],
    });
  });

  it("获知方式只取 witnessed、reported、inferred", () => {
    for (const value of ["witnessed", "reported", "inferred"]) {
      expect(observationEpistemicSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(observationEpistemicSchema, "verified-event");
  });
});

describe("MemoryRecord", () => {
  const record = {
    memoryId: "mem-k3j9x0a1b2c3",
    scope,
    kind: "episodic",
    sourceObservationIds: ["obs-k3j9x0a1b2c3"],
    status: "active",
    epistemic: "verified-event",
    releasePolicyId: "public",
    validFromTick: 2,
    validUntilTick: 48,
    revision: 3,
    content: { summaryZh: "任务完成" },
  };

  it("接受合法记忆并拒绝非法生命周期状态", () => {
    expectSchema(memoryRecordSchema, record, { ...record, status: "deleted" });
    expectInvalid(memoryRecordSchema, { ...record, kind: "unknown" });
  });

  it("证据地位与观察的获知方式是两套枚举", () => {
    for (const value of ["verified-event", "reported-claim", "inference"]) {
      expect(memoryEpistemicSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(memoryEpistemicSchema, "witnessed");
    expectInvalid(memoryRecordSchema, { ...record, epistemic: "witnessed" });
  });

  it("有效期不得倒序，可为 null 表示未定", () => {
    expectInvalid(memoryRecordSchema, { ...record, validUntilTick: 1 });
    expectSchema(
      memoryRecordSchema,
      { ...record, validUntilTick: null },
      { ...record, validFromTick: -1 },
    );
  });

  it("记忆分层与生命周期枚举逐项可校验", () => {
    for (const kind of ["episodic", "relation", "belief", "prospective", "core", "public"]) {
      expect(memoryRecordKindSchema.safeParse(kind).success).toBe(true);
    }
    for (const status of ["active", "superseded", "expired", "evicted", "retracted"]) {
      expect(memoryRecordStatusSchema.safeParse(status).success).toBe(true);
    }
    expectInvalid(memoryRecordKindSchema, "summary");
    expectInvalid(memoryRecordStatusSchema, "deleted");
  });

  it("记忆主体归属复用主体 ID 约束", () => {
    expectSchema(memoryOwnerSchema, "player-1", "");
  });
});
