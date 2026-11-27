/**
 * 服务端组合根：显式登记全部 server 模块定义，并从已启动实例的公开端口装配运行期端口与规则贡献。
 * 应用组合根只允许本文件引用模块包；其他 host 文件只经此入口取用。
 * 禁止在这里启动服务、打开存储、按模块 ID 挑选实现或手工构造模块实例。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import {
  capabilityIdSchema,
  type CapabilityRef,
  type HostServices,
  type InstanceScope,
  type StoragePort,
} from "@world-prism/contracts";
import type { PlannedModule, ResolvedRealmPlan, RunningInstance } from "@world-prism/kernel";
import type {
  GameClockPort,
  GameContent,
  GameModulePorts,
  GameRuleContributor,
  ModuleBinder,
  SavePort,
} from "@world-prism/module-sdk";
import { resolveGameModuleBindings } from "./game-port-binder";
import { compressionNoneModuleDefinition } from "@world-prism/mod-agent-compression-none/definition";
import { compressionWindowModuleDefinition } from "@world-prism/mod-agent-compression-window/definition";
import { orderedBlocksContextDefinition } from "@world-prism/mod-agent-context-ordered-blocks/definition";
import { deterministicDecisionModuleDefinition } from "@world-prism/mod-agent-decision-deterministic/definition";
import { modelDecisionDefinition } from "@world-prism/mod-agent-decision-model/definition";
import { sharedModelPoolDefinition } from "@world-prism/mod-agent-model-pool-shared/definition";
import {
  memoryLayeredHybridModuleDefinition,
  memoryLedgerModuleDefinition,
  memoryStreamReflectionModuleDefinition,
} from "@world-prism/mod-agent-memory-ledger/definition";
import { memoryNoneModuleDefinition } from "@world-prism/mod-agent-memory-none/definition";
import { perceptionModuleDefinition } from "@world-prism/mod-agent-perception-local/definition";
import { schedulingModuleDefinition } from "@world-prism/mod-agent-scheduling-fair/definition";
import { structuredToolViewModuleDefinition } from "@world-prism/mod-agent-tool-view-structured/definition";
import { gameToolsModuleDefinition } from "@world-prism/mod-agent-tools-game-tools/definition";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { clockConfigSchema, clockModuleDefinition, type ClockConfig } from "@world-prism/mod-game-clock-controlled";
import { mapModuleDefinition } from "@world-prism/mod-game-map-six-nodes";
import { resourcesModuleDefinition } from "@world-prism/mod-game-resources-light";
import { worldConfigSchema, worldModuleDefinition } from "@world-prism/mod-game-world-slg-light";
import { commsModuleDefinition } from "@world-prism/mod-game-comms-standard";
import { actionsModuleDefinition } from "@world-prism/mod-game-actions-standard";
import { agreementsModuleDefinition } from "@world-prism/mod-game-agreements-standard";
import {
  escalatingScenarioModuleDefinition,
  scenarioModuleDefinition,
} from "@world-prism/mod-game-scenario-watergate";
import { saveModuleDefinition } from "@world-prism/mod-game-save-sqlite";
import {
  accessPolicyModuleDefinition,
  type AccessPolicyPort,
} from "@world-prism/mod-platform-access-policy-roster";
import { secretsModuleDefinition } from "@world-prism/mod-platform-secrets-env";
import { modelBudgetDefinition } from "@world-prism/mod-platform-budget-standard/definition";
import { evaluationModuleDefinition } from "@world-prism/mod-platform-evaluation-standard/definition";
import { anthropicTransportDefinition } from "@world-prism/mod-platform-model-transport-anthropic/definition";
import { deterministicModelTransportDefinition } from "@world-prism/mod-platform-model-transport-deterministic/definition";
import { openAICompatibleTransportDefinition } from "@world-prism/mod-platform-model-transport-openai-compatible/definition";
import { operationsModuleDefinition, OperationsService, type OperationsDriver } from "@world-prism/mod-platform-operations-standard";
import {
  observabilityModuleDefinition,
  ObservabilityPort,
} from "@world-prism/mod-platform-observability-sqlite";
import {
  moduleAdminModuleDefinition,
  ModuleAdminPort,
} from "@world-prism/mod-platform-module-admin-standard";
import {
  transportModuleDefinition,
  transportConfigSchema,
  createServerApp,
  type TransportConfig,
  type TransportPort,
} from "@world-prism/mod-transport-http-ws-fastify";
import { cameraModuleDefinition } from "@world-prism/mod-client-camera-standard/definition";
import { charactersModuleDefinition } from "@world-prism/mod-client-characters-standard/definition";
import { dialogueModuleDefinition } from "@world-prism/mod-client-dialogue-standard/definition";
import { factionStartModuleDefinition } from "@world-prism/mod-client-faction-start-standard/definition";
import { hudModuleDefinition } from "@world-prism/mod-client-hud-standard/definition";
import { inputModuleDefinition } from "@world-prism/mod-client-input-standard/definition";
import { notificationsModuleDefinition } from "@world-prism/mod-client-notifications-standard/definition";
import { nullSceneModuleDefinition } from "@world-prism/mod-client-scene-renderer-null/definition";
import { pixiSceneModuleDefinition } from "@world-prism/mod-client-scene-renderer-pixi/definition";
import { projectionModuleDefinition } from "@world-prism/mod-client-screen-projection-isometric/definition";
import { settingsModuleDefinition } from "@world-prism/mod-client-settings-standard/definition";
import { worldViewModuleDefinition } from "@world-prism/mod-client-world-view-standard/definition";
import { healthPageModuleDefinition } from "@world-prism/mod-console-health-standard/definition";
import { moduleAdminPageModuleDefinition } from "@world-prism/mod-console-module-admin-standard/definition";
import { modelMountsPageModuleDefinition } from "@world-prism/mod-console-model-mounts-standard/definition";
import { factionOpsPageModuleDefinition } from "@world-prism/mod-console-faction-ops-standard/definition";
import { debugPageModuleDefinition } from "@world-prism/mod-console-debug-standard/definition";
import { observabilityPageModuleDefinition } from "@world-prism/mod-console-observability-standard/definition";
import { evaluationPageModuleDefinition } from "@world-prism/mod-console-evaluation-standard/definition";

export { toGameContent } from "./content-adapter";
export {
  resolveGameModuleBindings,
  type GameModulePublicPort,
} from "./game-port-binder";

/** 解析并校验传输配置；宿主只在这里接触传输模块的配置 schema。 */
export function parseTransportConfig(config: unknown): TransportConfig {
  return transportConfigSchema.parse(config);
}

