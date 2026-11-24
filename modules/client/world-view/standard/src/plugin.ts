/**
 * 维护唯一一份玩家授权投影与静态内容视图，负责内容读取、会话初始化、REST 重取、WS 续传、开局与时钟控制。
 * 依赖注入的 API、命令、会话端口和 client-protocol reducer；不读取私密 Agent 状态。
 * 禁止在游标缺口后继续拼接增量，或在命令被拒时伪造世界变化。
 */
import {
  DomainError,
  type ClientContentView,
  type Json,
  type CampaignResponse,
  type PlayerProjection,
  type SessionDescriptor,
  type SnapshotCreateRequest,
  type ModuleCreateInput,
  type ModuleInstance,
} from "@ai-npc/contracts";
import {
  CommandClient,
  ProjectionStore,
  StreamClient,
  type ApiClient,
  type ProjectionState,
} from "@ai-npc/client-protocol";
import {
  isSessionInvalidCloseCode,
  isSessionInvalidError,
  reconnectDelayMs,
} from "./connection-policy";

/** 玩家流连接状态：供界面显示重连与重新登录提示。 */
export interface WorldViewConnectionState {
  readonly kind: "connecting" | "connected" | "reconnecting" | "session-expired";
  /** 连续失败次数；成功连接后归零。 */
  readonly attempt: number;
  /** 下一次重连等待毫秒数；非重连状态为 null。 */
  readonly retryInMs: number | null;
  /** 最近一次连接错误；成功连接后为 null。 */
  readonly error: string | null;
}

export interface WorldViewPort {
  subscribe(listener: (state: ProjectionState | null) => void): () => void;
  getSnapshot(): ProjectionState | null;
  subscribeConnection(listener: (state: WorldViewConnectionState) => void): () => void;
  getConnectionState(): WorldViewConnectionState;
  getCampaign(): CampaignResponse | null;
  /** 静态内容视图；bootstrap 成功后必有值，失败时 bootstrap 直接拒绝。 */
  getContent(): ClientContentView | null;
  bootstrap(): Promise<void>;
  refresh(): Promise<void>;
  startCampaign(factionId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  save(label: string): Promise<void>;
  refreshError(): string | null;
  sendDialogue(agentId: string, text: string): Promise<boolean>;
  sendCommand(type: string, payload: Json): Promise<boolean>;
}

interface CommandSubmissionResult {
  readonly accepted: boolean;
  /** 命令已被网关受理，但投影重取失败；调用方应单独重试 refresh。 */
  readonly refreshError: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof DomainError ? error.safeMessage : error instanceof Error ? error.message : String(error);
}

class WorldViewController implements WorldViewPort {
  private readonly api: ApiClient;
  private readonly command: CommandClient;
  /** 登录时与会话返回的静态身份；分支与世界的权威值另由 currentScope 跟踪。 */
  private readonly session: SessionDescriptor;
  /**
   * 当前世界与分支身份：以服务端返回的权威值为准。
   * 恢复或重开后在线分支会变，快照帧与 `/session` 都会带回新身份，这里随之更新。
   */
  private currentScope: { readonly worldId: string; readonly branchId: string };
  private readonly newOperationId: () => string;
  private readonly random: () => number;
  private readonly store = new ProjectionStore();
  private readonly listeners = new Set<(state: ProjectionState | null) => void>();
  private readonly connectionListeners = new Set<(state: WorldViewConnectionState) => void>();
  private readonly unsubscribeStore: () => void;
  private campaign: CampaignResponse | null = null;
  private content: ClientContentView | null = null;
  private stream: StreamClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续重连次数；收到服务端首帧后才归零，避免 open 后立即断开导致固定 1s 重试。 */
  private reconnectAttempt = 0;
  private disposed = false;
  private lastError: string | null = null;
  private lastRefreshError: string | null = null;
  private connection: WorldViewConnectionState = {
    kind: "connecting",
    attempt: 0,
    retryInMs: null,
    error: null,
  };

  constructor(input: {
    readonly api: ApiClient;
    readonly command: CommandClient;
    readonly session: SessionDescriptor;
    readonly newOperationId: () => string;
    readonly random: () => number;
  }) {
    this.api = input.api;
    this.command = input.command;
    this.session = input.session;
    this.currentScope = { worldId: input.session.worldId, branchId: input.session.branchId };
    this.newOperationId = input.newOperationId;
    this.random = input.random;
    this.unsubscribeStore = this.store.subscribe((state) => {
      for (const listener of [...this.listeners]) {
        listener(state);
      }
    });
  }

