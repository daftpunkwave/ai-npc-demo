/**
 * 核心职责：锁定记忆检索预算由 memory 槽位自己的配置决定，与 context 槽位无关。
 * 交互契约：只构造 ResolvedAgentProfile 与 turnMemoryQuery，不启动模块、不读存储。
 * 约束与禁忌：不得让检索预算回退到读取 context 槽的私有字段。
 */
import { describe, expect, it } from "vitest";
import { memoryRetrievalBudgetDefaults, type Json } from "@ai-npc/contracts";
import type { ResolvedAgentProfile } from "@ai-npc/experiment";
import { memoryRetrievalBudget } from "../src/turn-materials";

/** 只填记忆检索预算需要的最小 profile 形态。 */
function profileWith(input: {
  readonly memory?: Json;
  readonly context?: Json;
}): ResolvedAgentProfile {
  return {
    profileId: "budget-probe",
    sourceChain: [],
    budgets: {
      maxModelCallsPerTurn: 6, maxDecisionRounds: 4, maxToolCallsPerTurn: 8, maxToolCallsPerRound: 3,
      maxTurnMs: 90000, maxReplans: 1, maxTokensPerAgentPerDay: 60000,
      reserveOutputTokens: { decision: 1500, speech: 400, "memory-maintenance": 800 },
    },
    readiness: { requireDurable: true, requireDerived: true, waitTimeoutMs: 120000, onlineDegradeAfterMs: 10000 },
    speech: { maxChars: 80 },
    failurePolicy: "strict",
    scheduling: { module: "agent.scheduling.fair", config: {} },
    slots: {
      ...(input.memory === undefined ? {} : { memory: { module: "agent.memory.ledger", config: input.memory } }),
      ...(input.context === undefined ? {} : { context: { module: "agent.context.ordered-blocks", config: input.context } }),
    },
  };
}

describe("记忆检索预算的来源", () => {
  it("取 memory 槽位声明的 retrievalBudget", () => {
    const budget = memoryRetrievalBudget(profileWith({ memory: { retrievalBudget: { maxItems: 5, maxTokens: 300 } } }));
    expect(budget).toEqual({ maxItems: 5, maxTokens: 300 });
  });

  it("context 槽的 segmentBudgets.memory 不再影响检索预算", () => {
    const contextHeavy = { decision: { segmentBudgets: { memory: 4000 } } };
    expect(memoryRetrievalBudget(profileWith({
      memory: { retrievalBudget: { maxItems: 5, maxTokens: 300 } },
      context: contextHeavy,
    }))).toEqual({ maxItems: 5, maxTokens: 300 });
  });

  it("memory 槽未声明该字段时按记忆侧默认值处理", () => {
    expect(memoryRetrievalBudget(profileWith({ memory: {} }))).toEqual(memoryRetrievalBudgetDefaults);
    expect(memoryRetrievalBudget(profileWith({}))).toEqual(memoryRetrievalBudgetDefaults);
  });

  it("memory 槽缺失时与不含该槽位的 context 配置无关", () => {
    const withoutMemory = memoryRetrievalBudget(profileWith({
      context: { decision: { segmentBudgets: { memory: 1 } } },
    }));
    expect(withoutMemory).toEqual(memoryRetrievalBudgetDefaults);
  });

  it("声明了非法 retrievalBudget 时拒绝而不是静默猜测", () => {
    for (const invalid of [null, 1000, [], "budget", { maxItems: 0, maxTokens: 100 }, { maxItems: 1 }]) {
      expect(() => memoryRetrievalBudget(profileWith({ memory: { retrievalBudget: invalid } })))
        .toThrow(/retrievalBudget/);
    }
  });
});
