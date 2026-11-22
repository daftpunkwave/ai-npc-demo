/**
 * 核心职责：注册控制台研究员的 Agent 检查器、记忆、观察、turn、artifact、trace、分支比较与调试入口。
 * 交互契约：依赖控制台角色守卫、宿主研究端口和公共查询 schema；不直接读取数据库。
 * 约束与禁忌：禁止运营角色读取研究真值，禁止把 replay 结果伪装成新的模型调用，也不向玩家角色开放。
 */
import {
  debugQueuesResponseSchema,
  debugWakeRequestSchema,
  debugWakeResponseSchema,
  memoryDiffQuerySchema,
  memoryDiffResponseSchema,
  memoryResponseSchema,
  observationsQuerySchema,
  observationsResponseSchema,
  artifactQuerySchema,
  artifactResponseSchema,
  agentInspectorQuerySchema,
  agentInspectorResponseSchema,
  branchCompareQuerySchema,
  branchCompareResponseSchema,
  idSchemas,
  principalIdSchema,
  traceResponseSchema,
  turnDetailSchema,
  turnReplayResponseSchema,
  turnsQuerySchema,
  turnsResponseSchema,
} from "@ai-npc/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireConsoleRole, sendHttpError } from "./context";
import type { RouteContext } from "./context";
import { queryInteger, queryText } from "./query";

const researchRoles = ["researcher"] as const;

