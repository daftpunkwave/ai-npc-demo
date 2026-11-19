/**
 * 服务端组合根：显式登记全部 server 模块定义，并从已启动实例的公开端口装配运行期端口与规则贡献。
 * 应用组合根只允许本文件引用模块包；其他 host 文件只经此入口取用。
 * 禁止在这里启动服务、打开存储、按模块 ID 挑选实现或手工构造模块实例。
 */
import {
  capabilityIdSchema,
  type CapabilityRef,
  type HostServices,
  type InstanceScope,
  type StoragePort,
} from "@ai-npc/contracts";
import type { PlannedModule, ResolvedRealmPlan, RunningInstance } from "@ai-npc/kernel";
import type {
  GameClockPort,
  GameContent,
  GameModulePorts,
  GamePortBindContext,
  GameRuleContributor,
  ModuleBinder,
  ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { clockConfigSchema, clockModuleDefinition, type ClockConfig } from "@ai-npc/mod-game-clock-controlled";
import { mapModuleDefinition } from "@ai-npc/mod-game-map-six-nodes";
import { resourcesModuleDefinition } from "@ai-npc/mod-game-resources-light";
import { worldModuleDefinition } from "@ai-npc/mod-game-world-slg-light";
import { commsModuleDefinition } from "@ai-npc/mod-game-comms-standard";
import { actionsModuleDefinition } from "@ai-npc/mod-game-actions-standard";
import { agreementsModuleDefinition } from "@ai-npc/mod-game-agreements-standard";
import {
  escalatingScenarioModuleDefinition,
  scenarioModuleDefinition,
} from "@ai-npc/mod-game-scenario-watergate";
import { saveModuleDefinition, SqliteSaveService } from "@ai-npc/mod-game-save-sqlite";
import {
  accessPolicyModuleDefinition,
  type AccessPolicyPort,
} from "@ai-npc/mod-platform-access-policy-roster";
import { secretsModuleDefinition } from "@ai-npc/mod-platform-secrets-env";
import { operationsModuleDefinition, OperationsService, type OperationsDriver } from "@ai-npc/mod-platform-operations-standard";
import {
  transportModuleDefinition,
  transportConfigSchema,
  createServerApp,
  type TransportConfig,
  type TransportPort,
} from "@ai-npc/mod-transport-http-ws-fastify";

export { toGameContent } from "./content-adapter";

/** 创建运营编排服务；宿主注入时钟/存档/分支回调。 */
export function createOperationsService(driver: OperationsDriver): OperationsService {
  return new OperationsService(driver);
}

/** 解析并校验传输配置。 */
export function parseTransportConfig(config: unknown): TransportConfig {
  return transportConfigSchema.parse(config);
}

export type { OperationsDriver, TransportPort };
export { transportModuleDefinition, operationsModuleDefinition, createServerApp };
export type {
  AuthorityPort,
  CommandReceiptReadPort,
  ServerApp,
  ServerAppInjectResponse,
  ServerAppOptions,
  ServerIdentity,
} from "@ai-npc/mod-transport-http-ws-fastify";
export type { ConversationReadPort, ConversationReadQuery, ConversationSourceLine } from "@ai-npc/mod-transport-http-ws-fastify";

/** 创建存档领域服务；宿主只经组合根引用具体实现。 */
export function createSaveService(storage: StoragePort, host: HostServices): SqliteSaveService {
  return new SqliteSaveService(storage, host);
}

/** 全部 server 模块定义；moduleId 唯一性由注册表与 check-catalog 校验。 */
export const serverModuleDefinitions = [
  storageModuleDefinition,
  clockModuleDefinition,
  mapModuleDefinition,
  resourcesModuleDefinition,
  worldModuleDefinition,
  commsModuleDefinition,
  actionsModuleDefinition,
  agreementsModuleDefinition,
  scenarioModuleDefinition,
  escalatingScenarioModuleDefinition,
  saveModuleDefinition,
  accessPolicyModuleDefinition,
  secretsModuleDefinition,
  operationsModuleDefinition,
  transportModuleDefinition,
] as const;

function requiredCapability(capability: string, instanceScope: InstanceScope): CapabilityRef {
  return {
    capability: capabilityIdSchema.parse(capability),
    cardinality: "exactly-one",
    instanceScope,
  };
}

/**
 * 服务端宿主固定必需能力：全部游戏能力、部署级存储/密钥/权限、运营与传输。
 * 装配缺失任一项时解析阶段直接失败，不进入存储启动。
 */
export const serverRequiredCapabilities: readonly CapabilityRef[] = [
  requiredCapability("game.world", "run"),
  requiredCapability("game.map", "run"),
  requiredCapability("game.clock", "run"),
  requiredCapability("game.resources", "run"),
  requiredCapability("game.actions", "run"),
  requiredCapability("game.agreements", "run"),
  requiredCapability("game.comms", "run"),
  requiredCapability("game.scenario", "run"),
  requiredCapability("game.save", "run"),
  requiredCapability("platform.storage", "deployment"),
  requiredCapability("platform.access-policy", "deployment"),
  requiredCapability("platform.secrets", "deployment"),
  requiredCapability("platform.operations", "run"),
  requiredCapability("transport.http-ws", "deployment"),
];

/**
 * 游戏能力的绑定顺序；被依赖的能力先绑定，后续模块只能经已绑定的 typed port 读取事实。
 * 顺序与领域模型声明的依赖一致：map/resources → world → comms → actions → agreements → scenario。
 */
const gameCapabilities = [
  "game.map",
  "game.resources",
  "game.world",
  "game.comms",
  "game.actions",
  "game.agreements",
  "game.scenario",
] as const;

/** 模块实例公开端口的最小结构：事务绑定器与可选的规则贡献。 */
interface GameModulePublicPort {
  readonly bind: (
    txFor: ScopedWorldTxFactory,
    content: GameContent,
    ids: (prefix: string) => string,
    context: GamePortBindContext,
  ) => unknown;
  readonly contributor?: GameRuleContributor<GameModulePorts, unknown>;
}

/** 运营模块公开端口：按宿主驱动创建一次运营编排服务。 */
export interface OperationsFactory {
  create(driver: OperationsDriver): OperationsService;
}

/** 宿主从解析计划实例化后的运行期端口集合。 */
export interface ServerRuntime {
  readonly storage: StoragePort;
  readonly clock: GameClockPort;
  readonly transport: TransportPort;
  /** 装配声明的权限端口；宿主把它交给传输层裁决玩家、控制台与频道访问。 */
  readonly accessPolicy: AccessPolicyPort;
  readonly operations: OperationsFactory;
  readonly save: SqliteSaveService;
  readonly binder: ModuleBinder;
  readonly contributors: readonly GameRuleContributor<GameModulePorts, unknown>[];
}

/** 在实例计划中定位提供指定能力的模块；缺失说明预检被绕过，直接失败。 */
export function plannedModuleForCapability(plan: ResolvedRealmPlan, capability: string): PlannedModule {
  const planned = plan.modules.find((module) =>
    module.definition.provides.some((provided) => provided.capability === capability),
  );
  if (planned === undefined) {
    throw new Error(`解析计划缺少能力 ${capability} 的提供者`);
  }
  return planned;
}

/**
 * 读取在线装配中时钟 provider 的有效配置；默认值已由描述符 schema 填充。
 * 宿主据此驱动 worker 间隔与断线自动暂停阈值，不自行解析 clock 行。
 */
export function clockConfigOf(plan: ResolvedRealmPlan): Required<ClockConfig> {
  const config = clockConfigSchema.parse(plannedModuleForCapability(plan, "game.clock").config);
  return {
    secondsPerTick: config.secondsPerTick,
    maxStepTicks: config.maxStepTicks,
    autoPauseAfterDisconnectMs: config.autoPauseAfterDisconnectMs ?? 60_000,
  };
}

function runningInstanceFor(
  plan: ResolvedRealmPlan,
  instances: readonly RunningInstance[],
  capability: string,
): { readonly planned: PlannedModule; readonly running: RunningInstance } {
  const planned = plannedModuleForCapability(plan, capability);
  const running = instances.find((instance) => instance.moduleId === planned.moduleId);
  if (running === undefined) {
    throw new Error(`模块 ${planned.moduleId} 没有启动实例，无法提供能力 ${capability}`);
  }
  return { planned, running };
}

function portFor<T>(
  plan: ResolvedRealmPlan,
  instances: readonly RunningInstance[],
  capability: string,
): T {
  const { planned, running } = runningInstanceFor(plan, instances, capability);
  if (running.port === undefined) {
    throw new Error(`模块 ${planned.moduleId} 没有暴露能力 ${capability} 的端口`);
  }
  return running.port as T;
}

/**
 * 从已启动实例的公开端口构造宿主运行期端口：
 * 游戏端口由各模块自己的绑定器按事务绑定，规则贡献只取实例公开端口声明的部分。
 */
export function createServerRuntime(input: {
  readonly plan: ResolvedRealmPlan;
  readonly instances: readonly RunningInstance[];
  readonly content: GameContent;
  readonly host: HostServices;
}): ServerRuntime {
  const { plan, instances, content, host } = input;
  const binders = new Map<string, GameModulePublicPort["bind"]>();
  const contributors: GameRuleContributor<GameModulePorts, unknown>[] = [];
  for (const planned of plan.modules) {
    const running = instances.find((instance) => instance.moduleId === planned.moduleId);
    if (running === undefined) {
      throw new Error(`模块 ${planned.moduleId} 没有启动实例`);
    }
    const providedGameCapabilities = planned.definition.provides.filter((provided) =>
      gameCapabilities.includes(provided.capability as (typeof gameCapabilities)[number]),
    );
    if (providedGameCapabilities.length === 0) {
      continue;
    }
    const port = running.port as Partial<GameModulePublicPort> | undefined;
    if (port === undefined || typeof port.bind !== "function") {
      throw new Error(`模块 ${planned.moduleId} 没有暴露事务端口绑定器`);
    }
    for (const provided of providedGameCapabilities) {
      binders.set(provided.capability, port.bind);
    }
    if (port.contributor === undefined) {
      throw new Error(`游戏模块 ${planned.moduleId} 没有通过公开端口暴露规则贡献`);
    }
    if (port.contributor.moduleId !== planned.moduleId) {
      throw new Error(
        `游戏模块 ${planned.moduleId} 暴露的规则贡献属于 ${port.contributor.moduleId}`,
      );
    }
    contributors.push(port.contributor);
  }

  const binder: ModuleBinder = (txFor) => {
    const ports: Record<string, unknown> = {};
    for (const capability of gameCapabilities) {
      const bind = binders.get(capability);
      if (bind === undefined) {
        throw new Error(`装配缺少游戏能力 ${capability} 的端口绑定器`);
      }
      // 每个模块只拿到自己按能力声明的 typed port；读取他人事实必须经已绑定的端口。
      const context: GamePortBindContext = { ports: ports as Readonly<Partial<GameModulePorts>> };
      ports[capability] = bind(txFor, content, (prefix) => host.ids(prefix), context);
    }
    return ports as unknown as GameModulePorts;
  };

  const savePort = portFor<{ readonly save?: SqliteSaveService }>(plan, instances, "game.save");
  if (savePort.save === undefined) {
    throw new Error("存档模块没有通过公开端口暴露存档服务");
  }
  return {
    storage: portFor<StoragePort>(plan, instances, "platform.storage"),
    clock: portFor<GameClockPort>(plan, instances, "game.clock"),
    transport: portFor<TransportPort>(plan, instances, "transport.http-ws"),
    accessPolicy: portFor<AccessPolicyPort>(plan, instances, "platform.access-policy"),
    operations: portFor<OperationsFactory>(plan, instances, "platform.operations"),
    save: savePort.save,
    binder,
    contributors,
  };
}
