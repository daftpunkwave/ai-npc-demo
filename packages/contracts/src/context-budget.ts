/**
 * 核心职责：按上下文预算契约把模型窗口换算为有效输入上限与首轮目标上限。
 * 交互契约：接收 ContextBuildRequest 的 phase、budget 与 modelWindowTokens，返回 0 表示预算不可满足。
 * 约束与禁忌：不得读取模型能力、供应商 tokenizer、配置槽或实际 usage。
 */
import type { ContextBuildRequest } from "./agent-runtime";

/** 一次上下文构建可使用的有效输入上限与首轮目标上限。 */
export interface ContextTokenLimits {
  /** min(maxInputTokens, 模型窗口 − 输出预留 − 安全余量)；0 表示窗口放不下预留。 */
  readonly effectiveMaxTokens: number;
  /** decision 扣除工具循环预留后的目标上限，speech 与有效输入上限相同；0 表示没有可用目标预算。 */
  readonly targetTokens: number;
}

/**
 * 计算有效输入上限与首轮目标上限。
 * 模型输出预留和安全余量必须先于 maxInputTokens 从模型窗口扣除，否则输入加输出可能超过窗口。
 * 只有 decision 首轮需要为工具循环预留空间，speech 不执行工具循环。
 * 窗口不足以容纳预留时返回 0，调用方必须拒绝发送请求，不能把下限钳制成正数。
 */
export function resolveContextTokenLimits(
  request: Pick<ContextBuildRequest, "phase" | "budget" | "modelWindowTokens">,
): ContextTokenLimits {
  const windowInputTokens = request.modelWindowTokens -
    request.budget.reservedOutputTokens -
    request.budget.safetyTokens;
  const effectiveMaxTokens = Math.max(0, Math.min(request.budget.maxInputTokens, windowInputTokens));
  const toolLoopReserveTokens = request.phase === "decision" ? request.budget.toolLoopReserveTokens : 0;
  return {
    effectiveMaxTokens,
    targetTokens: Math.max(0, effectiveMaxTokens - toolLoopReserveTokens),
  };
}
