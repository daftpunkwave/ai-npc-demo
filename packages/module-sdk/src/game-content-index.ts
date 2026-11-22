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
  readonly cards: readonly GameScenarioCard[];
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
  readonly migrationRoads: readonly string[];
  readonly medicalFacilities: readonly string[];
  readonly playerNodeId: string;
  readonly playerPrincipalId: string;
  readonly chapterId: string;
  readonly initialMeters: MetersView;
  readonly dutyDelegations: readonly GameDutyDelegation[];
}
