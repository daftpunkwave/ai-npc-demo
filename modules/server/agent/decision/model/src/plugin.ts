/**
 * 执行有界的模型决策循环，并为独立的对白请求调用模型。
 * 通过宿主回调取得模型、工具结果以及按实际请求校验的决定。
 * 禁止直接提交世界命令、复用携密输入生成对白或发出未配对的工具历史。
 */
import {
  canonicalJson, DomainError, estimateModelInputTokens, type Json, type ModuleCreateInput, type NormalizedMessage,
} from "@world-prism/contracts";
import {
  createStatelessModule, modelDecisionPurposeRequirements, resolveAgentModelRoutes, type DecisionRejection, type ModelDecisionPort,
} from "@world-prism/module-sdk";

type DecisionResult = Awaited<ReturnType<ModelDecisionPort["decide"]>>;
type ToolResult = Extract<NormalizedMessage, { role: "tool" }>;
const submit = "decision_submit";

// 工具错误载荷是模型可见契约：error 键取值 budget-exhausted（与平台 DomainError 码同族）、
// invalid_decision 与 duplicate_decision_submit；这些值已被集成测试断言并随请求归档进入历史证据，
// 调整键名前必须同步验证测试与历史回放兼容。invalid_decision 另带 details（内容包规则说明）
// 与 violations（逐字段违规明细，只增不改）。
function errorTool(toolCallId: string, value: Json): ToolResult {
  return { role: "tool", toolCallId, content: canonicalJson(value), isError: true };
}

// 非 ok 终态保留既有失败类别（status 语义不变），细分原因供终态记录区分：
// round-limit 轮次达到上限、call-budget 额度账本耗尽、context-window 内容窗口不足、deadline-backpressure 截止余量不足。
function classify(error: unknown): { status: Exclude<DecisionResult["status"], "ok">; reason: string | null } {
  if (!(error instanceof DomainError) || error.code === "cancelled") throw error;
  const details = error.details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    if (details["finishReason"] === "length" || details["finishReason"] === "refusal") {
      return { status: "invalid-decision", reason: null };
    }
    if (details["kind"] === "over-budget") return { status: "over-budget", reason: "context-window" };
    if (details["kind"] === "backpressure") return { status: "model-failed", reason: "deadline-backpressure" };
  }
  return error.code === "budget-exhausted"
    ? { status: "budget-exhausted", reason: "call-budget" }
    : { status: "model-failed", reason: null };
}

function rejectionPayload(rejection: DecisionRejection): Json {
  return {
    error: "invalid_decision", details: [...rejection.reasons],
    ...(rejection.violations === undefined ? {} : { violations: rejection.violations as unknown as Json }),
  };
}

const modelDecision: ModelDecisionPort = {
  async decide(input) {
    const messages: NormalizedMessage[] = [{ role: "user", content: input.user }];
    let rejection: DecisionRejection | undefined;
    const fail = (status: Exclude<DecisionResult["status"], "ok">, reason: string | null = null): DecisionResult =>
      ({ status, decision: null, reason, messages, ...(status === "invalid-decision" && rejection !== undefined ? { rejection } : {}) });
    const seen = new Set<string>();
    let corrected = false;
    let usedTools = 0;
    // 预算停止：某轮因工具限额或上下文阈值被拦截后，先向模型回传 budget-exhausted 工具错误，
    // 并只保留一个收尾轮——工具继续拒绝、模型须直接提交 decision_submit，未获接受即按 over-budget 结束。
    let awaitingBudgetStop = false;
    let budgetStopReason: "call-budget" | "context-window" = "call-budget";
    // 改正轮：最后一轮或收尾轮的提交被驳回、且本 turn 的单次纠偏机会尚未使用时，额外给一轮只接受
    // decision_submit 的请求。该轮不计入 maxRounds，但仍计入每 turn 的模型调用上限，其中的其他工具一律拒绝。
    let lastRound = input.maxRounds;
    let correctionRound = false;
    for (let round = 1; round <= lastRound; round += 1) {
      // turn 截止或运行时停止后不再发起新一轮模型调用：继续调用会占用并发与预算且结果必被丢弃。
      if (input.signal.aborted) return fail("model-failed", "deadline-backpressure");
      let response;
      try {
        ({ response } = await input.call({
          system: input.system, messages: [...messages], tools: input.tools, output: { kind: "text" }, round,
          inputLimit: round === 1 ? input.firstInputLimit : input.inputLimit,
        }));
      } catch (error) {
        const { status, reason } = classify(error);
        return fail(status, reason);
      }
      if (response.finishReason === "length" || response.finishReason === "refusal") return fail("invalid-decision");
      const { toolCalls, text, providerReplay } = response;
      if ((response.finishReason === "tool_calls") !== (toolCalls.length > 0) ||
        new Set(toolCalls.map(({ id }) => id)).size !== toolCalls.length ||
        toolCalls.some(({ id }) => seen.has(id))) return fail("invalid-decision");
      for (const { id } of toolCalls) seen.add(id);
      messages.push({ role: "assistant", content: text, toolCalls, providerReplay });
      if (toolCalls.length === 0) {
        if (awaitingBudgetStop) return fail("over-budget", budgetStopReason);
        if (corrected || round >= input.maxRounds) return fail("invalid-decision");
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
      // 调用次数用完归 call-budget，工具视图放不下输入窗口归 context-window，两者共用同一轮内停止行为；
      // 改正轮同样只接受 decision_submit。
      const callBudgetBlocked = awaitingBudgetStop || correctionRound || (pendingTools.length > 0 && available === 0);
      const windowBlocked = !callBudgetBlocked && pendingTools.length > 0 &&
        inputAfterAssistant + viewBudget > input.inputLimit;
      const budgetBlocked = callBudgetBlocked || windowBlocked;
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
          : errorTool(candidate.id, rejectionPayload(validated)));
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
        if ("decision" in validated) return { status: "ok", decision: validated.decision, reason: null, messages };
        rejection = validated;
        if (corrected) return fail("invalid-decision");
        corrected = true;
        if (round === lastRound || awaitingBudgetStop) {
          lastRound = round + 1;
          correctionRound = true;
          awaitingBudgetStop = false;
          continue;
        }
      }
      if (correctionRound) return fail("invalid-decision");
      if (awaitingBudgetStop) return fail("over-budget", budgetStopReason);
      if (budgetBlocked) {
        budgetStopReason = callBudgetBlocked ? "call-budget" : "context-window";
        if (round === input.maxRounds) return fail("over-budget", budgetStopReason);
        awaitingBudgetStop = true;
      }
    }
    return fail("budget-exhausted", "round-limit");
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
