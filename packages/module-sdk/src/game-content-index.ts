/**
 * 核心职责：定义规则模块读取内容索引所需的只读视图；各实体视图由公共契约的内容类型派生，不另写字段。
 * 交互契约：依赖公共契约的内容包类型与城市资源量，以及世界端口文件的指标视图；
 * 内容 schema 新增或修改字段后，视图随之变化，不需要在本文件同步声明。
 * 约束与禁忌：禁止在这里复制内容字段、实现规则或修改内容包数据；只剔除规则模块不应读取的 Agent 认知字段。
 */
import type {
  CityResourceAmounts,
  ContentCard,
  ContentCharacter,
  ContentDutyDelegation,
  ContentEvidenceEntry,
  ContentFaction,
  ContentGroup,
  ContentLocale,
  ContentNode,
  ContentRoad,
  ContentRules,
  ContentScenario,
  ContentSecret,
  ContentStart,
  ContentStockpile,
  ContentTeam,
} from "@world-prism/contracts";
import type { MetersView } from "./game-world-port";

/** 数组字段收窄为只读数组；对可选字段按联合成员逐个处理。 */
type ReadonlyArrayField<Value> = Value extends readonly (infer Item)[] ? readonly Item[] : Value;

/**
 * 规则模块看到的内容实体：字段与数组字段只读。内容对象由加载器创建后在各模块间共享，
 * 模块不能改写；嵌套的公共契约值（如剧情卡效果）保持原类型，以便直接交给按契约类型声明的函数。
 */
type ContentView<Entity> = { readonly [Key in keyof Entity]: ReadonlyArrayField<Entity[Key]> };

export type GameNode = ContentView<ContentNode>;

/** 道路视图；受控属性来自静态内容。 */
export type GameRoad = ContentView<ContentRoad>;

/** 派系视图；人格与初始信任关系属于 Agent 认知输入，规则模块不读取。 */
export type GameFaction = ContentView<Omit<ContentFaction, "persona" | "relations">>;

/** 角色视图；秘密、说话风格、底线、目标与初始关系属于 Agent 认知输入，规则模块不读取。 */
export type GameCharacter = ContentView<
  Omit<ContentCharacter, "characterId" | "secret" | "speechStyle" | "bottomLines" | "goals" | "initialRelations">
>;

export type GameStockpileInit = ContentView<ContentStockpile>;

export type GameTeamInit = ContentView<ContentTeam>;

export type GameGroupInit = ContentView<ContentGroup>;

export type GameDutyDelegation = ContentView<ContentDutyDelegation>;

/** 派系开局配置；enabled 为 false 的开局保留数据完整性校验但不进入 campaign.start。 */
export type GameStart = ContentView<ContentStart>;

/** 可发现证据的初始位置与正文。 */
export type GameEvidencePlacement = ContentView<ContentEvidenceEntry>;

/** 私有秘密；只有持有者获得知识授权。 */
export type GameSecret = ContentView<ContentSecret>;

export type GameScenarioCard = ContentView<ContentCard>;

/** 剧情视图：广播发布节点、可选压力卡、只作署名的人物名单与剧情卡。 */
export type GameScenario = ContentView<Omit<ContentScenario, "schemaVersion">>;

/** 章节规则的任务岗位参数：本派支持者、通用主体与修复工作节点。 */
export type GameTaskRules = ContentView<ContentRules["tasks"]>;

/** 章节规则的日结目标：供给与医疗库存、数量与迁徙道路判定主体。 */
export type GameSettlementRules = ContentView<ContentRules["settlement"]>;

/** 章节规则参数；规则层只消费描述符，不写具体内容 ID。 */
export type GameRules = ContentView<Omit<ContentRules, "schemaVersion">>;

/** 投影派生提醒的文案来源；deadline 中的 {window} 由使用方以到期窗口替换。 */
export type GameNotificationTexts = ContentView<ContentLocale["notifications"]>;

/**
 * 规则模块读取内容索引所需的只读视图。各集合只要求 ReadonlyMap 能力，不要求是 Map 实例；
 * 内容包适配器直接传入内容索引的映射，其他实现也可以提供自己的 ReadonlyMap。
 */
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
  /** t168 交接时纳入城市总量的六种资源初值；旧内容包可能没有该项。 */
  readonly cityResources?: CityResourceAmounts;
}
