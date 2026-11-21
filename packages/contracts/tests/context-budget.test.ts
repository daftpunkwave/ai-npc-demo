/**
 * 核心职责：验证上下文 token 上限计算对输入上限、输出预留、安全余量与工具循环预留的处理。
 * 交互契约：只使用公共预算契约类型与计算函数，不启动模块、模型或读取配置。
 * 约束与禁忌：不得读取实际 usage 或把估值冒充供应商 tokenizer 结果。
 */
import { describe, expect, it } from "vitest";
import type { ContextBuildRequest } from "../src/index";
import { resolveContextTokenLimits } from "../src/index";

type BudgetRequest = Pick<ContextBuildRequest, "budget" | "modelWindowTokens">;

function request(overrides: Partial<BudgetRequest> = {}): BudgetRequest {
  return {
    modelWindowTokens: 10000,
    budget: {
      maxInputTokens: 8000,
      reservedOutputTokens: 1500,
      safetyTokens: 300,
      toolLoopReserveTokens: 1600,
      segmentBudgets: {},
      historyTurns: 0,
      lendUnusedBudget: false,
    },
    ...overrides,
  };
}

describe("上下文 token 上限", () => {
  it("输入上限先受 maxInputTokens 约束", () => {
    expect(resolveContextTokenLimits(request())).toEqual({
      effectiveMaxTokens: 8000,
      targetTokens: 6400,
    });
  });

  it("模型窗口不足时先扣除输出预留与安全余量", () => {
    expect(resolveContextTokenLimits(request({ modelWindowTokens: 9000 }))).toEqual({
      effectiveMaxTokens: 7200,
      targetTokens: 5600,
    });
  });

  it("窗口小于输出预留与安全余量之和时返回不可满足的 0", () => {
    expect(resolveContextTokenLimits(request({ modelWindowTokens: 1700 }))).toEqual({
      effectiveMaxTokens: 0,
      targetTokens: 0,
    });
  });

  it("工具循环预留耗尽目标预算时返回 0", () => {
    const limits = resolveContextTokenLimits({
      modelWindowTokens: 10000,
      budget: {
        maxInputTokens: 8000,
        reservedOutputTokens: 0,
        safetyTokens: 0,
        toolLoopReserveTokens: 9000,
        segmentBudgets: {},
        historyTurns: 0,
        lendUnusedBudget: false,
      },
    });
    expect(limits).toEqual({ effectiveMaxTokens: 8000, targetTokens: 0 });
  });

  it("工具循环预留只降低目标上限", () => {
    const limits = resolveContextTokenLimits({
      modelWindowTokens: 10000,
      budget: {
        maxInputTokens: 8000,
        reservedOutputTokens: 0,
        safetyTokens: 0,
        toolLoopReserveTokens: 2500,
        segmentBudgets: {},
        historyTurns: 0,
        lendUnusedBudget: false,
      },
    });
    expect(limits).toEqual({ effectiveMaxTokens: 8000, targetTokens: 5500 });
  });
});