export type { OperationsDriver, TransportPort };
export type { EvaluationPort } from "@world-prism/mod-platform-evaluation-standard";
export type {
  ProbeExecution,
  ReportBehavior,
  ReportCost,
  ReportLatency,
  ReportMemory,
  RunReport,
} from "@world-prism/mod-platform-evaluation-standard";
export type {
  IdempotentOperationsDriver,
  OperationRequest,
  RestoreInput,
  RestoreOutcome,
  SnapshotInput,
  SnapshotView,
} from "@world-prism/mod-platform-operations-standard";
export { transportModuleDefinition, operationsModuleDefinition, createServerApp };
export type {
  AuthorityPort,
  CommandReceiptReadPort,
  ServerApp,
  ServerAppInjectResponse,
  ServerAppOptions,
  ServerIdentity,
} from "@world-prism/mod-transport-http-ws-fastify";
export type { ConversationReadPort, ConversationReadQuery, ConversationSourceLine } from "@world-prism/mod-transport-http-ws-fastify";

/** 全部 server 模块定义；moduleId 唯一性由注册表与 check-catalog 校验。 */
export const serverLiveModelTransportDefinitions = [openAICompatibleTransportDefinition, anthropicTransportDefinition] as const;

export const serverModelModuleDefinitions = [
  modelDecisionDefinition, sharedModelPoolDefinition, modelBudgetDefinition, deterministicModelTransportDefinition,
  ...serverLiveModelTransportDefinitions,
] as const;

export const serverAgentModuleDefinitions = [
  compressionNoneModuleDefinition,
  compressionWindowModuleDefinition,
  orderedBlocksContextDefinition,
  deterministicDecisionModuleDefinition,
  memoryLedgerModuleDefinition,
  memoryStreamReflectionModuleDefinition,
  memoryLayeredHybridModuleDefinition,
  memoryNoneModuleDefinition,
  perceptionModuleDefinition,
  schedulingModuleDefinition,
  structuredToolViewModuleDefinition,
  gameToolsModuleDefinition,
  ...serverModelModuleDefinitions,
] as const;

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
  observabilityModuleDefinition,
  moduleAdminModuleDefinition,
  evaluationModuleDefinition,
  transportModuleDefinition,
  ...serverAgentModuleDefinitions,
] as const;

