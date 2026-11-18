/**
 * 注册模块贡献的命令、后续钩子、job、时钟步骤与事件消费者，并校验重复与写作用域。
 * 依赖公共契约的命令类型与领域错误，以及 authority 的注册类型；注册顺序即处理器执行顺序。
 * 禁止自动扫描模块、允许两个模块拥有同一聚合类型，或在注册后静默覆盖已有处理器。
 */
import { DomainError, commandTypeSchema, type CommandType, type Json } from "@ai-npc/contracts";
import type { HandlerContext } from "@ai-npc/module-sdk";
import type {
  AfterCommandHook,
  ClockStepRegistration,
  CommandHandler,
  ContributorScope,
  JobHandler,
  RegisteredAfterCommand,
  RegisteredCommand,
  RegisteredJob,
  RuleContributor,
  StoredAfterCommandHook,
  StoredClockStep,
  StoredCommandHandler,
  StoredEventConsumer,
  StoredJobHandler,
} from "./types";

function assemblyFailure(message: string, details: Record<string, Json>): never {
  throw new DomainError("assembly-incompatible", message, { details });
}

function requireNonEmpty(value: string, field: string, moduleId: string): string {
  if (value.trim().length === 0) {
    assemblyFailure(`模块 ${moduleId} 的 ${field} 不能为空`, { moduleId, field });
  }
  return value;
}

function parseCommandType(value: string, moduleId: string, field: string): CommandType {
  const parsed = commandTypeSchema.safeParse(value);
  if (!parsed.success) {
    assemblyFailure(`模块 ${moduleId} 注册了未知命令类型 ${value}`, { moduleId, field, type: value });
  }
  return parsed.data;
}

function wrapCommand<TModules, TContent>(handler: CommandHandler<TModules, TContent>): StoredCommandHandler {
  return (context, payload, envelope) =>
    handler(context as unknown as HandlerContext<TModules, TContent>, payload, envelope);
}

function wrapAfterCommand<TModules, TContent>(
  hook: AfterCommandHook<TModules, TContent>,
): StoredAfterCommandHook {
  return (context, payload, envelope) =>
    hook(context as unknown as HandlerContext<TModules, TContent>, payload, envelope);
}

function wrapJob<TModules, TContent>(handler: JobHandler<TModules, TContent>): StoredJobHandler {
  return (context, job) => {
    return handler(context as unknown as HandlerContext<TModules, TContent>, job);
  };
}

function wrapClockStep<TModules, TContent>(
  step: ClockStepRegistration<TModules, TContent>,
): StoredClockStep["handler"] {
  return (context, tick) => {
    return step.handler(context as unknown as HandlerContext<TModules, TContent>, tick);
  };
}

function normalizeEventTypes(
  eventTypes: readonly string[] | undefined,
  moduleId: string,
  consumerId: string,
): ReadonlySet<string> | null {
  if (eventTypes === undefined || eventTypes.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const type of eventTypes) {
    if (type.trim().length === 0) {
      assemblyFailure(`模块 ${moduleId} 的消费者 ${consumerId} 声明了空事件类型`, {
        moduleId,
        consumerId,
      });
    }
    normalized.add(type);
  }
  return normalized;
}

/** 模块贡献注册表：一个 authority 实例一份，按注册顺序确定处理器与消费者顺序。 */
export class RuleRegistry {
  private readonly contributors = new Map<string, ContributorScope>();
  private readonly aggregateOwners = new Map<string, string>();
  private readonly commands = new Map<CommandType, RegisteredCommand>();
  private readonly moduleAfterCommands = new Map<CommandType, RegisteredAfterCommand[]>();
  private readonly hostAfterCommands = new Map<CommandType, RegisteredAfterCommand[]>();
  private readonly jobs = new Map<string, RegisteredJob>();
  private readonly clockSteps: StoredClockStep[] = [];
  private readonly consumers: StoredEventConsumer[] = [];
  private nextOrder = 0;

