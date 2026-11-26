/**
 * 提供浏览器 HTTP 客户端入口，装配控制台领域请求，共用会话、角色请求头、响应校验与错误映射。
 * 依赖公共 DTO 与浏览器 Fetch/Storage 接口；不访问数据库、服务端模块或模型凭据。
 * 禁止绕过认证头、信任未校验响应，或把内部错误细节直接展示给玩家。
 */
import {
  DomainError,
  assembliesResponseSchema,
  assemblyDetailResponseSchema,
  campaignResponseSchema,
  clientContentViewSchema,
  clockResponseSchema,
  commandReceiptSchema,
  consoleHealthResponseSchema,
  experimentDetailResponseSchema,
  experimentsListResponseSchema,
  runDetailResponseSchema,
  runReportResponseSchema,
  runsResponseSchema,
  conversationResponseSchema,
  errorResponseSchema,
  loginResponseSchema,
  modulesResponseSchema,
  resolvedModuleSetSchema,
  sessionDescriptorSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  snapshotRestoreResponseSchema,
  streamTicketResponseSchema,
  worldViewResponseSchema,
  type ClockControlRequest,
  type CommandEnvelope,
  type CommandReceipt,
  type ConsoleActiveRole,
  type Json,
  type SessionDescriptor,
  type SnapshotCreateRequest,
  type SnapshotRestoreRequest,
} from "@world-prism/contracts";
import { z } from "zod";
import { createDebugHttp } from "./http/debug";
import { createModelLayoutHttp } from "./http/model-layouts";
import { createOperationsHttp } from "./http/operations";
import { createResearchHttp } from "./http/research";
import { queryString, type ConsoleRequest, type RequestOptions } from "./http/request";

export type { RequestOptions } from "./http/request";

const sessionStorageKey = "world-prism.session-token";

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly storage?: BrowserStorage | null;
  readonly activeRole?: ConsoleActiveRole;
}

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface BrowserLocation {
  readonly href: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly protocol: string;
}

interface BrowserWindowLike {
  readonly location: BrowserLocation;
  readonly sessionStorage: BrowserStorage;
  readonly history: { replaceState(data: unknown, title: string, url?: string): void };
}

function browserWindow(): BrowserWindowLike | null {
  const candidate = (globalThis as unknown as { readonly window?: BrowserWindowLike }).window;
  return candidate ?? null;
}

