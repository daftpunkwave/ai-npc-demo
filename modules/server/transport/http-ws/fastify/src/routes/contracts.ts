/**
 * 传输层的对外契约：应用选项、应用接口、注入类型与宿主/权限/读端口视图。
 * 依赖公共契约的命令、时钟、投影与会话类型，以及流中心会话与统计类型；不依赖 Fastify。
 * 禁止在这里实现路由、访问裁决或会话存储，也不把宿主回调写成需要调用方推断的匿名类型。
 */
/* eslint-disable no-unused-vars -- 本文件是传输层类型契约，未使用参数只出现在接口方法签名中，名称用于表达调用契约。 */
import type {
  AuthContext,
  ClockView,
  CommandEnvelope,
  CommandReceipt,
  Json,
  PlayerProjection,
  ResolvedModuleSet,
  StartOption,
} from "@ai-npc/contracts";
import type { StreamSession, StreamStats } from "../stream-hub";

/** 命令网关视图：传输层只提交已解析的命令信封，不依赖 authority 实现包。 */
export interface AuthorityPort {
  readonly commands: {
    execute(auth: AuthContext, envelope: CommandEnvelope): CommandReceipt;
  };
}

/** 需要裁决的动作：玩家入口、命令、控制台接口、控制台会话握手与 WS 频道。 */
export type AccessAction = "player" | "command" | "console" | "console-session" | "channel";

/**
 * 权限裁决请求：主体与角色始终来自服务端会话，调用方只补充动作与目标。
 * 结构与 platform.access-policy 端口一致，传输层不依赖具体实现包。
 */