  /** 注册一个模块；重复模块 ID、聚合所有权或处理器类型都在启动前失败。 */
  registerModule<TModules = unknown, TContent = unknown>(
    contributor: RuleContributor<TModules, TContent>,
  ): ContributorScope {
    const moduleId = requireNonEmpty(contributor.moduleId, "moduleId", contributor.moduleId);
    if (this.contributors.has(moduleId)) {
      assemblyFailure(`模块 ${moduleId} 重复注册`, { moduleId });
    }
    const ownsAggregates = new Set<string>();
    for (const aggregateType of contributor.ownsAggregates) {
      requireNonEmpty(aggregateType, "ownsAggregates", moduleId);
      if (ownsAggregates.has(aggregateType)) {
        assemblyFailure(`模块 ${moduleId} 重复声明聚合类型 ${aggregateType}`, { moduleId, aggregateType });
      }
      const owner = this.aggregateOwners.get(aggregateType);
      if (owner !== undefined) {
        assemblyFailure(`聚合类型 ${aggregateType} 已由模块 ${owner} 拥有`, {
          moduleId,
          aggregateType,
          owner,
        });
      }
      ownsAggregates.add(aggregateType);
    }

    const commandsToAdd: { readonly type: CommandType; readonly handler: StoredCommandHandler }[] = [];
    const afterToAdd: { readonly type: CommandType; readonly hook: StoredAfterCommandHook }[] = [];
    const jobsToAdd: { readonly kind: string; readonly handler: StoredJobHandler }[] = [];
    const stepsToAdd: {
      readonly stepId: string;
      readonly when: StoredClockStep["when"];
      readonly handler: StoredClockStep["handler"];
    }[] = [];
    const consumersToAdd: {
      readonly consumerId: string;
      readonly eventTypes: ReadonlySet<string> | null;
      readonly handler: StoredEventConsumer["handler"];
    }[] = [];

    const seenCommands = new Set<CommandType>();
    for (const command of contributor.commands ?? []) {
      const type = parseCommandType(command.type, moduleId, "commands");
      if (this.commands.has(type) || seenCommands.has(type)) {
        assemblyFailure(`命令类型 ${type} 已被模块 ${this.commands.get(type)?.owner.moduleId ?? moduleId} 注册`, {
          moduleId,
          type,
        });
      }
      seenCommands.add(type);
      commandsToAdd.push({ type, handler: wrapCommand(command.handler) });
    }

    for (const after of contributor.afterCommands ?? []) {
      const type = parseCommandType(after.type, moduleId, "afterCommands");
      afterToAdd.push({ type, hook: wrapAfterCommand(after.hook) });
    }

    const seenJobs = new Set<string>();
    for (const job of contributor.jobs ?? []) {
      requireNonEmpty(job.kind, "jobs.kind", moduleId);
      if (this.jobs.has(job.kind) || seenJobs.has(job.kind)) {
        assemblyFailure(`job 类型 ${job.kind} 已被模块 ${this.jobs.get(job.kind)?.owner.moduleId ?? moduleId} 注册`, {
          moduleId,
          kind: job.kind,
        });
      }
      seenJobs.add(job.kind);
      jobsToAdd.push({ kind: job.kind, handler: wrapJob(job.handler) });
    }

    const seenSteps = new Set<string>();
    for (const step of contributor.clockSteps ?? []) {
      requireNonEmpty(step.stepId, "clockSteps.stepId", moduleId);
      if (seenSteps.has(step.stepId) || this.clockSteps.some((registered) => registered.stepId === step.stepId)) {
        assemblyFailure(`时钟步骤 ${step.stepId} 重复注册`, { moduleId, stepId: step.stepId });
      }
      seenSteps.add(step.stepId);
      stepsToAdd.push({ stepId: step.stepId, when: step.when, handler: wrapClockStep(step) });
    }

    const seenConsumers = new Set<string>();
    for (const consumer of contributor.consumers ?? []) {
      requireNonEmpty(consumer.consumerId, "consumers.consumerId", moduleId);
      if (
        seenConsumers.has(consumer.consumerId) ||
        this.consumers.some((registered) => registered.consumerId === consumer.consumerId)
      ) {
        assemblyFailure(`事件消费者 ${consumer.consumerId} 重复注册`, {
          moduleId,
          consumerId: consumer.consumerId,
        });
      }
      seenConsumers.add(consumer.consumerId);
      consumersToAdd.push({
        consumerId: consumer.consumerId,
        eventTypes: normalizeEventTypes(consumer.eventTypes, moduleId, consumer.consumerId),
        handler: (context, event) => {
          return consumer.handler(context as unknown as HandlerContext<TModules, TContent>, event);
        },
      });
    }

    const scope: ContributorScope = {
      moduleId,
      ownsAggregates,
      order: this.nextOrder,
    };
    this.nextOrder += 1;
    this.contributors.set(moduleId, scope);
    for (const aggregateType of ownsAggregates) {
      this.aggregateOwners.set(aggregateType, moduleId);
    }
    for (const command of commandsToAdd) {
      this.commands.set(command.type, { type: command.type, owner: scope, handler: command.handler });
    }
    for (const after of afterToAdd) {
      this.appendAfterCommand(this.moduleAfterCommands, after.type, scope, after.hook);
    }
    for (const job of jobsToAdd) {
      this.jobs.set(job.kind, { kind: job.kind, owner: scope, handler: job.handler });
    }
    for (const step of stepsToAdd) {
      this.clockSteps.push({ ...step, owner: scope });
    }
    for (const consumer of consumersToAdd) {
      this.consumers.push({ ...consumer, owner: scope });
    }
    return scope;
  }