function defaultStorage(): BrowserStorage | null {
  try {
    return browserWindow()?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 浏览器 API 客户端；每次响应都经对应 Zod schema 收窄。 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: BrowserStorage | null;
  private sessionToken: string | null;
  private activeRole: ConsoleActiveRole | undefined;
  private readonly requestConsole: ConsoleRequest = (schema, path, options) =>
    this.request(schema, path, { ...options, activeRole: this.requireActiveRole() });
  private readonly modelLayouts = createModelLayoutHttp(this.requestConsole);
  private readonly research = createResearchHttp(this.requestConsole);
  private readonly debug = createDebugHttp(this.requestConsole);
  private readonly operations = createOperationsHttp(this.requestConsole);

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.activeRole = options.activeRole;
    this.sessionToken = this.storage?.getItem(sessionStorageKey) ?? null;
  }

  get token(): string | null {
    return this.sessionToken;
  }

  setActiveRole(role: ConsoleActiveRole): void {
    this.activeRole = role;
  }

  clearSession(): void {
    this.sessionToken = null;
    this.storage?.removeItem(sessionStorageKey);
  }

  async login(token: string) {
    const response = await this.request(loginResponseSchema, "/api/v1/auth/login", {
      method: "POST",
      body: { token },
      authenticated: false,
    });
    this.sessionToken = response.sessionToken;
    this.storage?.setItem(sessionStorageKey, response.sessionToken);
    return response;
  }

  async logout(): Promise<void> {
    if (this.sessionToken !== null) {
      await this.request(
        z.object({ ok: z.literal(true) }).strict(),
        "/api/v1/auth/logout",
        { method: "POST", body: {} },
      );
    }
    this.clearSession();
  }

  session(): Promise<SessionDescriptor> {
    return this.request(sessionDescriptorSchema, "/api/v1/session");
  }

  /** 读取静态内容视图：章节名、时钟刻度与界面文字；与授权投影分开。 */
  content() {
    return this.request(clientContentViewSchema, "/api/v1/content");
  }

  assembly(realm: "client" | "console") {
    return this.request(
      resolvedModuleSetSchema,
      `/api/v1/session/assembly${queryString({ realm })}`,
      { activeRole: realm === "console" ? this.activeRole : undefined },
    );
  }

  campaign() {
    return this.request(campaignResponseSchema, "/api/v1/campaign");
  }

  worldView() {
    return this.request(worldViewResponseSchema, "/api/v1/world/view");
  }

  conversation(agentId: string, beforeSeq?: number, limit = 50) {
    return this.request(
      conversationResponseSchema,
      `/api/v1/conversations/${encodeURIComponent(agentId)}${queryString({ beforeSeq, limit })}`,
    );
  }

  sendCommand(envelope: CommandEnvelope): Promise<CommandReceipt> {
    return this.request(commandReceiptSchema, "/api/v1/commands", {
      method: "POST",
      body: envelope,
    });
  }

  receipt(commandId: string): Promise<CommandReceipt> {
    return this.request(
      commandReceiptSchema,
      `/api/v1/commands/${encodeURIComponent(commandId)}`,
    );
  }

  streamTicket() {
    return this.request(streamTicketResponseSchema, "/api/v1/streams/ticket", {
      method: "POST",
      body: {},
    });
  }

  pauseCampaign(request: ClockControlRequest) {
    return this.request(clockResponseSchema, "/api/v1/campaign/pause", {
      method: "POST",
      body: request,
    });
  }

  resumeCampaign(request: ClockControlRequest) {
    return this.request(clockResponseSchema, "/api/v1/campaign/resume", {
      method: "POST",
      body: request,
    });
  }

  createSnapshot(request: SnapshotCreateRequest) {
    return this.request(snapshotCreateResponseSchema, "/api/v1/campaign/snapshots", {
      method: "POST",
      body: request,
    });
  }

  snapshots() {
    return this.request(snapshotListResponseSchema, "/api/v1/campaign/snapshots");
  }

  restoreSnapshot(request: SnapshotRestoreRequest) {
    return this.request(snapshotRestoreResponseSchema, "/api/v1/campaign/restore", {
      method: "POST",
      body: request,
    });
  }

  consoleHealth(signal?: AbortSignal) {
    return this.requestConsole(consoleHealthResponseSchema, "/api/v1/console/health", { signal });
  }

  consoleModules(realm?: "server" | "client" | "console") {
    return this.requestConsole(
      modulesResponseSchema,
      `/api/v1/console/modules${queryString({ realm })}`,
    );
  }

  consoleAssemblies() {
    return this.requestConsole(assembliesResponseSchema, "/api/v1/console/assemblies");
  }

  consoleAssembly(assemblyId: string) {
    return this.requestConsole(
      assemblyDetailResponseSchema,
      `/api/v1/console/assemblies/${encodeURIComponent(assemblyId)}`,
    );
  }

  /** 评估读取：run 列表与详情、run 报告、实验列表与详情。角色由服务端按会话裁决。 */
  consoleRuns(query: { readonly status?: string; readonly limit?: number } = {}) {
    const search = new URLSearchParams();
    if (query.status !== undefined) search.set("status", query.status);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    return this.requestConsole(runsResponseSchema, `/api/v1/console/runs${suffix}`);
  }

  consoleRun(runId: string) {
    return this.requestConsole(runDetailResponseSchema, `/api/v1/console/runs/${encodeURIComponent(runId)}`);
  }

  consoleRunReport(runId: string) {
    return this.requestConsole(
      runReportResponseSchema,
      `/api/v1/console/runs/${encodeURIComponent(runId)}/report`,
    );
  }

  consoleExperiments() {
    return this.requestConsole(experimentsListResponseSchema, "/api/v1/console/experiments");
  }

  consoleExperiment(experimentId: string) {
    return this.requestConsole(
      experimentDetailResponseSchema,
      `/api/v1/console/experiments/${encodeURIComponent(experimentId)}`,
    );
  }

  consoleModelLayouts = this.modelLayouts.consoleModelLayouts;
  consoleModelLayout = this.modelLayouts.consoleModelLayout;
  consoleModelRoutes = this.modelLayouts.consoleModelRoutes;
  validateModelLayout = this.modelLayouts.validateModelLayout;

  consoleTimeline = this.research.consoleTimeline;
  consoleAgents = this.research.consoleAgents;
  consoleInspector = this.research.consoleInspector;
  consoleMemory = this.research.consoleMemory;
  consoleMemoryDiff = this.research.consoleMemoryDiff;
  consoleObservations = this.research.consoleObservations;
  consoleTurns = this.research.consoleTurns;
  consoleTurn = this.research.consoleTurn;
  consoleArtifact = this.research.consoleArtifact;
  consoleTrace = this.research.consoleTrace;
  consoleBranchCompare = this.research.consoleBranchCompare;

  consoleDebugQueues = this.debug.consoleDebugQueues;
  consoleReplayTurn = this.debug.consoleReplayTurn;
  consoleWakeAgent = this.debug.consoleWakeAgent;

  consolePauseCampaign = this.operations.consolePauseCampaign;
  consoleResumeCampaign = this.operations.consoleResumeCampaign;
  consoleStepCampaign = this.operations.consoleStepCampaign;
  consoleSnapshots = this.operations.consoleSnapshots;
  consoleCreateSnapshot = this.operations.consoleCreateSnapshot;
  consoleRestoreSnapshot = this.operations.consoleRestoreSnapshot;
  consolePreviewSnapshotRestore = this.operations.consolePreviewSnapshotRestore;

  webSocketUrl(ticket: string): string {
    const current = browserWindow();
    if (current === null) {
      throw new DomainError("not-ready", "WebSocket 只能在浏览器宿主中建立");
    }
    if (this.baseUrl.length > 0) {
      const url = new URL(this.baseUrl, current.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/api/v1/streams";
      url.search = queryString({ ticket });
      return url.toString();
    }
    const url = new URL("/api/v1/streams", current.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = queryString({ ticket });
    return url.toString();
  }

  private requireActiveRole(): ConsoleActiveRole {
    if (this.activeRole === undefined) {
      throw new DomainError("forbidden", "控制台请求缺少当前角色");
    }
    return this.activeRole;
  }

  private async request<T>(
    schema: z.ZodType<T>,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.authenticated !== false && this.sessionToken !== null) {
      headers.set("Authorization", `Bearer ${this.sessionToken}`);
    }
    if (options.activeRole !== undefined) {
      headers.set("X-Active-Role", options.activeRole);
    }
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const payload: unknown = await response.json().catch(() => null);
    options.signal?.throwIfAborted();
    if (!response.ok) {
      if (response.status === 401) {
        this.clearSession();
      }
      const parsedError = errorResponseSchema.safeParse(payload);
      if (parsedError.success) {
        throw new DomainError(parsedError.data.error.code, parsedError.data.error.safeMessage, {
          retryable: parsedError.data.error.retryable,
          traceId: parsedError.data.error.traceId,
          detailsArtifactRef: parsedError.data.error.detailsArtifactRef,
        });
      }
      throw new DomainError(
        response.status >= 500 ? "plugin-failed" : "validation",
        response.statusText || "请求失败",
        { retryable: response.status >= 500 },
      );
    }
    return schema.parse(payload);
  }
}

/** 读取并清除 URL hash 中的一次性登录令牌；没有令牌时返回 null。 */
export function takeHashToken(): string | null {
  const current = browserWindow();
  if (current === null) {
    return null;
  }
  const params = new URLSearchParams(current.location.hash.replace(/^#/, ""));
  const token = params.get("token") ?? "";
  if (token.length === 0) {
    return null;
  }
  current.history.replaceState(null, "", `${current.location.pathname}${current.location.search}`);
  return token;
}

/** 把 JSON 安全写入请求体；保留调用方类型，不在此进行业务校验。 */
export function jsonBody(value: Json): Json {
  return value;
}