  subscribe = (listener: (state: ProjectionState | null) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ProjectionState | null => this.store.getSnapshot();

  subscribeConnection = (
    listener: (state: WorldViewConnectionState) => void,
  ): (() => void) => {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  };

  getConnectionState = (): WorldViewConnectionState => this.connection;

  getCampaign(): CampaignResponse | null {
    return this.campaign;
  }

  getContent(): ClientContentView | null {
    return this.content;
  }

  get error(): string | null {
    return this.lastError;
  }

  refreshError(): string | null {
    return this.lastRefreshError;
  }

  async bootstrap(): Promise<void> {
    // 内容静态且必须先就绪：读取失败直接让 bootstrap 失败，由宿主显示错误页，不退回模块源码文案。
    this.content = await this.api.content();
    await this.refreshCampaign();
    if (this.campaign?.campaign != null) {
      await this.refresh();
      await this.connectStream();
    }
  }

  /**
   * 快照被接受后同步本地身份。
   * 调用点必须在 `applySnapshot` 返回 `changed: true` 之后：被拒绝的快照（不同世界、
   * 同分支旧帧）不能改写本地 scope，否则界面会跳到一条并未生效的分支上。
   * 分支或世界变化时清掉旧 campaign 并异步重新获取，让依赖它的界面读到新分支数据。
   */
  private applySnapshotIdentity(worldId: string, branchId: string): void {
    if (this.currentScope.worldId === worldId && this.currentScope.branchId === branchId) {
      return;
    }
    this.currentScope = { worldId, branchId };
    this.campaign = null;
    // 重新获取失败只记录，不阻断投影更新：界面会显示“未开局”而不是旧分支的战役。
    void this.refreshCampaign().catch((error: unknown) => {
      this.lastRefreshError = errorMessage(error);
    });
  }

  /**
   * 从服务端重新读取投影。
   * 请求发出时捕获当前身份，返回时若身份已变（期间收到新分支快照）就丢弃这次响应：
   * 否则旧分支的数据会被标成新分支，新分支序号重置后还可能覆盖更新的投影。
   */
  async refresh(): Promise<void> {
    const requestedScope = this.currentScope;
    const response = await this.api.worldView();
    if (
      requestedScope.worldId !== this.currentScope.worldId ||
      requestedScope.branchId !== this.currentScope.branchId
    ) {
      return;
    }
    this.store.replaceSnapshot({
      worldId: this.currentScope.worldId,
      branchId: this.currentScope.branchId,
      streamSeq: response.streamSeq,
      projectionVersion: response.projectionVersion,
      projection: response.projection,
    });
    this.lastError = null;
    this.lastRefreshError = null;
  }

  async startCampaign(factionId: string): Promise<void> {
    const receipt = await this.command.send("campaign.start", { factionId });
    if (receipt.commandStatus !== "accepted") {
      throw new DomainError("invalid-state", receipt.safeMessage ?? "未能开始序章");
    }
    await this.refreshCampaign();
    await this.refresh();
    await this.connectStream();
    const snapshot = this.store.getSnapshot();
    if (snapshot !== null && snapshot.projection.clock.mode !== "running") {
      await this.api.resumeCampaign({
        operationId: this.newOperationId(),
        expectedRunVersion: snapshot.projection.clock.runVersion,
      });
      await this.refresh();
    }
  }

  async pause(): Promise<void> {
    const snapshot = this.requireSnapshot();
    await this.api.pauseCampaign({
      operationId: this.newOperationId(),
      expectedRunVersion: snapshot.projection.clock.runVersion,
    });
    await this.refresh();
  }

  async resume(): Promise<void> {
    const snapshot = this.requireSnapshot();
    await this.api.resumeCampaign({
      operationId: this.newOperationId(),
      expectedRunVersion: snapshot.projection.clock.runVersion,
    });
    await this.refresh();
  }

  async save(label: string): Promise<void> {
    const request: SnapshotCreateRequest = {
      operationId: this.newOperationId(),
      label,
    };
    await this.api.createSnapshot(request);
    await this.refresh();
  }

  async sendDialogue(agentId: string, text: string): Promise<boolean> {
    return this.trackSubmission(
      await this.submitCommand("dialogue.say", {
        targetAgentId: agentId,
        text,
      }),
    );
  }

  async sendCommand(type: string, payload: Json): Promise<boolean> {
    return this.trackSubmission(await this.submitCommand(type, payload));
  }

  projection(): PlayerProjection | null {
    return this.store.getSnapshot()?.projection ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.reconnectAttempt = 0;
    this.unsubscribeStore();
    this.listeners.clear();
    this.connectionListeners.clear();
    this.closeStream();
    this.clearReconnect();
  }

  private async refreshCampaign(): Promise<void> {
    this.campaign = await this.api.campaign();
  }

  private async submitCommand(type: string, payload: Json): Promise<CommandSubmissionResult> {
    const receipt = await this.command.send(type, payload);
    let refreshError: string | null = null;
    try {
      await this.refresh();
    } catch (error) {
      refreshError = errorMessage(error);
      this.lastError = refreshError;
    }
    return {
      accepted: receipt.commandStatus === "accepted",
      refreshError,
    };
  }

  private trackSubmission(result: CommandSubmissionResult): boolean {
    this.lastRefreshError = result.refreshError;
    return result.accepted;
  }

  private async connectStream(): Promise<void> {
    this.clearReconnect();
    this.closeStream();
    if (this.disposed || this.connection.kind === "session-expired") {
      return;
    }
    let ticket: { readonly ticket: string };
    try {
      ticket = await this.api.streamTicket();
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.lastError = errorMessage(error);
      if (isSessionInvalidError(error)) {
        this.expireSession();
        return;
      }
      this.scheduleReconnect(this.lastError);
      return;
    }
    if (this.disposed) {
      return;
    }
    const state = this.store.getSnapshot();
    let stream!: StreamClient;
    try {
      stream = new StreamClient({
        url: this.api.webSocketUrl(ticket.ticket),
        channel: "player",
        fromStreamSeq: state?.streamSeq ?? null,
        onOpen: () => {
          if (this.stream !== stream) {
            return;
          }
          this.lastError = null;
          // 建连成功先保留退避计数；收到服务端首帧才视为恢复稳定。
          this.setConnection({
            kind: "connected",
            attempt: this.reconnectAttempt,
            retryInMs: null,
            error: null,
          });
        },
        onMessage: (message) => {
          this.confirmStreamUsable();
          if (message.type === "snapshot" && message.channel === "player") {
            const result = this.store.applySnapshot(message);
            // 只有被接受的快照才能改写本地身份：被拒绝的帧（不同世界、同分支旧帧）
            // 一旦同步身份，界面就会跳到一条并未生效的分支上。
            if (result.changed) {
              this.applySnapshotIdentity(message.worldId, message.branchId);
            }
          } else if (message.type === "delta") {
            const result = this.store.applyDelta(message);
            if (result.needsSnapshot) {
              void this.refresh().catch((error: unknown) => {
                this.lastError = errorMessage(error);
              });
            }
          } else if (message.type === "append") {
            this.store.applyAppend(message);
          }
        },
        onClose: (event) => {
          // 主动关闭或已被新连接替换时，不得按断线处理。
          if (this.stream !== stream) {
            return;
          }
          this.stream = null;
          if (this.disposed) {
            return;
          }
          if (isSessionInvalidCloseCode(event.code)) {
            this.expireSession();
            return;
          }
          this.scheduleReconnect(`流连接已关闭（${event.code}）`);
        },
        onError: (error) => {
          this.lastError = errorMessage(error);
        },
      });
    } catch (error) {
      // WebSocket URL 或构造失败也必须按退避重试，不能留下未处理的 rejection。
      if (this.disposed) {
        return;
      }
      this.lastError = errorMessage(error);
      if (isSessionInvalidError(error)) {
        this.expireSession();
        return;
      }
      this.scheduleReconnect(this.lastError);
      return;
    }
    this.stream = stream;
  }

  private scheduleReconnect(reason: string): void {
    this.clearReconnect();
    if (this.disposed || this.connection.kind === "session-expired") {
      return;
    }
    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    const retryInMs = reconnectDelayMs(attempt, this.random);
    this.lastError = reason;
    this.setConnection({ kind: "reconnecting", attempt, retryInMs, error: reason });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectStream().catch((error: unknown) => {
        if (this.disposed || this.connection.kind === "session-expired") {
          return;
        }
        this.lastError = errorMessage(error);
        this.scheduleReconnect(this.lastError);
      });
    }, retryInMs);
  }