/** 浏览器两端目录只含描述符；服务端不加载其 React/Pixi 实现。 */
export const browserModuleDefinitions = [
  worldViewModuleDefinition,
  pixiSceneModuleDefinition,
  nullSceneModuleDefinition,
  cameraModuleDefinition,
  projectionModuleDefinition,
  inputModuleDefinition,
  hudModuleDefinition,
  dialogueModuleDefinition,
  factionStartModuleDefinition,
  charactersModuleDefinition,
  settingsModuleDefinition,
  notificationsModuleDefinition,
  healthPageModuleDefinition,
  moduleAdminPageModuleDefinition,
  modelMountsPageModuleDefinition,
  factionOpsPageModuleDefinition,
  observabilityPageModuleDefinition,
  evaluationPageModuleDefinition,
  debugPageModuleDefinition,
] as const;

/** 完整三 realm 目录，供浏览器握手与控制台模块管理查询。 */
export const allModuleDefinitions = [
  ...serverModuleDefinitions,
  ...browserModuleDefinitions,
] as const;

function requiredCapability(capability: string, instanceScope: InstanceScope): CapabilityRef {
  return {
    capability: capabilityIdSchema.parse(capability),
    cardinality: "exactly-one",
    instanceScope,
  };
}

export const serverAgentRequiredCapabilities = [
  requiredCapability("agent.scheduling", "run"),
  requiredCapability("agent.tools", "run"),
] as const;

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
  requiredCapability("platform.observability", "deployment"),
  requiredCapability("platform.module-admin", "deployment"),
  requiredCapability("transport.http-ws", "deployment"),
];

/** 玩家浏览器宿主必需能力；缺少任一实现时装配预检失败。 */
export const clientRequiredCapabilities: readonly CapabilityRef[] = [
  requiredCapability("client.world-view", "session"),
  requiredCapability("client.scene-renderer", "session"),
  requiredCapability("client.camera", "session"),
  requiredCapability("client.screen-projection", "session"),
  requiredCapability("client.input", "session"),
  requiredCapability("client.hud", "session"),
  requiredCapability("client.dialogue", "session"),
  requiredCapability("client.faction-start", "session"),
];

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
  readonly observability: ObservabilityPort;
  readonly moduleAdmin: ModuleAdminPort;
  /** 存档端口；宿主的快照、恢复与预检编排只经此端口，不依赖存档实现类。 */
  readonly save: SavePort;
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧装配可能省略该字段，保留 60s 兜底。
    autoPauseAfterDisconnectMs: config.autoPauseAfterDisconnectMs ?? 60_000,
  };
}

/**
 * 读取在线装配中世界模块的章节长度配置；默认值已由描述符 schema 填充。
 * 章节评估 tick 由世界模块的结算规则使用，客户端只读内容视图据此展示。
 */
export function worldChapterLengthOf(plan: ResolvedRealmPlan): number {
  return worldConfigSchema.parse(plannedModuleForCapability(plan, "game.world").config)
    .chapterLengthTicks;
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
 * 游戏端口由各模块自己的绑定器按事务绑定，规则贡献只取实例公开端口声明的部分；
 * 端口绑定顺序与每个处理器可见的能力范围由装配计划推导，不在此维护第二份手写顺序。
 */
export function createServerRuntime(input: {
  readonly plan: ResolvedRealmPlan;
  readonly instances: readonly RunningInstance[];
  readonly content: GameContent;
  readonly host: HostServices;
}): ServerRuntime {
  const { plan, instances, content, host } = input;
  const { binder, contributors } = resolveGameModuleBindings({ plan, instances, content, host });

  const savePort = portFor<{ readonly save?: SavePort }>(plan, instances, "game.save");
  if (savePort.save === undefined) {
    throw new Error("存档模块没有通过公开端口暴露存档服务");
  }
  return {
    storage: portFor<StoragePort>(plan, instances, "platform.storage"),
    clock: portFor<GameClockPort>(plan, instances, "game.clock"),
    transport: portFor<TransportPort>(plan, instances, "transport.http-ws"),
    accessPolicy: portFor<AccessPolicyPort>(plan, instances, "platform.access-policy"),
    operations: portFor<OperationsFactory>(plan, instances, "platform.operations"),
    observability: portFor<ObservabilityPort>(plan, instances, "platform.observability"),
    moduleAdmin: portFor<ModuleAdminPort>(plan, instances, "platform.module-admin"),
    save: savePort.save,
    binder,
    contributors,
  };
}