  /** 为已注册模块追加一个命令后续钩子；同一命令可有多个钩子，按注册顺序执行。 */
  afterCommand<TModules = unknown, TContent = unknown>(
    moduleId: string,
    type: CommandType,
    hook: AfterCommandHook<TModules, TContent>,
  ): void {
    const owner = this.contributors.get(moduleId);
    if (owner === undefined) {
      assemblyFailure(`模块 ${moduleId} 尚未注册，不能添加后续钩子`, { moduleId, type });
    }
    const parsedType = parseCommandType(type, moduleId, "afterCommand");
    this.appendAfterCommand(this.moduleAfterCommands, parsedType, owner, wrapAfterCommand(hook));
  }

  /**
   * 追加宿主后续钩子；宿主钩子总在游戏模块钩子之后执行。
   * 宿主不拥有 aggregate_state，因此只获得空写作用域，专用表由宿主自己的服务写入。
   */
  hostAfterCommand<TModules = unknown, TContent = unknown>(
    ownerId: string,
    type: CommandType,
    hook: AfterCommandHook<TModules, TContent>,
  ): void {
    requireNonEmpty(ownerId, "ownerId", ownerId);
    const parsedType = parseCommandType(type, ownerId, "hostAfterCommand");
    const owner: ContributorScope = {
      moduleId: ownerId,
      ownsAggregates: new Set<string>(),
      order: Number.MAX_SAFE_INTEGER,
    };
    this.appendAfterCommand(this.hostAfterCommands, parsedType, owner, wrapAfterCommand(hook));
  }

  command(type: string): RegisteredCommand | undefined {
    return this.commands.get(type as CommandType);
  }

  job(kind: string): RegisteredJob | undefined {
    return this.jobs.get(kind);
  }

  /** 返回按“游戏模块注册顺序，宿主最后”排列的后续钩子。 */
  afterCommandsFor(type: string): readonly RegisteredAfterCommand[] {
    const moduleHooks = this.moduleAfterCommands.get(type as CommandType) ?? [];
    const hostHooks = this.hostAfterCommands.get(type as CommandType) ?? [];
    return [...moduleHooks, ...hostHooks];
  }

  clockStepList(): readonly StoredClockStep[] {
    return this.clockSteps;
  }

  consumerList(): readonly StoredEventConsumer[] {
    return this.consumers;
  }

  contributor(moduleId: string): ContributorScope | undefined {
    return this.contributors.get(moduleId);
  }

  private appendAfterCommand(
    target: Map<CommandType, RegisteredAfterCommand[]>,
    type: CommandType,
    owner: ContributorScope,
    hook: StoredAfterCommandHook,
  ): void {
    const list = target.get(type);
    if (list === undefined) {
      target.set(type, [{ type, owner, hook }]);
      return;
    }
    list.push({ type, owner, hook });
  }
}
