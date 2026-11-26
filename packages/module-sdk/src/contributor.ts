/**
 * 定义模块作者注册规则处理器所需的最小贡献类型。
 * 依赖公共契约的命令/事件信封与模块 SDK 的处理器上下文、结果类型。
 * 禁止在这里实现注册、事务或权限；authority 在装配时校验重复与所有权。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 函数类型参数名只用于表达调用契约，运行时不会读取。 */
import type { CommandEnvelope, CommandType, EventEnvelope, EventPayloadSchema, Json } from "@world-prism/contracts";
import type { HandlerContext, HandlerResult } from "./ports";

/** 到期 job 的持久化视图；字段由 authority 从 jobs 表读出。 */
export interface GameDueJob {
  readonly jobId: string;
  readonly kind: string;
  readonly dueTick: number;
  readonly seq: number;
  readonly idempotencyKey: string;
  readonly payload: Json;
}

/** 同步命令处理器。 */
export type GameCommandHandler<TModules = unknown, TContent = unknown> = (
  context: HandlerContext<TModules, TContent>,
  payload: Json,
  envelope: CommandEnvelope,
) => HandlerResult;

/** 与主处理器同一事务的后续钩子。 */
export type GameAfterCommandHook<TModules = unknown, TContent = unknown> = (
  context: HandlerContext<TModules, TContent>,
  payload: Json,
  envelope: CommandEnvelope,
) => HandlerResult;

/** 同步 job 处理器。 */
export type GameJobHandler<TModules = unknown, TContent = unknown> = (
  context: HandlerContext<TModules, TContent>,
  job: GameDueJob,
) => unknown;

/** 时钟步骤：when 在 authority 读取当前 tick 后求值。 */
export interface GameClockStep<TModules = unknown, TContent = unknown> {
  readonly stepId: string;
  readonly when: (tick: number) => boolean;
  readonly handler: (context: HandlerContext<TModules, TContent>, tick: number) => unknown;
}

/** 事件消费者：按 worldSeq 顺序处理，offset 与 inbox 同事务提交。 */
export interface GameEventConsumer<TModules = unknown, TContent = unknown> {
  readonly consumerId: string;
  readonly eventTypes?: readonly string[];
  readonly handler: (context: HandlerContext<TModules, TContent>, event: EventEnvelope) => unknown;
}

/** 一个模块贡献的规则入口。 */
export interface GameRuleContributor<TModules = unknown, TContent = unknown> {
  readonly moduleId: string;
  readonly ownsAggregates: readonly string[];
  /** 扩展领域事件的显式登记；未登记的事件类型不能写入事务。 */
  readonly events?: readonly {
    readonly type: string;
    readonly payloadSchema: EventPayloadSchema;
  }[];
  readonly commands?: readonly {
    readonly type: CommandType;
    readonly handler: GameCommandHandler<TModules, TContent>;
  }[];
  readonly afterCommands?: readonly {
    readonly type: CommandType;
    readonly hook: GameAfterCommandHook<TModules, TContent>;
  }[];
  readonly jobs?: readonly { readonly kind: string; readonly handler: GameJobHandler<TModules, TContent> }[];
  readonly clockSteps?: readonly GameClockStep<TModules, TContent>[];
  readonly consumers?: readonly GameEventConsumer<TModules, TContent>[];
}
