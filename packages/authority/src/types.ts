/**
 * 定义 authority 的规则注册类型、处理器签名与共享运行时依赖。
 * 依赖公共契约的信封、主体、存储与宿主类型，以及 module-sdk 的事务内端口。
 * 禁止在此执行事务、生成 receipt 或把未登记的命令、job、消费者当作合法输入。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 函数类型参数名用于表达调用契约，运行时不会读取。 */
import type {
  AuthContext,
  CommandEnvelope,
  CommandType,
  EventEnvelope,
  HostServices,
  Json,
  PrincipalKind,
  StoragePort,
} from "@ai-npc/contracts";
import type { ApprovedSpeechReader, HandlerContext, HandlerResult, ModuleBinder } from "@ai-npc/module-sdk";

/** 命令处理器：必须是同步函数，payload 已通过契约 schema 校验。 */
export type CommandHandler<TModules = unknown, TContent = unknown> = (
  context: HandlerContext<TModules, TContent>,
  payload: Json,
  envelope: CommandEnvelope,
) => HandlerResult;

/** 命令后续钩子：与主处理器同一事务，必须返回 accepted 或 rejected。 */
export type AfterCommandHook<TModules = unknown, TContent = unknown> = (
  context: HandlerContext<TModules, TContent>,
  payload: Json,
  envelope: CommandEnvelope,
) => HandlerResult;

/** job 到期时传给处理器的持久化信息；payload 是创建 job 时登记的 JSON。 */
export interface DueJob {
  readonly jobId: string;
  readonly kind: string;
  readonly dueTick: number;
  readonly seq: number;
  readonly idempotencyKey: string;
  readonly payload: Json;
}

/** 规则 job 处理器：同步执行，由 JobRunner 在独立事务内调用；返回值必须被忽略。 */
export type JobHandler<TModules = unknown, TContent = unknown> = (
  context: HandlerContext<TModules, TContent>,
  job: DueJob,
) => unknown;

/** 时钟步骤：when 在 authority 读取当前 tick 后求值，handler 在时钟事务内执行。 */
export interface ClockStepRegistration<TModules = unknown, TContent = unknown> {
  readonly stepId: string;
  readonly when: (tick: number) => boolean;
  readonly handler: (context: HandlerContext<TModules, TContent>, tick: number) => unknown;
}

/** 事件消费者：每个消费者按 worldSeq 顺序处理匹配事件，offset 与 inbox 原子提交。 */
export interface EventConsumerRegistration<TModules = unknown, TContent = unknown> {
  readonly consumerId: string;
  readonly eventTypes?: readonly string[];
  readonly handler: (context: HandlerContext<TModules, TContent>, event: EventEnvelope) => unknown;
}

/** 单个模块贡献的命令、后续钩子、job、时钟步骤与事件消费者。 */
export interface RuleContributor<TModules = unknown, TContent = unknown> {
  readonly moduleId: string;
  readonly ownsAggregates: readonly string[];
  readonly commands?: readonly {
    readonly type: CommandType;
    readonly handler: CommandHandler<TModules, TContent>;
  }[];
  readonly afterCommands?: readonly {
    readonly type: CommandType;
    readonly hook: AfterCommandHook<TModules, TContent>;
  }[];
  readonly jobs?: readonly {
    readonly kind: string;
    readonly handler: JobHandler<TModules, TContent>;
  }[];
  readonly clockSteps?: readonly ClockStepRegistration<TModules, TContent>[];
  readonly consumers?: readonly EventConsumerRegistration<TModules, TContent>[];
}

/** 一个已注册模块的写作用域与注册顺序。 */
export interface ContributorScope {
  readonly moduleId: string;
  readonly ownsAggregates: ReadonlySet<string>;
  readonly order: number;
}

/** registry 内部保存的同步命令处理器；泛型上下文在注册边界收窄后擦除。 */
export type StoredCommandHandler = (
  context: HandlerContext<unknown, unknown>,
  payload: Json,
  envelope: CommandEnvelope,
) => HandlerResult;

/** registry 内部保存的同步后续钩子。 */
export type StoredAfterCommandHook = (
  context: HandlerContext<unknown, unknown>,
  payload: Json,
  envelope: CommandEnvelope,
) => HandlerResult;

/** registry 内部保存的同步 job 处理器。 */
export type StoredJobHandler = (context: HandlerContext<unknown, unknown>, job: DueJob) => unknown;

/** registry 内部保存的同步时钟步骤。 */
export type StoredClockStep = {
  readonly stepId: string;
  readonly owner: ContributorScope;
  readonly when: (tick: number) => boolean;
  readonly handler: (context: HandlerContext<unknown, unknown>, tick: number) => unknown;
};

/** registry 内部保存的同步事件消费者。 */
export type StoredEventConsumer = {
  readonly consumerId: string;
  readonly owner: ContributorScope;
  readonly eventTypes: ReadonlySet<string> | null;
  readonly handler: (context: HandlerContext<unknown, unknown>, event: EventEnvelope) => unknown;
};

/** registry 内部保存的命令注册。 */
export interface RegisteredCommand {
  readonly type: CommandType;
  readonly owner: ContributorScope;
  readonly handler: StoredCommandHandler;
}

/** registry 内部保存的后续钩子注册。 */
export interface RegisteredAfterCommand {
  readonly type: CommandType;
  readonly owner: ContributorScope;
  readonly hook: StoredAfterCommandHook;
}

/** registry 内部保存的 job 注册。 */
export interface RegisteredJob {
  readonly kind: string;
  readonly owner: ContributorScope;
  readonly handler: StoredJobHandler;
}

/** 命令、job、时钟与消费者共享的宿主依赖。 */
export interface RuleRuntime {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly modules: unknown;
  readonly content: unknown;
  readonly approvedSpeech: ApprovedSpeechReader;
  readonly moduleBinder?: ModuleBinder;
}

/** 允许直接提交 Agent 命令的测试开关只在构造时给出，生产装配不开启。 */
export interface CommandGatewayOptions extends RuleRuntime {
  readonly registry: import("./rule-registry").RuleRegistry;
  readonly allowDirectAgentCommands?: boolean;
}

/** 授权矩阵使用的有效主体类型：真人席位代发时按 Agent 权限裁决。 */
export function effectivePrincipalKind(auth: AuthContext): PrincipalKind {
  return auth.actingAsAgentId === null ? auth.kind : "agent";
}