export interface AccessRequest {
  readonly principalId: string;
  readonly role: string;
  readonly action: AccessAction;
  readonly commandType?: string;
  readonly channel?: string;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** 权限端口最小视图；角色白名单由装配的 provider 维护，传输层不内置。 */
export interface AccessPolicy {
  authorize(request: AccessRequest): AccessDecision;
}

/** 存档服务在传输层使用的最小视图；具体实现由宿主组合根绑定。 */
export interface SnapshotRecordView {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly label: string;
  readonly createdAt: string;
}

/**
 * 命令回执只读查询端口；宿主绑定存储细节，传输层只按会话主体、分支与命令 ID 查询。
 * 未找到返回 null，由路由按资源不存在处理；端口不暴露写入或表结构。
 */
export interface CommandReceiptReadPort {
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  read(principalId: string, branchId: string, commandId: string): CommandReceipt | null;
}

export interface ServerIdentity {
  readonly token: string;
  readonly auth: AuthContext;
}

/** 快照创建参数：源分支由传输层取当前在线分支，其余来自请求体与认证会话。 */
export interface SnapshotCreateArgs {
  readonly sourceBranchId: string;
  readonly label: string;
  readonly createdBy: string;
  /** 请求体提供的运营幂等键；与认证主体共同识别重试。 */
  readonly operationId: string;
  readonly principalId: string;
}

export interface SnapshotRestoreArgs {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
  readonly operationId: string;
  readonly principalId: string;
}

/** 恢复结果：宿主命中幂等记录时返回首次时钟，未提供时由传输层读取当前时钟。 */
export interface RestoreSnapshotResult {
  readonly branchId: string;
  readonly clock?: ClockView;
}

/** 快照创建结果。 */
export interface SnapshotCreateResult {
  readonly snapshotId: string;
  readonly worldTick: number;
}

/** 分支切换结果：新在线分支与其初始时钟。 */
export interface BranchClockResult {
  readonly branchId: string;
  readonly clock: ClockView;
}

/** 时钟控制回调：幂等键、期望版本与会话主体一起交给宿主执行。 */
export type ClockControlHook = (operationId: string, expectedRunVersion: number, principalId: string) => ClockView;
export type SnapshotCreateHook = (input: SnapshotCreateArgs) => SnapshotCreateResult;
export type SnapshotRestoreHook = (input: SnapshotRestoreArgs) => RestoreSnapshotResult;
export type ResetHook = (operationId: string, principalId: string) => BranchClockResult;
/** ID 与令牌生成由宿主注入，传输层不自行创建随机源。 */
export type IdGenerator = (prefix: string) => string;
export type TokenIssuer = (kind: "session" | "ticket") => string;
/** 在线分支切换通知；宿主据此更新自身的内存入口。 */
export type BranchChangedHook = (nextBranchId: string) => void;

/** 玩家会话读取请求：认证主体、对方主体与分页游标都由调用方给出。 */
export interface ConversationReadQuery {
  readonly principalId: string;
  readonly agentId: string;
  readonly beforeSeq: number | null;
  readonly limit: number;
}

/** 一条会话对白的只读来源；附带逐主体送达 tick，供传输层按调用主体过滤未送达内容。 */
export interface ConversationSourceLine {
  readonly seq: number;
  readonly dialogueId: string;
  readonly speakerId: string;
  readonly text: string;
  readonly channel: "face-to-face" | "relay";
  readonly worldTick: number;
  readonly deliveries: readonly {
    readonly principalId: string;
    readonly deliverAtTick: number;
  }[];
}

/**
 * 会话读取端口：宿主为每个方法绑定只读事务与已授权的通信端口。
 * 选择会话、分页与送达过滤都在传输层完成，端口本身不裁决可见性。
 */
export interface ConversationReadPort {
  worldTick(): number;
  conversationsOf(principalId: string): readonly string[];
  conversationMessages(conversationId: string, limit: number): readonly ConversationSourceLine[];
  speakerName(principalId: string): string;
}

export interface ServerAppOptions {
  readonly authority: AuthorityPort;
  /** 装配的权限端口；玩家、控制台与 WS 频道的裁决都经此端口。 */
  readonly accessPolicy: AccessPolicy;
  /** 命令回执只读查询端口；传输层不直接访问存储。 */
  readonly receipts: CommandReceiptReadPort;
  readonly worldId: string;
  readonly branchId: string;
  /** 服务端 realm 的已解析装配；只含模块身份与能力，不含模块配置。 */
  readonly assembly: ResolvedModuleSet;
  /** 浏览器 realm 的已解析装配；未接线时按装配资源不存在处理。 */
  readonly sessionAssembly?: {
    readonly client: ResolvedModuleSet;
    readonly console: ResolvedModuleSet;
  };
  /** 玩家可选开局；未接线时不返回开局选项。 */
  readonly starts?: () => readonly StartOption[];
  /** 玩家会话读取端口；未接线时返回服务未就绪。 */
  readonly conversation?: ConversationReadPort;
  readonly projection: () => PlayerProjection;
  readonly clock: () => ClockView;
  readonly pause: ClockControlHook;
  readonly resume: ClockControlHook;
  readonly save: {
    createSnapshot: SnapshotCreateHook;
    listSnapshots: () => readonly SnapshotRecordView[];
    restoreSnapshot: SnapshotRestoreHook;
  };
  readonly reset: ResetHook;
  readonly identities: readonly ServerIdentity[];
  readonly ids: IdGenerator;
  readonly tokens: TokenIssuer;
  readonly allowedOrigins?: readonly string[];
  readonly onBranchChanged?: BranchChangedHook;
  /** 玩家 WS 连接数变化；宿主据此在全部玩家断线超时后自动暂停。 */
  readonly onPlayerConnectionsChanged?: (connected: number) => void;
  readonly healthStatus?: () => "starting" | "ready" | "degraded";
  /** 认证、票据与过期判断使用的当前毫秒时间；默认 Date.now，测试可注入。 */
  readonly now?: () => number;
}

/** 传输层测试与嵌入式调用使用的 HTTP 方法集合。 */
export type ServerAppInjectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** 注入请求的最小选项；语义与传输适配器一致，但不暴露其内部类型。 */
export interface ServerAppInjectOptions {
  readonly method: ServerAppInjectMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: unknown;
}

/** 注入响应的最小视图；只保留状态码、响应头与 JSON 读取。 */
export interface ServerAppInjectResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly body: string;
  /** 解析后的响应体；调用方可按已知契约收窄，宿主不暴露框架的 any 默认值。 */
  json<T = Json>(): T;
}

/**
 * 传输层对宿主公开的最小应用接口：监听、关闭、测试注入与世界变化通知。
 * 不继承具体框架类型；宿主只依赖这些能力，监听与关闭由传输模块实现。
 */
export interface ServerApp {
  listen(options: { readonly host: string; readonly port: number }): Promise<void>;
  close(): Promise<void>;
  inject(options: ServerAppInjectOptions): Promise<ServerAppInjectResponse>;
  notifyWorldChanged(): void;
  /** 当前监听地址；尚未监听时返回 null，供测试建立真实连接。 */
  address(): { readonly host: string; readonly port: number } | null;
  /** 流会话、票据、连接与重放缓冲的计数；用于确认后台对象有界。 */
  streamStats(): StreamStats;
}

/** 会话类型别名：HTTP 会话视图复用流中心的会话结构，分支在认证时按当前在线入口刷新。 */
export type HttpSession = StreamSession;
