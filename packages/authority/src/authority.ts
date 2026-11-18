/**
 * 组装命令网关、job、时钟步骤与事件消费者，并暴露模块贡献的注册入口。
 * 依赖注册表、四个固定机制与宿主/存储端口；所有机制共享同一 registry 与作用域规则。
 * 禁止在组装时启动后台循环、自动扫描模块或把 allowDirectAgentCommands 带进生产默认值。
 */
import type { CommandType } from "@ai-npc/contracts";
import { CommandGateway } from "./command-gateway";
import { ClockStepRunner } from "./clock-steps";
import { EventConsumerRunner } from "./consumer-runner";
import { emptyApprovedSpeechReader } from "./handler-context";
import { JobRunner } from "./job-runner";
import { RuleRegistry } from "./rule-registry";
import type { AfterCommandHook, RuleContributor, RuleRuntime } from "./types";

/** 组装 authority 所需的宿主依赖；modules/content 由具体装配提供。 */
export interface AuthorityOptions {
  readonly storage: RuleRuntime["storage"];
  readonly host: RuleRuntime["host"];
  readonly modules?: unknown;
  readonly content?: unknown;
  readonly approvedSpeech?: RuleRuntime["approvedSpeech"];
  readonly allowDirectAgentCommands?: boolean;
}

/** 服务端固定机制的组合根：注册贡献后共享同一规则注册表。 */
export class Authority {
  readonly registry: RuleRegistry;
  readonly commands: CommandGateway;
  readonly jobs: JobRunner;
  readonly consumers: EventConsumerRunner;
  readonly clock: ClockStepRunner;

  constructor(options: AuthorityOptions) {
    this.registry = new RuleRegistry();
    const runtime: RuleRuntime = {
      storage: options.storage,
      host: options.host,
      modules: options.modules ?? {},
      content: options.content ?? null,
      approvedSpeech: options.approvedSpeech ?? emptyApprovedSpeechReader,
    };
    this.commands = new CommandGateway({
      ...runtime,
      registry: this.registry,
      allowDirectAgentCommands: options.allowDirectAgentCommands ?? false,
    });
    this.jobs = new JobRunner({ ...runtime, registry: this.registry });
    this.consumers = new EventConsumerRunner({ ...runtime, registry: this.registry });
    this.clock = new ClockStepRunner({ ...runtime, registry: this.registry });
  }

  /** 注册一个模块贡献；重复处理器或聚合所有权在注册时立即失败。 */
  registerModule<TModules = unknown, TContent = unknown>(
    contributor: RuleContributor<TModules, TContent>,
  ): void {
    this.registry.registerModule(contributor);
  }

  /** 追加已注册模块的命令后续钩子。 */
  afterCommand<TModules = unknown, TContent = unknown>(
    moduleId: string,
    type: CommandType,
    hook: AfterCommandHook<TModules, TContent>,
  ): void {
    this.registry.afterCommand(moduleId, type, hook);
  }

  /** 追加宿主后续钩子，执行顺序总在游戏模块之后。 */
  hostAfterCommand<TModules = unknown, TContent = unknown>(
    ownerId: string,
    type: CommandType,
    hook: AfterCommandHook<TModules, TContent>,
  ): void {
    this.registry.hostAfterCommand(ownerId, type, hook);
  }
}
