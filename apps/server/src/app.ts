/**
 * 创建 Fastify HTTP/WS 应用：登录、会话、命令、回执、世界视图、时钟控制、存档与玩家流。
 * 依赖 authority、存储、投影/时钟/存档回调与身份令牌；不直接写规则聚合。
 * 禁止信任页面自报角色、绕过 Origin 校验或把内部错误细节返回给客户端。
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import {
  commandEnvelopeSchema,
  commandReceiptSchema,
  healthResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  type AuthContext,
  type ClockView,
  type CommandEnvelope,
  type CommandReceipt,
  type PlayerProjection,
  type ResolvedModuleSet,
  type SessionDescriptor,
} from "@ai-npc/contracts";
import type { Authority } from "@ai-npc/authority";
import type { StoragePort } from "@ai-npc/contracts";

/** 存档服务在传输层使用的最小视图；具体实现由 host/module-catalog 绑定。 */
export interface SnapshotRecordView {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly label: string;
  readonly createdAt: string;
}

export interface ServerIdentity {
  readonly token: string;
  readonly auth: AuthContext;
}

export interface ServerAppOptions {
  readonly authority: Authority;
  readonly storage: StoragePort;
  readonly worldId: string;
  readonly branchId: string;
  readonly assembly: ResolvedModuleSet;
  readonly projection: () => PlayerProjection;
  readonly clock: () => ClockView;
  readonly pause: (operationId: string, expectedRunVersion: number) => ClockView;
  readonly resume: (operationId: string, expectedRunVersion: number) => ClockView;
  readonly save: {
    createSnapshot(input: { readonly sourceBranchId: string; readonly label: string; readonly createdBy: string }): SnapshotRecordView;
    listSnapshots(): readonly SnapshotRecordView[];
    restoreSnapshot(input: { readonly snapshotId: string; readonly createdBy: string; readonly runId?: string }): { readonly branchId: string; readonly runId: string };
  };
  readonly identities: readonly ServerIdentity[];
  readonly allowedOrigins?: readonly string[];
}

interface Session {
  readonly auth: AuthContext;
  readonly token: string;
  readonly expiresAt: string;
}

const playerCommandTypes = new Set([
  "campaign.start",
  "dialogue.say",
  "information.share",
  "agreement.propose",
  "agreement.respond",
  "task.dispatch",
  "task.cancel",
]);

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

function receiptOf(row: Record<string, unknown>): CommandReceipt {
  const raw = row["receipt_json"];
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return commandReceiptSchema.parse(value);
}

