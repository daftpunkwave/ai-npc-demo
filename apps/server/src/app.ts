/**
 * 创建 Fastify HTTP/WS 应用：登录、会话、命令、回执、世界视图、时钟控制、存档与玩家流。
 * 依赖 authority、存储、投影/时钟/存档回调与身份令牌；不直接写规则聚合。
 * 禁止信任页面自报角色、绕过 Origin 校验或把内部错误细节返回给客户端。
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import {
  commandEnvelopeSchema,
  commandReceiptSchema,
  healthResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  type AuthContext,
  type ClockView,
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

/** 注入钩子的类型锚点；实现体不会被调用，只用于保留参数与返回类型。 */
function pauseHook(operationId: string, expectedRunVersion: number): ClockView {
  void operationId;
  void expectedRunVersion;
  throw new Error(`pause hook 未注入: ${operationId}:${expectedRunVersion}`);
}

function resumeHook(operationId: string, expectedRunVersion: number): ClockView {
  void operationId;
  void expectedRunVersion;
  throw new Error(`resume hook 未注入: ${operationId}:${expectedRunVersion}`);
}

interface SnapshotCreateArgs {
  readonly sourceBranchId: string;
  readonly label: string;
  readonly createdBy: string;
}

interface SnapshotRestoreArgs {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
}

function createSnapshotHook(input: SnapshotCreateArgs): SnapshotRecordView {
  void input;
  throw new Error(`save hook 未注入: ${input.sourceBranchId}`);
}

function restoreSnapshotHook(input: SnapshotRestoreArgs): { readonly branchId: string; readonly runId: string } {
  void input;
  throw new Error(`restore hook 未注入: ${input.snapshotId}`);
}

function resetHook(operationId: string): { readonly branchId: string; readonly clock: ClockView } {
  void operationId;
  throw new Error(`reset hook 未注入: ${operationId}`);
}

export interface ServerAppOptions {
  readonly authority: Authority;
  readonly storage: StoragePort;
  readonly worldId: string;
  readonly branchId: string;
  readonly assembly: ResolvedModuleSet;
  readonly projection: () => PlayerProjection;
  readonly clock: () => ClockView;
  readonly pause: typeof pauseHook;
  readonly resume: typeof resumeHook;
  readonly save: {
    createSnapshot: typeof createSnapshotHook;
    listSnapshots: () => readonly SnapshotRecordView[];
    restoreSnapshot: typeof restoreSnapshotHook;
  };
  readonly reset: typeof resetHook;
  readonly identities: readonly ServerIdentity[];
  readonly allowedOrigins?: readonly string[];
  readonly onBranchChanged?: typeof onBranchChangedHook;
  readonly healthStatus?: () => "starting" | "ready" | "degraded";
}

interface Session {
  readonly auth: AuthContext;
  readonly token: string;
  readonly expiresAt: string;
}

function onBranchChangedHook(nextBranchId: string): void {
  if (nextBranchId.length === 0) {
    throw new Error("分支 ID 不能为空");
  }
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
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  await app.register(cors, { origin: [...allowedOrigins] });
  await app.register(websocket);
  const sessions = new Map<string, Session>();
  const tickets = new Map<string, { readonly auth: AuthContext; readonly expiresAt: number }>();
  const identityByToken = new Map(options.identities.map((identity) => [identity.token, identity]));
  let branchId = options.branchId;

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      await reply.code(403).send({ code: "forbidden", safeMessage: "Origin 不被允许" });
    }
  });

  const authenticate = (request: FastifyRequest, reply: FastifyReply): Session | null => {
    const token = bearer(request);
    const session = token === null ? undefined : sessions.get(token);
    if (session === undefined) {
      reply.code(401).send({ code: "unauthorized", safeMessage: "缺少或无效会话" });
      return null;
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      sessions.delete(session.token);
      reply.code(401).send({ code: "unauthorized", safeMessage: "会话已过期" });
      return null;
    }
    return { ...session, auth: { ...session.auth, branchId } };
  };

  app.get("/api/v1/health", () => healthResponseSchema.parse({ status: options.healthStatus?.() ?? "ready", protocolVersion: "1" }));

  app.post("/api/v1/auth/login", (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const identity = identityByToken.get(body.token);
    if (identity === undefined) {
      return reply.code(401).send({ code: "unauthorized", safeMessage: "登录令牌无效" });
    }
    const sessionToken = `sess-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    sessions.set(sessionToken, { auth: identity.auth, token: sessionToken, expiresAt });
    return loginResponseSchema.parse({
      sessionToken,
      principalId: identity.auth.principalId,
      roles: identity.auth.roles as Array<"player" | "operator" | "researcher" | "evaluator">,
      expiresAt,
    });
  });

  app.post("/api/v1/auth/logout", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    sessions.delete(session.token);
    return { ok: true };
  });

  app.get("/api/v1/session", (request, reply) => {
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

  app.post("/api/v1/commands", (request, reply) => {
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

  app.get("/api/v1/commands/:commandId", (request, reply) => {
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

  app.get("/api/v1/world/view", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    return { streamSeq: 0, projectionVersion: 0, projection: options.projection() };
  });

  app.post("/api/v1/campaign/pause", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string; readonly expectedRunVersion: number };
    return options.pause(body.operationId, body.expectedRunVersion);
  });

  app.post("/api/v1/campaign/resume", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string; readonly expectedRunVersion: number };
    return options.resume(body.operationId, body.expectedRunVersion);
  });

  app.post("/api/v1/campaign/snapshots", (request, reply) => {
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

  app.get("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const snapshots = options.save.listSnapshots() as readonly SnapshotRecordView[];
    return {
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        label: snapshot.label,
        worldTick: snapshot.worldTick,
        createdAt: snapshot.createdAt,
      })),
    };
  });

  app.post("/api/v1/campaign/restore", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly snapshotId: string };
    const restored = options.save.restoreSnapshot({ snapshotId: body.snapshotId, createdBy: session.auth.principalId });
    branchId = restored.branchId;
    options.onBranchChanged?.(restored.branchId);
    return { branchId: restored.branchId, clock: options.clock() };
  });

  app.post("/api/v1/campaign/reset", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string };
    const reset = options.reset(body.operationId);
    branchId = reset.branchId;
    options.onBranchChanged?.(reset.branchId);
    return { branchId: reset.branchId, clock: reset.clock };
  });

  app.post("/api/v1/streams/ticket", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const ticket = `ticket-${randomUUID()}`;
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
      if (typeof message !== "object" || message === null || value.type !== "subscribe" || value.channel !== "player") {
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

  app.get("/api/v1/console/health", (request, reply) => {
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
    const status = typeof value.statusCode === "number" ? value.statusCode : 500;
    reply.code(status).send({
      code: status >= 500 ? "internal-error" : "invalid-request",
      safeMessage: status >= 500 ? "服务器内部错误" : (value.message ?? "请求不合法"),
    });
  });

  return app;
}
