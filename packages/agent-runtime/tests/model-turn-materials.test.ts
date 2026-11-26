/**
 * 验证模型决策预算读取契约：缺失 decision/speech 预算子块时以领域错误拒绝，
 * 完整预算按用途解析为上下文构建请求的预算形状。
 * 依赖 profile 槽位配置与公共领域错误契约。
 * 禁止在此构造完整 turn、模型调用或存储访问。
 */
import { describe, expect, it } from "vitest";
import { DomainError, type Json } from "@world-prism/contracts";
import type { ResolvedAgentProfile } from "@world-prism/experiment";
import { modelContextBudget } from "../src/model-turn-materials";

const profileId = "agent-strategic-default";

const contextConfig = {
  segmentOrder: ["world", "task", "memory", "history", "input"],
  historyTurns: 6,
  lendUnusedBudget: false,
  decision: {
    maxInputTokens: 8000, safetyTokens: 300, toolLoopReserveTokens: 1600,
    segmentBudgets: { world: 900, task: 600, memory: 900, history: 600 },
  },
  speech: { maxInputTokens: 2500, safetyTokens: 200, segmentBudgets: { facts: 800, history: 400 } },
} satisfies Json;

function profileWith(context: Json): ResolvedAgentProfile {
  return {
    profileId, sourceChain: [],
    budgets: {
      maxModelCallsPerTurn: 6, maxDecisionRounds: 4, maxToolCallsPerTurn: 8, maxToolCallsPerRound: 3,
      maxTurnMs: 90000, maxReplans: 1, maxTokensPerAgentPerDay: 60000,
      reserveOutputTokens: { decision: 1500, speech: 400, "memory-maintenance": 800 },
    },
    readiness: { requireDurable: true, requireDerived: true, waitTimeoutMs: 120000, onlineDegradeAfterMs: 10000 },
    speech: { maxChars: 80 },
    failurePolicy: "strict",
    scheduling: { module: "agent.scheduling.fair", config: {} },
    slots: { context: { module: "agent.context.ordered-blocks", config: context } },
  };
}

/** 剔除指定用途的预算子块，模拟省略该块的 profile 配置。 */
function contextWithout(purpose: "decision" | "speech"): Json {
  const { [purpose]: _removed, ...rest } = contextConfig;
  return rest;
}

/** 把指定用途的预算子块替换为给定值，模拟非法的块形状。 */
function contextWith(purpose: "decision" | "speech", value: Json): Json {
  return { ...contextWithout(purpose), [purpose]: value };
}

/** 捕获 modelContextBudget 的领域错误；未抛错时让用例失败。 */
function budgetError(context: Json, purpose: "decision" | "speech"): DomainError {
  try {
    modelContextBudget(profileWith(context), purpose);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("预期 modelContextBudget 抛出领域错误");
}

describe("模型上下文预算读取", () => {
  it.each(["decision", "speech"] as const)("缺少 %s 预算子块时以 assembly-incompatible 拒绝并指向 profile 与用途", (purpose) => {
    const error = budgetError(contextWithout(purpose), purpose);
    expect(error.code).toBe("assembly-incompatible");
    expect(error.message).toContain(`${profileId}」的上下文配置缺少 ${purpose} 预算块`);
  });

  it.each(["decision", "speech"] as const)("%s 预算子块为 null 或非对象时按缺失配置拒绝", (purpose) => {
    const invalids: Json[] = [null, 8000, "budget", [], true];
    for (const invalid of invalids) {
      const error = budgetError(contextWith(purpose, invalid), purpose);
      expect(error.code).toBe("assembly-incompatible");
      expect(error.message).toContain(`${profileId}」的上下文配置缺少 ${purpose} 预算块`);
    }
  });

  it("完整预算按 decision 用途解析并带上工具循环预留", () => {
    expect(modelContextBudget(profileWith(contextConfig), "decision")).toEqual({
      maxInputTokens: 8000, reservedOutputTokens: 1500, safetyTokens: 300, toolLoopReserveTokens: 1600,
      segmentBudgets: { world: 900, task: 600, memory: 900, history: 600 },
      historyTurns: 6, lendUnusedBudget: false,
    });
  });

  it("完整预算按 speech 用途解析且没有工具循环预留", () => {
    expect(modelContextBudget(profileWith(contextConfig), "speech")).toEqual({
      maxInputTokens: 2500, reservedOutputTokens: 400, safetyTokens: 200, toolLoopReserveTokens: 0,
      segmentBudgets: { facts: 800, history: 400 },
      historyTurns: 6, lendUnusedBudget: false,
    });
  });

  // historyTurns 在 ordered-blocks schema 中可省略；缺失或非数字时必须收敛为 0，
  // 否则 Number(undefined) 得到 NaN，Array.prototype.slice(-NaN) 会把全部历史当成最近 N 条。
  it.each(["decision", "speech"] as const)("%s 预算在 historyTurns 缺失或非数字时按 0 条历史解析", (purpose) => {
    const withoutHistory = { ...contextConfig } as Record<string, Json>;
    delete withoutHistory["historyTurns"];
    for (const context of [withoutHistory, { ...contextConfig, historyTurns: "8" }, { ...contextConfig, historyTurns: null }]) {
      const budget = modelContextBudget(profileWith(context), purpose);
      expect(Number.isNaN(budget.historyTurns)).toBe(false);
      expect(budget.historyTurns).toBe(0);
    }
  });
});
