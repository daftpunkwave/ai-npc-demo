/**
 * 服务端组合根：显式登记全部 server 模块定义、游戏端口与规则贡献。
 * 应用组合根只允许本文件引用模块包；其他 host 文件只经此入口取用。
 * 禁止在这里启动服务、打开存储或执行命令。
 */
import type { GameContent, GameModulePorts, ModuleBinder, ScopedWorldTxFactory } from "@ai-npc/module-sdk";
import type { GameRuleContributor } from "@ai-npc/module-sdk";
import type { HostServices, StoragePort } from "@ai-npc/contracts";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { clockModuleDefinition } from "@ai-npc/mod-game-clock-controlled";
import { createMapPort, mapModuleDefinition, createMapContributor } from "@ai-npc/mod-game-map-six-nodes";
import { createResourcesPort, resourcesModuleDefinition, createResourcesContributor } from "@ai-npc/mod-game-resources-light";
import { createWorldPort, worldModuleDefinition, createWorldContributor } from "@ai-npc/mod-game-world-slg-light";
import { createCommsPort, commsModuleDefinition, createCommsContributor } from "@ai-npc/mod-game-comms-standard";
import { createActionsPort, actionsModuleDefinition, createActionsContributor } from "@ai-npc/mod-game-actions-standard";
import { createAgreementsPort, agreementsModuleDefinition, createAgreementsContributor } from "@ai-npc/mod-game-agreements-standard";
import { createScenarioPort, scenarioModuleDefinition, escalatingScenarioModuleDefinition, createScenarioContributor } from "@ai-npc/mod-game-scenario-watergate";
import { saveModuleDefinition, SqliteSaveService } from "@ai-npc/mod-game-save-sqlite";
import { accessPolicyModuleDefinition } from "@ai-npc/mod-platform-access-policy-roster";
import { secretsModuleDefinition } from "@ai-npc/mod-platform-secrets-env";
import { operationsModuleDefinition, OperationsService, type OperationsDriver } from "@ai-npc/mod-platform-operations-standard";
import { transportModuleDefinition, transportConfigSchema, type TransportConfig, type TransportPort } from "@ai-npc/mod-transport-http-ws-fastify";

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
export { transportModuleDefinition };

/** 绑定全部游戏端口；txFor 由 authority/宿主事务提供。 */
export function createGamePorts(txFor: ScopedWorldTxFactory, content: GameContent, host: HostServices): GameModulePorts {
  return {
    "game.map": createMapPort(txFor, content, (prefix) => host.ids(prefix)),
    "game.resources": createResourcesPort(txFor, { scarceRatio: 0.3, surplusRatio: 1.2 }),
    "game.world": createWorldPort(txFor, content, (prefix) => host.ids(prefix)),
    "game.comms": createCommsPort(txFor, content, (prefix) => host.ids(prefix)),
    "game.actions": createActionsPort(txFor),
    "game.agreements": createAgreementsPort(txFor),
    "game.scenario": createScenarioPort(txFor),
  };
}

export function createModuleBinder(content: GameContent, host: HostServices): ModuleBinder {
  return (txFor) => createGamePorts(txFor, content, host);
}

/** 创建存档领域服务；宿主只经组合根引用具体实现。 */
export function createSaveService(storage: StoragePort, host: HostServices): SqliteSaveService {
  return new SqliteSaveService(storage, host);
}

/** 首版服务端规则贡献列表；escalating 由装配选择替换标准剧情。 */
export function createGameContributors(options: { readonly escalating?: boolean } = {}): readonly GameRuleContributor<GameModulePorts, unknown>[] {
  return [
    createMapContributor(),
    createResourcesContributor(),
    createWorldContributor(),
    createCommsContributor(),
    createActionsContributor(),
    createAgreementsContributor(),
    createScenarioContributor({ escalating: options.escalating === true }),
  ];
}

/** 全部 server 模块定义；moduleId 唯一性由 check-catalog 校验。 */
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
