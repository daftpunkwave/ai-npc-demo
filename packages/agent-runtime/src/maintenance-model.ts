/**
 * 核心职责：把 run 模型端口按 Agent、维护任务和租约绑定成 scoped 句柄。
 * 交互契约：只注入预算、截止时间、fence 与 memory-maintenance 用途，不读取凭据。
 * 约束与禁忌：禁止跨 Agent 复用、越过模型池或让模块自行选择路由。
 */
import type { HostServices, MemoryScope } from "@ai-npc/contracts";
import type { ResolvedAgentProfile } from "@ai-npc/experiment";
import type { ModelWorkScope, RunModelPort, ScopedModelPort } from "@ai-npc/module-sdk";
import type { ClaimedMaintenance } from "./memory-maintenance-queue";

export function maintenanceModel(input: {
  readonly model: RunModelPort | null | undefined;
  readonly agentId: string;
  readonly claim: ClaimedMaintenance;
  readonly scope: MemoryScope;
  readonly runId: string;
  readonly profile: ResolvedAgentProfile;
  readonly host: HostServices;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}): ScopedModelPort | null {
  if (input.model == null) return null;
  const route = input.model.route(input.agentId, "memory-maintenance");
  return {
    scope: { runId: input.runId, agentId: input.agentId, purpose: "memory-maintenance" },
    call: async (request) => {
      const work: ModelWorkScope = {
        ...input.scope,
        runId: input.runId,
        workRef: request.workRef,
        traceId: input.host.ids("trc"),
        worldTick: input.claim.task.dueTick,
        triggerPrincipalIds: [],
        maxModelCalls: 1,
        maxDailyTokens: input.profile.budgets.maxTokensPerAgentPerDay,
        deadlineMs: input.host.monotonicMs() + 120_000,
        signal: input.signal,
        fence: () => request.fence() && input.isCurrent(),
      };
      return input.model!.call(
        work,
        "memory-maintenance",
        input.profile.budgets.reserveOutputTokens["memory-maintenance"],
        {
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          output: request.output,
          round: 1,
          inputLimit: Math.max(1, route.capabilities.contextWindowTokens - request.reserveOutputTokens),
        },
      );
    },
  };
}