/**
 * 核心职责：按 context estimate-v1 口径计算文本与请求的 token 估值。
 * 交互契约：只接收字符串，返回非负整数且不依赖供应商 tokenizer。
 * 约束与禁忌：不得读取环境、模型能力或实际 usage。
 */
import { estimateSystemAndUserTokens } from "@ai-npc/contracts";
export { estimateTokens } from "@ai-npc/contracts";

export function estimateContextTokens(system: string, userSegments: readonly string[]): number {
  return estimateSystemAndUserTokens(system, userSegments.join("\n\n"));
}
