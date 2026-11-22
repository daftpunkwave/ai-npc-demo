/**
 * 执行有界的模型决策循环，并为独立的对白请求调用模型。
 * 通过宿主回调取得模型、工具结果以及按实际请求校验的决定。
 * 禁止直接提交世界命令、复用携密输入生成对白或发出未配对的工具历史。
 */
import {
  canonicalJson, DomainError, estimateModelInputTokens, type Json, type ModuleCreateInput, type NormalizedMessage,
} from "@ai-npc/contracts";
import {
  createStatelessModule, modelDecisionPurposeRequirements, resolveAgentModelRoutes, type ModelDecisionPort,
} from "@ai-npc/module-sdk";

type DecisionResult = Awaited<ReturnType<ModelDecisionPort["decide"]>>;
type ToolResult = Extract<NormalizedMessage, { role: "tool" }>;
const submit = "decision_submit";

// 工具错误载荷是模型可见契约：error 键取值 budget-exhausted（与平台 DomainError 码同族）、
// invalid_decision 与 duplicate_decision_submit；这些值已被集成测试断言并随请求归档进入历史证据，
// 调整键名前必须同步验证测试与历史回放兼容。
function errorTool(toolCallId: string, value: Json): ToolResult {
  return { role: "tool", toolCallId, content: canonicalJson(value), isError: true };
}

function classify(error: unknown): Exclude<DecisionResult["status"], "ok"> {
  if (!(error instanceof DomainError) || error.code === "cancelled") throw error;
  const details = error.details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    if (details["finishReason"] === "length" || details["finishReason"] === "refusal") return "invalid-decision";
    if (details["kind"] === "over-budget") return "over-budget";
  }
  return error.code === "budget-exhausted" ? "budget-exhausted" : "model-failed";
}

const modelDecision: ModelDecisionPort = {
  async decide(input) {
    const messages: NormalizedMessage[] = [{ role: "user", content: input.user }];
    const fail = (status: Exclude<DecisionResult["status"], "ok">): DecisionResult => ({ status, decision: null, messages });
    const seen = new Set<string>();
    let corrected = false;
    let usedTools = 0;
    // 预算停止：某轮因工具限额或上下文阈值被拦截后，先向模型回传 budget-exhausted 工具错误，
    // 并只保留一个收尾轮——工具继续拒绝、模型须直接提交 decision_submit，未获接受即按 over-budget 结束。
    let awaitingBudgetStop = false;
    for (let round = 1; round <= input.maxRounds; round += 1) {
      let response;
      try {
        ({ response } = await input.call({
          system: input.system, messages: [...messages], tools: input.tools, output: { kind: "text" }, round,
          inputLimit: round === 1 ? input.firstInputLimit : input.inputLimit,
        }));
      } catch (error) {
        return fail(classify(error));
      }
      if (response.finishReason === "length" || response.finishReason === "refusal") return fail("invalid-decision");
      const { toolCalls, text, providerReplay } = response;
      if ((response.finishReason === "tool_calls") !== (toolCalls.length > 0) ||
        new Set(toolCalls.map(({ id }) => id)).size !== toolCalls.length ||
        toolCalls.some(({ id }) => seen.has(id))) return fail("invalid-decision");
      for (const { id } of toolCalls) seen.add(id);
      messages.push({ role: "assistant", content: text, toolCalls, providerReplay });
      if (toolCalls.length === 0) {
        if (awaitingBudgetStop) return fail("over-budget");
        if (corrected || round === input.maxRounds) return fail("invalid-decision");
        corrected = true;
        messages.push({ role: "user", content: input.nudgeSubmit });
        continue;
      }

      const results = new Map<string, ToolResult>();
      const available = Math.min(input.maxCallsPerRound, input.maxCallsPerTurn - usedTools);
      const pendingTools = toolCalls.filter(({ name }) => name !== submit);
      const callsToRun = pendingTools.slice(0, available);
      const inputAfterAssistant = estimateModelInputTokens({
        system: input.system, messages, tools: input.tools, output: { kind: "text" },
      });
      const viewBudget = callsToRun.reduce((total, { name }) => total + (input.toolViewLimits.get(name) ?? 0) + 4, 0);
      const budgetBlocked = awaitingBudgetStop ||
        (pendingTools.length > 0 && (available === 0 || inputAfterAssistant + viewBudget > input.inputLimit));
      let usedThisRound = 0;
      for (const call of toolCalls) {
        if (call.name === submit) continue;
        if (budgetBlocked || usedThisRound >= input.maxCallsPerRound || usedTools >= input.maxCallsPerTurn) {
          results.set(call.id, errorTool(call.id, { error: "budget-exhausted", detail: input.budgetStop }));
          continue;
        }
        usedThisRound += 1;
        usedTools += 1;
        const result = await input.executeTool(call, round);
        results.set(call.id, { role: "tool", toolCallId: call.id, content: result.modelText, isError: result.isError });
      }

      const submissions = toolCalls.filter(({ name }) => name === submit);
      const candidate = submissions[0];
      const validated = candidate === undefined ? null : input.validate(candidate.parseError === null ? candidate.arguments : null);
      if (candidate !== undefined && validated !== null) {
        results.set(candidate.id, "decision" in validated
          ? { role: "tool", toolCallId: candidate.id, content: canonicalJson({ status: "accepted" }), isError: false }
          : errorTool(candidate.id, { error: "invalid_decision", details: [...validated.reasons] }));
      }
      for (const duplicate of submissions.slice(1)) {
        results.set(duplicate.id, errorTool(duplicate.id, { error: "duplicate_decision_submit" }));
      }
      for (const { id } of toolCalls) {
        const result = results.get(id);
        if (result === undefined) throw new Error("Model tool call has no paired result");
        messages.push(result);
      }
      if (validated !== null) {
        if ("decision" in validated) return { status: "ok", decision: validated.decision, messages };
        if (corrected || round === input.maxRounds) return fail("invalid-decision");
        corrected = true;
      }
      if (awaitingBudgetStop) return fail("over-budget");
      if (budgetBlocked) {
        if (round === input.maxRounds) return fail("over-budget");
        awaitingBudgetStop = true;
      }
    }
    return fail("budget-exhausted");
  },

  async speak({ request, call, inputLimit, round }) {
    const { response } = await call({
      system: request.system, messages: [{ role: "user", content: request.user }],
      tools: [], output: request.output, round, inputLimit,
    });
    return response.json;
  },
};

export function createModelDecisionModule(input: ModuleCreateInput) {
  resolveAgentModelRoutes({
    view: input.ports["agent.model-pool"], moduleId: input.moduleId, requirements: modelDecisionPurposeRequirements,
  });
  return createStatelessModule(input, modelDecision);
}
