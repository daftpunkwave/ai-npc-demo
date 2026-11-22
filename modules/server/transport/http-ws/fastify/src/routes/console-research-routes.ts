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
import { z } from "zod";
import { authenticate, requireConsoleRole, sendHttpError } from "./context";
import type { RouteContext } from "./context";
import { queryInteger, queryText } from "./query";

const researchRoles = ["researcher"] as const;
const agentParamsSchema = z.object({ agentId: principalIdSchema }).strict();
const turnParamsSchema = z.object({ turnId: idSchemas.turn }).strict();
const artifactParamsSchema = z.object({ artifactId: idSchemas.art }).strict();
const traceParamsSchema = z.object({ traceId: idSchemas.trc }).strict();

function parsePath<T>(schema: z.ZodType<T>, params: unknown): T | null {
  const parsed = schema.safeParse(params);
  return parsed.success ? parsed.data : null;
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
    const path = parsePath(agentParamsSchema, request.params);
    const parsedQuery = agentInspectorQuerySchema.safeParse(request.query);
    if (!parsedQuery.success || path === null) return sendHttpError(reply, "validation", "Agent 检查器查询参数不合法");
    return agentInspectorResponseSchema.parse(options.console.inspector({
      agentId: path.agentId,
      branchId: parsedQuery.data.branchId,
    }));
  });

  app.get("/api/v1/console/agents/:agentId/memory", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.memory === undefined) return sendHttpError(reply, "not-ready", "记忆查询尚未就绪");
    const path = parsePath(agentParamsSchema, request.params);
    const raw = request.query as Readonly<Record<string, unknown>> | undefined;
    const revision = queryInteger(raw, "revision", -1);
    const branchId = queryText(raw, "branchId");
    if (path === null || revision === null || revision < 0 || branchId === undefined) {
      return sendHttpError(reply, "validation", "记忆查询参数不合法");
    }
    return memoryResponseSchema.parse(options.console.memory({
      agentId: path.agentId,
      branchId,
      revision,
    }));
  });

  app.get("/api/v1/console/agents/:agentId/memory/diff", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.memoryDiff === undefined) return sendHttpError(reply, "not-ready", "记忆差异查询尚未就绪");
    const path = parsePath(agentParamsSchema, request.params);
    const from = queryInteger(request.query, "from", -1);
    const to = queryInteger(request.query, "to", -1);
    const branchId = queryText(request.query, "branchId");
    const parsed = memoryDiffQuerySchema.safeParse({ branchId, from, to });
    if (path === null || !parsed.success) return sendHttpError(reply, "validation", "记忆差异查询参数不合法");
    return memoryDiffResponseSchema.parse(options.console.memoryDiff({
      agentId: path.agentId,
      branchId: parsed.data.branchId,
      fromRevision: parsed.data.from,
      toRevision: parsed.data.to,
    }));
  });

  app.get("/api/v1/console/agents/:agentId/observations", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.observations === undefined) return sendHttpError(reply, "not-ready", "观察查询尚未就绪");
    const path = parsePath(agentParamsSchema, request.params);
    const raw = request.query as Readonly<Record<string, unknown>> | undefined;
    const fromSeq = queryInteger(raw, "fromSeq", 0);
    const limit = queryInteger(raw, "limit", 100);
    const branchId = queryText(raw, "branchId");
    const parsed = observationsQuerySchema.safeParse({ branchId, fromSeq, limit });
    if (path === null || !parsed.success) return sendHttpError(reply, "validation", "观察查询参数不合法");
    return observationsResponseSchema.parse(options.console.observations({
      agentId: path.agentId,
      branchId: parsed.data.branchId,
      fromSeq: parsed.data.fromSeq,
      limit: parsed.data.limit,
    }));
  });

  app.get("/api/v1/console/turns", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.turns === undefined) return sendHttpError(reply, "not-ready", "turn 查询尚未就绪");
    const runId = queryText(request.query, "runId");
    const branchId = queryText(request.query, "branchId");
    const agentId = queryText(request.query, "agentId");
    const status = queryText(request.query, "status");
    const limit = queryInteger(request.query, "limit", 50);
    const parsedRunId = runId === undefined ? null : idSchemas.run.safeParse(runId);
    const parsedAgentId = agentId === undefined ? null : principalIdSchema.safeParse(agentId);
    const parsed = turnsQuerySchema.safeParse({
      ...(runId === undefined ? {} : { runId }),
      ...(branchId === undefined ? {} : { branchId }),
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
    const path = parsePath(turnParamsSchema, request.params);
    if (path === null) return sendHttpError(reply, "validation", "turnId 不合法");
    return turnDetailSchema.parse(options.console.turn({ turnId: path.turnId }));
  });

  app.get("/api/v1/console/artifacts/:artifactId", (request, reply) => {
    const session = requireResearchSession(context, request, reply);
    if (session === null) return;
    if (options.console?.artifact === undefined) return sendHttpError(reply, "not-ready", "artifact 查询尚未就绪");
    const path = parsePath(artifactParamsSchema, request.params);
    const parsedQuery = artifactQuerySchema.safeParse({ view: queryText(request.query, "view") });
    if (path === null || !parsedQuery.success) return sendHttpError(reply, "validation", "artifact 查询参数不合法");
    return artifactResponseSchema.parse(options.console.artifact({
      artifactId: path.artifactId,
      view: parsedQuery.data.view,
      principalId: session.auth.principalId,
    }));
  });

  app.get("/api/v1/console/traces/:traceId", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.trace === undefined) return sendHttpError(reply, "not-ready", "trace 查询尚未就绪");
    const path = parsePath(traceParamsSchema, request.params);
    if (path === null) return sendHttpError(reply, "validation", "traceId 不合法");
    return traceResponseSchema.parse(options.console.trace({ traceId: path.traceId }));
  });

  app.get("/api/v1/console/branches/compare", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.branchCompare === undefined) return sendHttpError(reply, "not-ready", "分支比较尚未就绪");
    const left = queryText(request.query, "left");
    const right = queryText(request.query, "right");
    const atSeq = queryInteger(request.query, "atSeq", -1);
    const parsed = branchCompareQuerySchema.safeParse({ left, right, atSeq });
    if (!parsed.success) return sendHttpError(reply, "validation", "分支比较参数不合法");
    return branchCompareResponseSchema.parse(options.console.branchCompare({
      leftBranchId: parsed.data.left,
      rightBranchId: parsed.data.right,
      atSeq: parsed.data.atSeq,
    }));
  });

  app.get("/api/v1/console/debug/queues", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.debugQueues === undefined) return sendHttpError(reply, "not-ready", "调试队列尚未就绪");
    return debugQueuesResponseSchema.parse(options.console.debugQueues({ branchId: branch.branchId }));
  });

  app.post("/api/v1/console/debug/turns/:turnId/replay", async (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.replayTurn === undefined) return sendHttpError(reply, "not-ready", "turn 重放尚未就绪");
    const path = parsePath(turnParamsSchema, request.params);
    if (path === null) return sendHttpError(reply, "validation", "turnId 不合法");
    return turnReplayResponseSchema.parse(await options.console.replayTurn({ turnId: path.turnId }));
  });

  app.post("/api/v1/console/debug/agents/:agentId/wake", (request, reply) => {
    if (requireResearchSession(context, request, reply) === null) return;
    if (options.console?.debugWake === undefined) return sendHttpError(reply, "not-ready", "调试唤醒尚未就绪");
    const path = parsePath(agentParamsSchema, request.params);
    const body = debugWakeRequestSchema.safeParse(request.body);
    if (path === null || !body.success) return sendHttpError(reply, "validation", "调试唤醒请求结构不合法");
    return debugWakeResponseSchema.parse(options.console.debugWake({
      agentId: path.agentId,
      reason: body.data.reason,
      operationId: body.data.operationId,
      branchId: branch.branchId,
    }));
  });
}
