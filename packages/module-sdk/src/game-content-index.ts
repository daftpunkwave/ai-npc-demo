/**
 * 核心职责：定义规则模块读取内容索引所需的最小只读视图与各实体的内容视图类型。
 * 交互契约：依赖公共契约的领域值、资源量与道路状态，以及世界端口文件的指标视图。
 * 约束与禁忌：实际内容包实现提供同构数据；禁止在这里实现规则或修改内容包数据。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type {
  CardEffect,
  ResourceAmounts,
  RoadStatus,
  TaskType,
} from "@ai-npc/contracts";
import type { MetersView } from "./game-world-port";

/** 内容索引中节点视图的最小结构。 */
export interface GameNode {
  readonly nodeId: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly facilities: readonly string[];
}

/** 内容索引中道路视图的最小结构；受控属性来自静态内容。 */
export interface GameRoad {
  readonly roadId: string;
  readonly a: string;
  readonly b: string;
  readonly travelTicks: number;
  readonly risk: number;
  readonly controlledBy?: string;
  readonly initialStatus?: RoadStatus;
}

/** 内容索引中派系视图的最小结构。 */
export interface GameFaction {
  readonly factionId: string;
  readonly name: string;
  readonly kind: "human" | "species";
  /** 人类派系的党部驻地；外域没有城内党部。 */
  readonly factionHomeNodeId?: string;
  /** 人类派系的前哨驻地。 */
  readonly outpostNodeId?: string;
  /** 外域派系的领地节点。 */
  readonly territoryNodeId?: string;
  readonly leaderCharacterId?: string;
  readonly leaderName?: string;
  /** 派系持有的玩家席位（如公社席）；由章节规则参数决定席位的权限语义。 */
  readonly playerSeat?: string;
}

/** 内容索引中角色视图的最小结构。 */
export interface GameCharacter {
  readonly agentId: string;
  readonly name: string;
  readonly factionId: string;
  readonly role: string;
  readonly spawnNodeId: string;
  readonly skills: readonly string[];
  readonly permissions?: readonly "broadcast"[];
  readonly values: readonly string[];
}

/** 内容索引中库存点初始值。 */
export interface GameStockpileInit {
  readonly stockpileId: string;
  readonly nodeId: string;
  readonly ownerFactionId: string;
  readonly supply: number;
  readonly energy: number;
  readonly medical: number;
}

/** 内容索引中队伍初始值。 */
export interface GameTeamInit {
  readonly teamId: string;
  readonly ownerFactionId: string;
  readonly nodeId: string;
  readonly capabilities: readonly TaskType[];
  readonly capacity: number;
}

/** 内容索引中群体初始值。 */
export interface GameGroupInit {
  readonly groupId: string;
  readonly nodeId: string;
  readonly injured: number;
  readonly deadlineTick: number;
}

/** 内容索引中的职责委托。 */
export interface GameDutyDelegation {
  readonly granteeId: string;
  readonly grantorFactionId: string;
  readonly teamIds: readonly string[];
  readonly stockpileId: string;
  readonly maxDraw: ResourceAmounts;
  readonly untilTick: number;
}

/** 内容索引中的派系开局配置。 */
export interface GameStart {
  readonly factionId: string;
  /** 只影响玩家可选开局；false 的开局保留数据完整性校验但不进入 campaign.start。 */
  readonly enabled?: boolean;
  readonly contacts: readonly string[];
  readonly commission: string;
  readonly playerDelegation: {
    readonly teamIds: readonly string[];
    readonly stockpileId: string;
    readonly maxDraw: ResourceAmounts;
    readonly untilTick: number;
  };
  readonly knowledge: readonly string[];
  readonly messages: readonly { readonly from: string; readonly text: string }[];
}

/** 内容索引中可发现证据的初始位置。 */
export interface GameEvidencePlacement {
  readonly evidenceId: string;
  readonly title: string;
  readonly nodeId?: string;
  readonly discoverable?: boolean;
  readonly heldBy?: readonly string[];
  readonly content: string;
  readonly tags: readonly string[];
}

/** 内容索引中的私有秘密；只有持有者获得知识授权。 */
export interface GameSecret {
  readonly secretId: string;
  readonly heldBy: readonly string[];
  readonly releasePolicy: "private";
  readonly content: string;
  readonly leakTerms: readonly string[];
}

