/**
 * 核心职责：构造控制台调试队列、证据重放与 Agent 唤醒请求。
 * 交互契约：依赖已绑定会话的控制台请求函数，唤醒已提供时沿用调用方的 operationId。
 * 约束与禁忌：不执行重放、不调用模型、不在客户端修改分支状态。
 */
import {
  debugQueuesResponseSchema,
  debugWakeRequestSchema,
  debugWakeResponseSchema,
  turnReplayResponseSchema,
} from "@ai-npc/contracts";
import type { ConsoleRequest } from "./request";

export function createDebugHttp(request: ConsoleRequest) {
  return {
    consoleDebugQueues() {
      return request(debugQueuesResponseSchema, "/api/v1/console/debug/queues");
    },

    consoleReplayTurn(turnId: string) {
      return request(
        turnReplayResponseSchema,
        `/api/v1/console/debug/turns/${encodeURIComponent(turnId)}/replay`,
        { method: "POST", body: {} },
      );
    },

    consoleWakeAgent(agentId: string, reason: string, operationId: string) {
      return request(
        debugWakeResponseSchema,
        `/api/v1/console/debug/agents/${encodeURIComponent(agentId)}/wake`,
        { method: "POST", body: debugWakeRequestSchema.parse({ reason, operationId }) },
      );
    },
  };
}
