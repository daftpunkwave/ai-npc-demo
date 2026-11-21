/**
 * 核心职责：验证 ContextBuildRequest 预算字段的必填与取值校验。
 * 交互契约：只使用公共请求 schema 与契约测试断言，不启动模块、模型或读取配置。
 * 约束与禁忌：不得绕开 schema 直接构造请求结果。
 */
import { describe, expect, it } from "vitest";
import { contextBuildRequestSchema } from "../src/index";
import { expectInvalid, expectValid } from "./support";

function request(): Record<string, unknown> {
  return {
    session: { worldId: "wld-000000000001", branchId: "br-000000000001", agentId: "agent-1" },
    runId: "run-000000000001",
    turnId: "turn-000000000001",
    attemptId: "att-000000000001",
    phase: "decision",
    targetAudience: ["player-1"],
    frontier: {
      worldSeq: 1,
      worldTick: 1,
      observationSeq: 1,
      perceptionRevision: 1,
      memoryRevision: 1,
      conversationCursor: null,
      knowledgeGrantRevision: 1,
    },
    profileHash: "profile-hash",
    templateVersion: "1",
    systemIdentity: "system protocol",
    loreSummary: "shared lore",
    worldViewText: "world line",
    affairsText: "task line",
    historyText: "",
    inputText: "input line",
    observations: [],
    memoryBundle: {
      status: "empty-by-design",
      revision: 1,
      coreBlock: null,
      relationSummary: [],
      items: [],
      candidates: 0,
      dropped: [],
    },
    modelWindowTokens: 8000,
    budget: {
      maxInputTokens: 8000,
      reservedOutputTokens: 1500,
      safetyTokens: 300,
      toolLoopReserveTokens: 1600,
      segmentBudgets: { history: 800 },
      historyTurns: 8,
      lendUnusedBudget: false,
    },
  };
}

function budgetOf(value: Record<string, unknown>): Record<string, unknown> {
  return value["budget"] as Record<string, unknown>;
}

describe("ContextBuildRequest 预算契约", () => {
  it("接受包含 reservedOutputTokens 的完整请求", () => {
    expect(expectValid(contextBuildRequestSchema, request()).budget.reservedOutputTokens).toBe(1500);
  });

  it("拒绝缺少 reservedOutputTokens 的预算", () => {
    const value = request();
    delete budgetOf(value)["reservedOutputTokens"];
    expectInvalid(contextBuildRequestSchema, value);
  });

  it("拒绝负数或非整数的 reservedOutputTokens", () => {
    const negative = request();
    budgetOf(negative)["reservedOutputTokens"] = -1;
    expectInvalid(contextBuildRequestSchema, negative);

    const fractional = request();
    budgetOf(fractional)["reservedOutputTokens"] = 0.5;
    expectInvalid(contextBuildRequestSchema, fractional);
  });
});
