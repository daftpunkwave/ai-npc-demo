/**
 * 核心职责：实现不改变 artifact 的压缩策略。
 * 交互契约：超过目标预算时返回 cannot-fit，否则返回 not-triggered 并保留原始段落。
 * 约束与禁忌：不得静默裁剪、调用模型或写回 artifact。
 */
import type { Json, ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { AgentCompressionPort } from "@ai-npc/module-sdk";
import { createStatelessModule } from "@ai-npc/module-sdk";

class NoneCompressionPort implements AgentCompressionPort {
  compress(input: Parameters<AgentCompressionPort["compress"]>[0]): ReturnType<AgentCompressionPort["compress"]> {
    const cannotFit = input.artifact.tokenEstimate > input.targetTokens;
    return {
      status: cannotFit ? "cannot-fit" : "not-triggered",
      system: input.artifact.system,
      segments: input.artifact.segments,
      lossReport: {
        policy: "none",
        effectiveMaxTokens: input.effectiveMaxTokens,
        targetTokens: input.targetTokens,
        inputTokens: input.artifact.tokenEstimate,
        outputTokens: input.artifact.tokenEstimate,
        cannotFit,
      } satisfies Json,
    };
  }
}

export function createCompressionNoneModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, new NoneCompressionPort());
}