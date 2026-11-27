/**
 * 核心职责：构造研究控制台的时间线、Agent、记忆、turn 与分支证据读取请求。
 * 交互契约：依赖已绑定会话的控制台请求函数与公共 DTO，服务端裁决证据访问范围。
 * 约束与禁忌：不拼装世界事实、不替代服务端授权或原文读取审计。
 */
import {
  agentInspectorResponseSchema,
  agentsResponseSchema,
  artifactResponseSchema,
  branchCompareResponseSchema,
  memoryDiffResponseSchema,
  memoryResponseSchema,
  observationsResponseSchema,
  timelineResponseSchema,
  traceResponseSchema,
  turnDetailSchema,
  turnsResponseSchema,
} from "@world-prism/contracts";
import { queryString, type ConsoleRequest } from "./request";

export function createResearchHttp(request: ConsoleRequest) {
  return {
    consoleTimeline(input: {
      readonly branchId?: string;
      readonly fromSeq?: number;
      readonly limit?: number;
      readonly order?: "asc" | "desc";
      readonly types?: readonly string[];
      readonly agentId?: string;
      readonly nodeId?: string;
    }, signal?: AbortSignal) {
      return request(
        timelineResponseSchema,
        `/api/v1/console/timeline${queryString({
          branchId: input.branchId,
          fromSeq: input.fromSeq ?? 0,
          limit: input.limit ?? 100,
          order: input.order,
          types: input.types?.join(","),
          agentId: input.agentId,
          nodeId: input.nodeId,
        })}`,
        { signal },
      );
    },

    consoleAgents(branchId: string, signal?: AbortSignal) {
      return request(agentsResponseSchema, `/api/v1/console/agents${queryString({ branchId })}`, { signal });
    },

    consoleInspector(agentId: string, branchId: string, signal?: AbortSignal) {
      return request(
        agentInspectorResponseSchema,
        `/api/v1/console/agents/${encodeURIComponent(agentId)}/inspector${queryString({ branchId })}`,
        { signal },
      );
    },

    consoleMemory(agentId: string, branchId: string, revision: number) {
      return request(
        memoryResponseSchema,
        `/api/v1/console/agents/${encodeURIComponent(agentId)}/memory${queryString({ branchId, revision })}`,
      );
    },

    consoleMemoryDiff(agentId: string, branchId: string, from: number, to: number) {
      return request(
        memoryDiffResponseSchema,
        `/api/v1/console/agents/${encodeURIComponent(agentId)}/memory/diff${queryString({ branchId, from, to })}`,
      );
    },

    consoleObservations(agentId: string, branchId: string, fromSeq = 0, limit = 100) {
      return request(
        observationsResponseSchema,
        `/api/v1/console/agents/${encodeURIComponent(agentId)}/observations${queryString({ branchId, fromSeq, limit })}`,
      );
    },

    consoleTurns(input: {
      readonly runId?: string;
      readonly branchId?: string;
      readonly agentId?: string;
      readonly status?: string;
      readonly limit?: number;
    } = {}, signal?: AbortSignal) {
      return request(
        turnsResponseSchema,
        `/api/v1/console/turns${queryString({
          runId: input.runId,
          branchId: input.branchId,
          agentId: input.agentId,
          status: input.status,
          limit: input.limit,
        })}`,
        { signal },
      );
    },

    consoleTurn(turnId: string, signal?: AbortSignal) {
      return request(turnDetailSchema, `/api/v1/console/turns/${encodeURIComponent(turnId)}`, { signal });
    },

    consoleArtifact(artifactId: string, view: "redacted" | "raw") {
      return request(
        artifactResponseSchema,
        `/api/v1/console/artifacts/${encodeURIComponent(artifactId)}${queryString({ view })}`,
      );
    },

    consoleTrace(traceId: string, signal?: AbortSignal) {
      return request(traceResponseSchema, `/api/v1/console/traces/${encodeURIComponent(traceId)}`, { signal });
    },

    consoleBranchCompare(left: string, right: string, atSeq: number) {
      return request(
        branchCompareResponseSchema,
        `/api/v1/console/branches/compare${queryString({ left, right, atSeq })}`,
      );
    },
  };
}
