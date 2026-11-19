/**
 * 创建标准协议模块实例；没有后台任务，端口由宿主按事务绑定。
 * 依赖无状态生命周期骨架、规则贡献、端口工厂与组合根已绑定的只读查询端口。
 * 禁止在 create 阶段读取内容、创建协议或订阅事件。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import {
  createStatelessModule,
  type AgreementQueryPorts,
  type GameContent,
  type GameIdFactory,
  type GameModulePorts,
  type GamePortBindContext,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { createAgreementsContributor } from "./contributor";
import { createAgreementsPort } from "./port";

/** 从组合根已绑定的端口取协议统计事实；缺失说明依赖顺序或装配错误，直接失败。 */
function queryPortsOf(context: GamePortBindContext): AgreementQueryPorts {
  const ports: Readonly<Partial<GameModulePorts>> = context.ports;
  const actions = ports["game.actions"];
  const comms = ports["game.comms"];
  const world = ports["game.world"];
  const map = ports["game.map"];
  if (actions === undefined || comms === undefined || world === undefined || map === undefined) {
    throw new Error("协议模块缺少已声明的 game.actions、game.comms、game.world 或 game.map 端口");
  }
  return { actions, comms, world, map };
}

/** 协议模块实例的公开端口同时暴露事务绑定器与规则贡献。 */
export function createAgreementsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, {
    bind: (
      txFor: ScopedWorldTxFactory,
      _content: GameContent,
      _ids: GameIdFactory,
      context: GamePortBindContext,
    ) => createAgreementsPort(() => txFor(input.moduleId), queryPortsOf(context)),
    contributor: createAgreementsContributor(),
  });
}
