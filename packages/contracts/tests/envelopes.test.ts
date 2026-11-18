/**
 * 验证事件信封、命令信封、命令回执、认证上下文与状态枚举。
 * 依赖公共契约包的 envelopes 主题导出。
 * 禁止在此构造真实世界写入或依赖登录状态；所有样例都是固定 JSON。
 */
import { describe, expect, it } from "vitest";
import {
  authContextSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  commandStatusSchema,
  eventEnvelopeSchema,
  executionStatusSchema,
  principalKindSchema,
  sessionRoleSchema,
  taskStatusSchema,
} from "../src/index";
import { expectInvalid, expectSchema } from "./support";

const eventEnvelope = {
  eventId: "evt-k3j9x0a1b2c3",
  schemaVersion: 1,
  worldId: "wld-k3j9x0a1b2c3",
  branchId: "br-k3j9x0a1b2c3",
  worldSeq: 12,
  worldTick: 3,
  type: "CampaignStarted",
  principalId: "player-1",
  causationIds: ["cmd-k3j9x0a1b2c3"],
  correlationId: "trc-k3j9x0a1b2c3",
  audience: [{ kind: "public" }],
  payload: { campaignId: "cmp-k3j9x0a1b2c3" },
};

describe("EventEnvelope", () => {
  it("接受合法事件信封", () => {
    expectSchema(eventEnvelopeSchema, eventEnvelope, { ...eventEnvelope, eventId: "event-1" });
  });

  it("拒绝负序号、未知受众与非 JSON payload", () => {
    expectInvalid(eventEnvelopeSchema, { ...eventEnvelope, worldSeq: -1 });
    expectInvalid(eventEnvelopeSchema, { ...eventEnvelope, audience: [{ kind: "nobody" }] });
    expectInvalid(eventEnvelopeSchema, { ...eventEnvelope, payload: Number.NaN });
  });

  it("拒绝额外字段", () => {
    expectInvalid(eventEnvelopeSchema, { ...eventEnvelope, extra: true });
  });
});

describe("CommandEnvelope", () => {
  const commandEnvelope = {
    commandId: "cmd-k3j9x0a1b2c3",
    type: "campaign.start",
    schemaVersion: 1,
    payload: { factionId: "human-neutral" },
  };

  it("接受带与不带 expectedVersions 的命令", () => {
    expectSchema(commandEnvelopeSchema, commandEnvelope, { ...commandEnvelope, commandId: "cmd-1" });
    expectInvalid(commandEnvelopeSchema, { ...commandEnvelope, schemaVersion: 0 });
    expectInvalid(commandEnvelopeSchema, {
      ...commandEnvelope,
      expectedVersions: { "task:task-k3j9x0a1b2c3": -1 },
    });
  });
});

describe("CommandReceipt", () => {
  const accepted = {
    receiptId: "rcp-k3j9x0a1b2c3",
    commandId: "cmd-k3j9x0a1b2c3",
    commandStatus: "accepted",
    reasonCode: null,
    safeMessage: null,
    acceptedEventIds: ["evt-k3j9x0a1b2c3"],
    operationId: "op-k3j9x0a1b2c3",
    resultingVersions: { "campaign:cmp-k3j9x0a1b2c3": 1 },
    result: { taskId: "task-k3j9x0a1b2c3" },
    worldTick: 0,
  };

  it("接受 accepted 与 rejected 回执", () => {
    expectSchema(commandReceiptSchema, accepted, { ...accepted, reasonCode: "no-authority" });
    expectSchema(
      commandReceiptSchema,
      {
        ...accepted,
        commandStatus: "rejected",
        reasonCode: "no-authority",
        safeMessage: "没有权限",
        acceptedEventIds: [],
      },
      { ...accepted, commandStatus: "rejected", reasonCode: null },
    );
  });

  it("拒绝错误事件 ID、负 worldTick 与额外字段", () => {
    expectInvalid(commandReceiptSchema, { ...accepted, acceptedEventIds: ["nope"] });
    expectInvalid(commandReceiptSchema, { ...accepted, worldTick: -1 });
    expectInvalid(commandReceiptSchema, { ...accepted, extra: 1 });
  });
});

describe("AuthContext", () => {
  const auth = {
    principalId: "npc-cenyan",
    kind: "agent",
    roles: ["agent"],
    worldId: "wld-k3j9x0a1b2c3",
    branchId: "br-k3j9x0a1b2c3",
    actingAsAgentId: null,
    controllerEpoch: 3,
    turnLeaseEpoch: 4,
    turnId: "turn-k3j9x0a1b2c3",
  };

  it("接受 Agent 与系统主体上下文", () => {
    expectSchema(authContextSchema, auth, { ...auth, kind: "unknown" });
    expectSchema(
      authContextSchema,
      {
        ...auth,
        principalId: "system:world",
        kind: "system",
        controllerEpoch: null,
        turnLeaseEpoch: null,
        turnId: null,
      },
      { ...auth, principalId: "system:world", kind: "system", turnLeaseEpoch: undefined },
    );
  });

  it("拒绝带负 epoch 与未知主体类型", () => {
    expectInvalid(authContextSchema, { ...auth, controllerEpoch: -1 });
    expectInvalid(eventEnvelopeSchema, { ...eventEnvelope, schemaVersion: 1.5 });
  });
});

describe("状态枚举", () => {
  it("命令状态只有 accepted 与 rejected", () => {
    for (const value of ["accepted", "rejected"]) {
      expect(commandStatusSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(commandStatusSchema, "pending");
  });

  it("任务状态与执行状态各自独立", () => {
    for (const value of ["pending", "running", "completed", "failed", "cancelled"]) {
      expect(taskStatusSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["ok", "error", "unknown"]) {
      expect(executionStatusSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(taskStatusSchema, "ok");
    expectInvalid(executionStatusSchema, "pending");
  });

  it("主体类型覆盖玩家、Agent、控制台角色与系统", () => {
    for (const value of ["player", "agent", "operator", "researcher", "evaluator", "system"]) {
      expect(principalKindSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(principalKindSchema, "npc");
  });

  it("会话角色只取四种已定义角色", () => {
    for (const value of ["player", "operator", "researcher", "evaluator"]) {
      expect(sessionRoleSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(sessionRoleSchema, "admin");
  });
});
