/**
 * 创建标准协议模块实例；没有后台任务，端口由宿主按事务绑定。
 * 依赖无状态生命周期骨架、规则贡献、端口工厂、内容派系索引与组合根已绑定的只读查询端口。
 * 禁止在 create 阶段读取内容、创建协议或订阅事件。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import {
  createStatelessModule,
  type AgreementQueryPorts,
  type CampaignView,
  type GameContent,
  type GameIdFactory,
  type GameModulePorts,
  type GamePortBindContext,
  type GameWorldPort,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { createAgreementsContributor } from "./contributor";
import { resolvePrincipalFaction } from "./fulfillment";
import { createAgreementsPort } from "./port";

/**
 * 从组合根已绑定的端口取协议统计事实；缺失说明依赖顺序或装配错误，直接失败。
 * 同时返回世界端口，供主体派系映射读取当前 campaign。
 */
function queryPortsOf(context: GamePortBindContext): {
  readonly queries: AgreementQueryPorts;
  readonly world: GameWorldPort;
} {
  const ports: Readonly<Partial<GameModulePorts>> = context.ports;
  const actions = ports["game.actions"];
  const comms = ports["game.comms"];
  const world = ports["game.world"];
  const map = ports["game.map"];
  if (actions === undefined || comms === undefined || world === undefined || map === undefined) {
    throw new Error("协议模块缺少已声明的 game.actions、game.comms、game.world 或 game.map 端口");
  }
  return { queries: { actions, comms, world, map }, world };
}

/**
 * 构造绑定到单个事务的主体派系映射。campaign 在同一事务内是固定快照，
 * 读取一次即可供统计中的多次归属判断复用，避免按主体重复查询。
 */
function factionOfPrincipalOf(
  content: GameContent,
  world: GameWorldPort,
): (principalId: string) => string | null {
  let campaign: CampaignView | null | undefined;
  return (principalId) => {
    if (campaign === undefined) {
      campaign = world.campaign();
    }
    return resolvePrincipalFaction(principalId, content.factions, campaign);
  };
}

/** 协议模块实例的公开端口同时暴露事务绑定器与规则贡献。 */
export function createAgreementsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, {
    bind: (txFor: ScopedWorldTxFactory, content: GameContent, _ids: GameIdFactory, context: GamePortBindContext) => {
      const { queries, world } = queryPortsOf(context);
      return createAgreementsPort(
        () => txFor(input.moduleId),
        queries,
        factionOfPrincipalOf(content, world),
      );
    },
    contributor: createAgreementsContributor(),
  });
}