export interface GameScenarioCard {
  readonly cardId: string;
  readonly version: number;
  readonly trigger: { readonly atTick: number };
  readonly effects: readonly CardEffect[];
}

export interface GameScenario {
  readonly scenarioId: string;
  /** 剧情卡广播的发布节点；与玩家当前位置无关。 */
  readonly broadcastOriginNodeId: string;
  /** 触发后启用每日剧情压力的卡片；缺省表示本章没有压力卡。 */
  readonly pressureCardId?: string;
  /** 只作事件署名、不实例化角色的具名人物名单。 */
  readonly signatureOnlyPrincipalIds: readonly string[];
  readonly cards: readonly GameScenarioCard[];
}

/** 章节规则的任务岗位参数：本派支持者、通用主体与修复工作节点。 */
export interface GameTaskRules {
  readonly capacitySupporter: { readonly agentId: string; readonly capacityBonus: number };
  readonly repairSupporter: { readonly agentId: string; readonly stabilityBonus: number };
  readonly rescueSupporter: { readonly agentId: string; readonly durationDiscountTicks: number };
  readonly scoutSupporter: { readonly agentId: string; readonly travelDiscountPerRoad: number };
  readonly escortSupporter: { readonly agentId: string; readonly safetyBonus: number };
  readonly universalGuide: { readonly agentId: string; readonly travelDiscountPerRoad: number };
  readonly universalRepairer: {
    readonly agentId: string;
    readonly stabilityBonus: number;
    readonly excludedTeamIds: readonly string[];
  };
  readonly repairWorkNodeId: string;
  readonly energyOnlyRepairTeamIds: readonly string[];
  readonly repairBaseStability: { readonly standard: number; readonly energyOnly: number };
}

/** 章节规则的日结目标：供给与医疗库存、数量与迁徙道路判定主体。 */
export interface GameSettlementRules {
  readonly dailySupplyStockpileId: string;
  readonly dailySupplyAmount: number;
  readonly orchardMedicalStockpileId: string;
  readonly orchardMedicalAmount: number;
  readonly migrationRoadId: string;
  readonly migrationPassageFactionId: string;
}

/** 章节规则参数；规则层只消费描述符，不写具体内容 ID。 */
export interface GameRules {
  readonly tasks: GameTaskRules;
  readonly settlement: GameSettlementRules;
  /** 公社席：持有该席位的派系主体控制水闸分配并拥有公开广播权。 */
  readonly watergateSeatId: string;
}

/** 投影派生提醒的文案来源；deadline 中的 {window} 由使用方以到期窗口替换。 */
export interface GameNotificationTexts {
  readonly invite: string;
  readonly deadline: string;
  readonly failedTask: string;
  readonly crisis: string;
}

/** 规则模块读取内容索引所需的最小只读视图；实际内容包实现提供同构数据。 */
export interface GameContent {
  readonly nodes: ReadonlyMap<string, GameNode>;
  readonly roads: ReadonlyMap<string, GameRoad>;
  readonly factions: ReadonlyMap<string, GameFaction>;
  readonly characters: ReadonlyMap<string, GameCharacter>;
  readonly stockpiles: ReadonlyMap<string, GameStockpileInit>;
  readonly teams: ReadonlyMap<string, GameTeamInit>;
  readonly groups: ReadonlyMap<string, GameGroupInit>;
  readonly evidence: ReadonlyMap<string, GameEvidencePlacement>;
  readonly secrets: ReadonlyMap<string, GameSecret>;
  readonly starts: ReadonlyMap<string, GameStart>;
  readonly scenarios: ReadonlyMap<string, GameScenario>;
  readonly defaultScenario: string;
  /** 章节规则参数：任务岗位、日结目标与公社席；规则层据此消费，不写具体内容 ID。 */
  readonly rules: GameRules;
  /** 投影派生提醒的文案。 */
  readonly notificationTexts: GameNotificationTexts;
  readonly migrationRoads: readonly string[];
  readonly medicalFacilities: readonly string[];
  readonly playerNodeId: string;
  readonly playerPrincipalId: string;
  readonly chapterId: string;
  readonly initialMeters: MetersView;
  readonly dutyDelegations: readonly GameDutyDelegation[];
}