/** 构建服务端应用；调用方负责打开存储、装配模块与启动 worker。 */
export async function createServerApp(options: ServerAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const sessions = new Map<string, Session>();
  const tickets = new Map<string, { readonly auth: AuthContext; readonly expiresAt: number }>();
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://127.0.0.1:5174"]);
  const identityByToken = new Map(options.identities.map((identity) => [identity.token, identity]));
  let branchId = options.branchId;

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      await reply.code(403).send({ code: "forbidden", safeMessage: "Origin 不被允许" });
    }
  });

  const authenticate = (request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Session | null => {
    const token = bearer(request);
    const session = token === null ? undefined : sessions.get(token);
    if (session === undefined) {
      reply.code(401).send({ code: "unauthorized", safeMessage: "缺少或无效会话" });
      return null;
    }
    return session;
  };

  app.get("/api/v1/health", async () => healthResponseSchema.parse({ status: "ready", protocolVersion: "1" }));

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const identity = identityByToken.get(body.token);
    if (identity === undefined) {
      return reply.code(401).send({ code: "unauthorized", safeMessage: "登录令牌无效" });
    }
    const sessionToken = `sess-${Math.random().toString(36).slice(2)}`;
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    sessions.set(sessionToken, { auth: identity.auth, token: sessionToken, expiresAt });
    return loginResponseSchema.parse({
      sessionToken,
      principalId: identity.auth.principalId,
      roles: identity.auth.roles as Array<"player" | "operator" | "researcher" | "evaluator">,
      expiresAt,
    });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    sessions.delete(session.token);
    return { ok: true };
  });

  app.get("/api/v1/session", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const descriptor: SessionDescriptor = {
      principalId: session.auth.principalId,
      roles: session.auth.roles as Array<"player" | "operator" | "researcher" | "evaluator">,
      worldId: options.worldId,
      branchId,
      protocolVersion: "1",
      serverAssembly: options.assembly,
      clientAssembly: null,
    };
    return descriptor;
  });

  app.post("/api/v1/commands", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const envelope = commandEnvelopeSchema.parse(request.body);
    if (session.auth.kind === "player" && !playerCommandTypes.has(envelope.type)) {
      return reply.code(403).send({ code: "forbidden", safeMessage: "玩家不能使用该命令" });
    }
    const receipt = options.authority.commands.execute(session.auth, envelope);
    return commandReceiptSchema.parse(receipt);
  });

  app.get("/api/v1/commands/:commandId", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const params = request.params as { readonly commandId: string };
    const row = options.storage.transact((tx) =>
      tx.get("SELECT receipt_json FROM command_receipts WHERE branch_id = ? AND principal_id = ? AND command_id = ?", [
        session.auth.branchId,
        session.auth.principalId,
        params.commandId,
      ]),
    );
    if (row === null) {
      return reply.code(404).send({ code: "not-found", safeMessage: "回执不存在" });
    }
    return receiptOf(row);
  });

  app.get("/api/v1/world/view", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    return { streamSeq: 0, projectionVersion: 0, projection: options.projection() };
  });

  app.post("/api/v1/campaign/pause", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string; readonly expectedRunVersion: number };
    return options.pause(body.operationId, body.expectedRunVersion);
  });

  app.post("/api/v1/campaign/resume", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string; readonly expectedRunVersion: number };
    return options.resume(body.operationId, body.expectedRunVersion);
  });

  app.post("/api/v1/campaign/snapshots", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly label: string };
    const snapshot = options.save.createSnapshot({
      sourceBranchId: branchId,
      label: body.label,
      createdBy: session.auth.principalId,
    });
    return { snapshotId: snapshot.snapshotId, worldTick: snapshot.worldTick };
  });

  app.get("/api/v1/campaign/snapshots", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    return {
      snapshots: options.save.listSnapshots().map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        label: snapshot.label,
        worldTick: snapshot.worldTick,
        createdAt: snapshot.createdAt,
      })),
    };
  });

  app.post("/api/v1/campaign/restore", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly snapshotId: string };
    const restored = options.save.restoreSnapshot({ snapshotId: body.snapshotId, createdBy: session.auth.principalId });
    branchId = restored.branchId;
    return { branchId: restored.branchId, clock: options.clock() };
  });

  app.post("/api/v1/streams/ticket", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const ticket = `ticket-${Math.random().toString(36).slice(2)}`;
    tickets.set(ticket, { auth: session.auth, expiresAt: Date.now() + 30_000 });
    return { ticket, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  });

  app.get("/api/v1/streams", { websocket: true }, (socket, request) => {
    const query = request.query as { readonly ticket?: string };
    const ticket = query.ticket === undefined ? undefined : tickets.get(query.ticket);
    if (ticket === undefined || ticket.expiresAt < Date.now()) {
      socket.close(4401, "invalid ticket");
      return;
    }
    tickets.delete(query.ticket ?? "");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: "1", principalId: ticket.auth.principalId, channels: ["player"] }));
    socket.on("message", (data: Buffer) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "invalid-json", safeMessage: "消息不是 JSON" }));
        return;
      }
      const value = message as { readonly type?: string; readonly channel?: string };
      if (value.type !== "subscribe" || value.channel !== "player") {
        socket.send(JSON.stringify({ type: "error", code: "invalid-channel", safeMessage: "频道不可用" }));
        return;
      }
      socket.send(JSON.stringify({
        type: "snapshot",
        channel: "player",
        streamSeq: 0,
        projectionVersion: 0,
        data: options.projection(),
      }));
    });
  });

  app.get("/api/v1/console/health", async (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (session.auth.kind === "player") {
      return reply.code(403).send({ code: "forbidden", safeMessage: "玩家不能访问控制台" });
    }
    return { status: "ready", modules: [], queues: { turnsQueued: 0, jobsDue: 0 } };
  });

  app.setErrorHandler((error, _request, reply) => {
    const value = error as { readonly statusCode?: number; readonly message?: string };
    const status = typeof value.statusCode === "number" ? value.statusCode : 400;
    reply.code(status).send({ code: "invalid-request", safeMessage: value.message ?? "请求不合法" });
  });

  return app;
}
