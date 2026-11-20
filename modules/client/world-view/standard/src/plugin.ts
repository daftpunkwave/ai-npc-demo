/**
 * 维护唯一一份玩家授权投影，负责会话初始化、REST 重取、WS 续传、开局与时钟控制。
 * 依赖注入的 API、命令、会话端口和 client-protocol reducer；不读取私密 Agent 状态。
 * 禁止在游标缺口后继续拼接增量，或在命令被拒时伪造世界变化。
 */
import {
  DomainError,
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

export interface WorldViewPort {
  subscribe(listener: (state: ProjectionState | null) => void): () => void;
  getSnapshot(): ProjectionState | null;
  getCampaign(): CampaignResponse | null;
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
  private readonly session: SessionDescriptor;
  private readonly newOperationId: () => string;
  private readonly store = new ProjectionStore();
  private readonly listeners = new Set<(state: ProjectionState | null) => void>();
  private readonly unsubscribeStore: () => void;
  private campaign: CampaignResponse | null = null;
  private stream: StreamClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastError: string | null = null;
  private lastRefreshError: string | null = null;

  constructor(input: {
    readonly api: ApiClient;
    readonly command: CommandClient;
    readonly session: SessionDescriptor;
    readonly newOperationId: () => string;
  }) {
    this.api = input.api;
    this.command = input.command;
    this.session = input.session;
    this.newOperationId = input.newOperationId;
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

  getCampaign(): CampaignResponse | null {
    return this.campaign;
  }

  get error(): string | null {
    return this.lastError;
  }

  refreshError(): string | null {
    return this.lastRefreshError;
  }

  async bootstrap(): Promise<void> {
    await this.refreshCampaign();
    if (this.campaign?.campaign != null) {
      await this.refresh();
      await this.connectStream();
    }
  }

  async refresh(): Promise<void> {
    const response = await this.api.worldView();
    this.store.replaceSnapshot({
      worldId: this.session.worldId,
      branchId: this.session.branchId,
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
    this.unsubscribeStore();
    this.listeners.clear();
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
    this.closeStream();
    const ticket = await this.api.streamTicket();
    const state = this.store.getSnapshot();
    this.stream = new StreamClient({
      url: this.api.webSocketUrl(ticket.ticket),
      channel: "player",
      fromStreamSeq: state?.streamSeq ?? null,
      onMessage: (message) => {
        if (message.type === "snapshot" && message.channel === "player") {
          this.store.applySnapshot(message, this.session.worldId, this.session.branchId);
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
      onClose: () => {
        if (!this.disposed) {
          this.scheduleReconnect();
        }
      },
      onError: (error) => {
        this.lastError = errorMessage(error);
      },
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectStream().catch((error: unknown) => {
        this.lastError = errorMessage(error);
        if (!this.disposed) {
          this.scheduleReconnect();
        }
      });
    }, 1_500);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeStream(): void {
    this.stream?.close();
    this.stream = null;
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
  });
  return {
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => controller.dispose(),
    port: controller,
  };
}
