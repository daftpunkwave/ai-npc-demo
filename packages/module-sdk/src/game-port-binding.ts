/**
 * 核心职责：定义游戏端口的模块 ID 常量、端口集合、能力登记表、绑定上下文与跨端口组合视图。
 * 交互契约：依赖本包事务端口、公共契约与全部游戏端口类型；组合根按能力解析并注入端口快照。
 * 约束与禁忌：禁止在这里实现端口行为；模块不得借端口快照读取其他模块的聚合。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 接口参数名表达调用契约；Codacy 缺少 workspace 类型解析时会把泛型联合误判为 any。 */
import type { IdPrefix } from "@world-prism/contracts";
import type { WorldTx } from "./ports";
import type { GameActionsPort } from "./game-actions-port";
import type { GameAgreementsPort } from "./game-agreements-port";
import type { GameCommsPort } from "./game-comms-port";
import type { GameMapPort } from "./game-map-port";
import type { GameResourcesPort } from "./game-resources-port";
import type { GameScenarioPort } from "./game-scenario-port";
import type { GameWorldPort } from "./game-world-port";

/** 只取调用模块自己作用域事务的工厂；模块端口不得借它读取或改写其他模块的聚合。 */
export type OwnWorldTxFactory = () => WorldTx;

/** 宿主 ID 生成器的游戏端口视图；参数为契约登记的 ID 前缀。 */
export type GameIdFactory = (...args: [IdPrefix]) => string;

/** 首版游戏模块的稳定模块 ID；端口实现与装配共享同一组常量。 */
export const gameModuleIds = {
  world: "game.world.slg-light",
  map: "game.map.six-nodes",
  clock: "game.clock.controlled",
  resources: "game.resources.light",
  actions: "game.actions.standard",
  agreements: "game.agreements.standard",
  comms: "game.comms.standard",
  scenario: "game.scenario.watergate",
  scenarioEscalating: "game.scenario.watergate-escalating",
  save: "game.save.sqlite",
} as const;

/** 游戏模块绑定的全部端口；宿主按能力解析后注入处理器上下文。 */
export interface GameModulePorts {
  readonly "game.map": GameMapPort;
  readonly "game.resources": GameResourcesPort;
  readonly "game.world": GameWorldPort;
  readonly "game.actions": GameActionsPort;
  readonly "game.agreements": GameAgreementsPort;
  readonly "game.scenario": GameScenarioPort;
  readonly "game.comms": GameCommsPort;
}

/**
 * 游戏端口能力到占位值的登记表；`Record<keyof GameModulePorts, true>` 保证与端口类型逐一对应，
 * 新增游戏端口却忘记登记时会编译失败。
 */
const gamePortCapabilityRegistry = {
  "game.map": true,
  "game.resources": true,
  "game.world": true,
  "game.actions": true,
  "game.agreements": true,
  "game.scenario": true,
  "game.comms": true,
} as const satisfies Record<keyof GameModulePorts, true>;

/** 组合根按能力绑定的游戏端口全集；绑定器用它在运行时筛选每个处理器可见的端口。 */
export const gamePortCapabilities = Object.keys(gamePortCapabilityRegistry) as readonly GamePortCapability[];

/** 已绑定的游戏能力名。 */
export type GamePortCapability = keyof typeof gamePortCapabilityRegistry;

/**
 * 组合根绑定模块端口时提供的依赖端口视图与调用方身份。
 * ports 是按本次绑定新建的冻结记录，只含该模块 requires 声明的游戏能力；端口实例本身绑定当前事务、
 * 在各模块间共享。需要按调用方收窄可见能力时由绑定器另行包一层代理，本类型不负责访问控制。
 * 调用方身份供需要校验触发来源的端口区分宿主、特定职责 provider 与一般消费者。
 * 绑定器按依赖顺序构造端口，模块不得借依赖端口读取对方聚合。
 */
export interface GamePortBindContext {
  readonly ports: Readonly<Partial<GameModulePorts>>;
  /** 请求该端口视图的处理器的所有者模块；null 表示宿主自身。 */
  readonly callerModuleId: string | null;
  /** 请求方模块提供的能力；宿主自身为空数组。 */
  readonly callerProvides: readonly string[];
}

/**
 * 协议统计读取的其他模块只读事实：已完成任务、证据分享、世界指标/队伍/campaign 与道路状态。
 * 由组合根按已声明能力注入；协议端口不再按实现 ID 读取对方私有聚合。
 */
export interface AgreementQueryPorts {
  readonly actions: Pick<GameActionsPort, "completedTasks">;
  readonly comms: Pick<GameCommsPort, "hasShare">;
  readonly world: Pick<GameWorldPort, "meters" | "teams" | "campaign">;
  readonly map: Pick<GameMapPort, "roadStatus">;
}