  /** 收到服务端首帧后确认连接可用，才把连续失败计数归零。 */
  private confirmStreamUsable(): void {
    if (this.reconnectAttempt === 0 && this.connection.kind === "connected") {
      return;
    }
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.setConnection({ kind: "connected", attempt: 0, retryInMs: null, error: null });
  }

  /** 会话失效后停止一切重连并清除本地令牌，界面据此提示重新登录。 */
  private expireSession(): void {
    this.clearReconnect();
    this.closeStream();
    this.reconnectAttempt = 0;
    this.api.clearSession();
    this.setConnection({ kind: "session-expired", attempt: 0, retryInMs: null, error: null });
  }

  private setConnection(next: WorldViewConnectionState): void {
    this.connection = next;
    for (const listener of [...this.connectionListeners]) {
      listener(next);
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeStream(): void {
    // 先摘除引用再关闭，旧连接的异步 close 事件不会触发重连。
    const stream = this.stream;
    this.stream = null;
    stream?.close();
  }

  private requireSnapshot(): ProjectionState {
    const snapshot = this.store.getSnapshot();
    if (snapshot === null) {
      throw new DomainError("not-ready", "世界投影尚未就绪");
    }
    return snapshot;
  }
}

export async function createWorldViewModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const api = input.ports["host.api"];
  const command = input.ports["host.command"];
  const session = input.ports["host.session"];
  if (
    !(api instanceof Object) ||
    !(command instanceof Object) ||
    typeof session !== "object" ||
    session === null
  ) {
    throw new DomainError("assembly-incompatible", "玩家投影缺少宿主 API、命令或会话端口");
  }
  const controller = new WorldViewController({
    api: api as ApiClient,
    command: command as CommandClient,
    session: session as SessionDescriptor,
    newOperationId: () => input.host.ids("op"),
    random: input.host.rng("client.world-view.reconnect"),
  });
  return {
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => controller.dispose(),
    port: controller,
  };
}