function pathText(params: unknown, key: string): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  // key 只来自本文件固定路由字段名，不接受调用方拼接。
  // eslint-disable-next-line security/detect-object-injection
  const value = (params as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireResearchSession(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const session = authenticate(context, request, reply);
  if (session === null || !requireConsoleRole(context, request, session, reply, researchRoles)) return null;
  return session;
}

export function registerConsoleResearchRoutes(context: RouteContext): void {
  const { app, branch, options } = context;

  app.get("/api/v1/console/agents/:agentId/inspector", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.inspector === undefined) return sendHttpError(reply, "not-ready", "Agent 检查器尚未就绪");
    const agentId = pathText(request.params, "agentId");
    const parsedQuery = agentInspectorQuerySchema.safeParse(request.query);
    const parsedAgent = principalIdSchema.safeParse(agentId);
    if (!parsedQuery.success || !parsedAgent.success) return sendHttpError(reply, "validation", "Agent 检查器查询参数不合法");
    return agentInspectorResponseSchema.parse(options.console.inspector(parsedAgent.data, parsedQuery.data.branchId));
  });

  app.get("/api/v1/console/agents/:agentId/memory", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.memory === undefined) return sendHttpError(reply, "not-ready", "记忆查询尚未就绪");
    const agentId = principalIdSchema.safeParse(pathText(request.params, "agentId"));
    const raw = request.query as Readonly<Record<string, unknown>> | undefined;
    const revision = queryInteger(raw, "revision", -1);
    const branchId = queryText(raw, "branchId");
    if (!agentId.success || revision === null || revision < 0 || branchId === undefined) {
      return sendHttpError(reply, "validation", "记忆查询参数不合法");
    }
    return memoryResponseSchema.parse(options.console.memory(agentId.data, branchId, revision));
  });

  app.get("/api/v1/console/agents/:agentId/memory/diff", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.memoryDiff === undefined) return sendHttpError(reply, "not-ready", "记忆差异查询尚未就绪");
    const agentId = principalIdSchema.safeParse(pathText(request.params, "agentId"));
    const from = queryInteger(request.query, "from", -1);
    const to = queryInteger(request.query, "to", -1);
    const branchId = queryText(request.query, "branchId");
    const parsed = memoryDiffQuerySchema.safeParse({ branchId, from, to });
    if (!agentId.success || !parsed.success) return sendHttpError(reply, "validation", "记忆差异查询参数不合法");
    return memoryDiffResponseSchema.parse(options.console.memoryDiff(
      agentId.data,
      parsed.data.branchId,
      parsed.data.from,
      parsed.data.to,
    ));
  });

  app.get("/api/v1/console/agents/:agentId/observations", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.observations === undefined) return sendHttpError(reply, "not-ready", "观察查询尚未就绪");
    const agentId = principalIdSchema.safeParse(pathText(request.params, "agentId"));
    const raw = request.query as Readonly<Record<string, unknown>> | undefined;
    const fromSeq = queryInteger(raw, "fromSeq", 0);
    const limit = queryInteger(raw, "limit", 100);
    const branchId = queryText(raw, "branchId");
    const parsed = observationsQuerySchema.safeParse({ branchId, fromSeq, limit });
    if (!agentId.success || !parsed.success) return sendHttpError(reply, "validation", "观察查询参数不合法");
    return observationsResponseSchema.parse(options.console.observations(
      agentId.data,
      parsed.data.branchId,
      parsed.data.fromSeq,
      parsed.data.limit,
    ));
  });

  app.get("/api/v1/console/turns", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.turns === undefined) return sendHttpError(reply, "not-ready", "turn 查询尚未就绪");
    const runId = queryText(request.query, "runId");
    const agentId = queryText(request.query, "agentId");
    const status = queryText(request.query, "status");
    const limit = queryInteger(request.query, "limit", 50);
    const parsedRunId = runId === undefined ? null : idSchemas.run.safeParse(runId);
    const parsedAgentId = agentId === undefined ? null : principalIdSchema.safeParse(agentId);
    const parsed = turnsQuerySchema.safeParse({
      ...(runId === undefined ? {} : { runId }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(status === undefined ? {} : { status }),
      ...(limit === null ? {} : { limit }),
    });
    if (!parsed.success || (parsedRunId !== null && !parsedRunId.success) ||
      (parsedAgentId !== null && !parsedAgentId.success) || limit === null || limit < 1 || limit > 200) {
      return sendHttpError(reply, "validation", "turn 查询参数不合法");
    }
    return turnsResponseSchema.parse(options.console.turns(parsed.data));
  });

  app.get("/api/v1/console/turns/:turnId", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.turn === undefined) return sendHttpError(reply, "not-ready", "turn 详情尚未就绪");
    const parsed = idSchemas.turn.safeParse(pathText(request.params, "turnId"));
    if (!parsed.success) return sendHttpError(reply, "validation", "turnId 不合法");
    return turnDetailSchema.parse(options.console.turn(parsed.data));
  });

  app.get("/api/v1/console/artifacts/:artifactId", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.artifact === undefined) return sendHttpError(reply, "not-ready", "artifact 查询尚未就绪");
    const parsedId = idSchemas.art.safeParse(pathText(request.params, "artifactId"));
    const parsedQuery = artifactQuerySchema.safeParse({ view: queryText(request.query, "view") });
    if (!parsedId.success || !parsedQuery.success) return sendHttpError(reply, "validation", "artifact 查询参数不合法");
    return artifactResponseSchema.parse(options.console.artifact(parsedId.data, parsedQuery.data.view));
  });

  app.get("/api/v1/console/traces/:traceId", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.trace === undefined) return sendHttpError(reply, "not-ready", "trace 查询尚未就绪");
    const parsed = idSchemas.trc.safeParse(pathText(request.params, "traceId"));
    if (!parsed.success) return sendHttpError(reply, "validation", "traceId 不合法");
    return traceResponseSchema.parse(options.console.trace(parsed.data));
  });

  app.get("/api/v1/console/branches/compare", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.branchCompare === undefined) return sendHttpError(reply, "not-ready", "分支比较尚未就绪");
    const left = queryText(request.query, "left");
    const right = queryText(request.query, "right");
    const atSeq = queryInteger(request.query, "atSeq", -1);
    const parsed = branchCompareQuerySchema.safeParse({ left, right, atSeq });
    if (!parsed.success) return sendHttpError(reply, "validation", "分支比较参数不合法");
    return branchCompareResponseSchema.parse(options.console.branchCompare(parsed.data.left, parsed.data.right, parsed.data.atSeq));
  });

  app.get("/api/v1/console/debug/queues", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.debugQueues === undefined) return sendHttpError(reply, "not-ready", "调试队列尚未就绪");
    return debugQueuesResponseSchema.parse(options.console.debugQueues(branch.branchId));
  });

  app.post("/api/v1/console/debug/turns/:turnId/replay", async (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.replayTurn === undefined) return sendHttpError(reply, "not-ready", "turn 重放尚未就绪");
    const parsed = idSchemas.turn.safeParse(pathText(request.params, "turnId"));
    if (!parsed.success) return sendHttpError(reply, "validation", "turnId 不合法");
    return turnReplayResponseSchema.parse(await options.console.replayTurn(parsed.data));
  });

  app.post("/api/v1/console/debug/agents/:agentId/wake", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.debugWake === undefined) return sendHttpError(reply, "not-ready", "调试唤醒尚未就绪");
    const agentId = principalIdSchema.safeParse(pathText(request.params, "agentId"));
    const body = debugWakeRequestSchema.safeParse(request.body);
    if (!agentId.success || !body.success) return sendHttpError(reply, "validation", "调试唤醒请求结构不合法");
    return debugWakeResponseSchema.parse(options.console.debugWake(
      agentId.data,
      body.data.reason,
      body.data.operationId,
      branch.branchId,
    ));
  });
}
