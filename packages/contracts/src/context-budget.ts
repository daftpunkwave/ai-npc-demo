/**
 * 核心职责：按上下文预算契约把模型窗口换算为有效输入上限与首轮目标上限。
 * 交互契约：接收 ContextBuildRequest 的 budget 与 modelWindowTokens，返回不小于 1 的 token 上限。
 * 约束与禁忌：不得读取模型能力、供应商 tokenizer、配置槽或实际 usage。
 */
import type { ContextBuildRequest } from "./agent-runtime";

/** 一次上下文构建可使用的有效输入上限与首轮目标上限。 */
export interface ContextTokenLimits {
  /** min(maxInputTokens, 模型窗口 − 输出预留 − 安全余量)，至少为 1。 */
  readonly effectiveMaxTokens: number;
  /** 有效输入上限再扣除工具循环预留后的目标上限，至少为 1。 */
  readonly targetTokens: number;
}

/**
 * 计算有效输入上限与首轮目标上限。
 * 模型输出预留和安全余量必须先于 maxInputTokens 从模型窗口扣除，否则输入加输出可能超过窗口。
 */
export function resolveContextTokenLimits(
  request: Pick<ContextBuildRequest, "budget" | "modelWindowTokens">,
): ContextTokenLimits {
  const windowInputTokens = request.modelWindowTokens -
    request.budget.reservedOutputTokens -
    request.budget.safetyTokens;
  const effectiveMaxTokens = Math.max(1, Math.min(request.budget.maxInputTokens, windowInputTokens));
  return {
    effectiveMaxTokens,
    targetTokens: Math.max(1, effectiveMaxTokens - request.budget.toolLoopReserveTokens),
  };
}
