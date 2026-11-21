/**
 * 定义服务端游戏模块之间共享的查询与操作端口，以及模块绑定的内容索引视图。
 * 依赖公共契约的领域值、资源量与原因码，以及本包的事务端口类型；端口方法在调用方事务内同步执行。
 * 禁止在这里实现规则、读取存储或让端口绕过所属模块的聚合所有权。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 接口参数名表达调用契约；Codacy 缺少 workspace 类型解析时会把泛型联合误判为 any。 */
import type {
  CardEffect,
  IdPrefix,
  MessageIntentKind,
  MeterChangeCause,
  NumericMeterId,
  ReasonCode,
  ResourceAmounts,
  ResourceDelta,
  ResourceId,
  ResourceLevel,
  RoadStatus,
  ScenarioCardStatus,
  StorageTransaction,
  TaskStatus,
  TaskType,
  Term,
  WatergateAllocation,
} from "@ai-npc/contracts";
import type { WorldTx } from "./ports";

export type { ResourceLevel, ScenarioCardStatus };

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

/** 时钟读数；runVersion 用作控制接口的乐观版本。 */
export interface ClockState {
  readonly worldTick: number;
  readonly mode: "running" | "pausing" | "paused" | "resuming" | "stepping";
  readonly secondsPerTick: number;
  readonly runVersion: number;
  readonly stepTargetTick: number | null;
}

/** 时钟控制端口；面向宿主 API，不属于规则事务内的写入路径。 */
export interface GameClockPort {
  read(branchId: string): ClockState;
  /**
   * 在调用方已打开的事务内读取时钟；宿主投影与规则事务用同一快照，避免嵌套事务。
   * 端口只读该事务，不提交、不回滚，也不缓存结果。
   */
  readInTransaction(tx: StorageTransaction, branchId: string): ClockState;
  /**
   * 在调用方事务内为一个新分支写入初始时钟行（0 tick、暂停、版本 0），
   * 秒数取自 provider 自己的有效配置；已有时钟行时拒绝覆盖。
   */
  initializeInTransaction(tx: StorageTransaction, branchId: string): ClockState;
  start(branchId: string, expectedRunVersion?: number): { readonly ok: true; readonly clock: ClockState } | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };
  pause(branchId: string, expectedRunVersion?: number): { readonly ok: true; readonly clock: ClockState } | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };
  step(
    branchId: string,
    ticks: number,
    expectedRunVersion?: number,
  ): { readonly ok: true; readonly clock: ClockState } | { readonly ok: false; readonly reasonCode: "version-conflict" | "invalid-params" };
  finishStep(branchId: string): ClockState;
  setTick(branchId: string, tick: number): ClockState;
}

/** 一次路径查询的输入；withCargo 为真时每经过一条道路额外加 1 tick。 */
export interface RouteQuery {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly factionId: string;
  readonly atTick: number;
  readonly withCargo: boolean;
}

/** 一次可用路径的结果；道路按经过顺序排列。 */
export interface RouteResult {
  readonly roadIds: readonly string[];
  readonly travelTicks: number;
}

/** 资源展示等级；与公共契约的库存等级词表一致。 */
/** 库存点快照。 */
export interface StockpileView {
  readonly stockpileId: string;
  readonly nodeId: string;
  readonly ownerFactionId: string;
  readonly amount: ResourceAmounts;
  readonly reserved: ResourceAmounts;
  readonly baseline: ResourceAmounts;
}

/**
 * 委托动用权限视图；owner 表示派系战略主体直接动用。
 * 存在多份有效委托时，remaining 为按资源合计的余额，delegationId 取字典序首份，
 * untilTick 取这些委托中的最早到期 tick。
 */
export type DrawAuthority =
  | { readonly kind: "owner"; readonly factionId: string }
  | {
      readonly kind: "delegation";
      readonly delegationId: string;
      readonly remaining: ResourceAmounts;
      readonly untilTick: number;
    }
  | { readonly kind: "none" };

/** 角色世界状态。 */
export interface CharacterView {
  readonly agentId: string;
  readonly factionId: string;
  readonly nodeId: string;
  readonly injuredUntilTick: number | null;
  readonly currentTaskId: string | null;
}

/** 队伍世界状态。 */
export interface TeamView {
  readonly teamId: string;
  readonly ownerFactionId: string;
  readonly nodeId: string;
  readonly capabilities: readonly TaskType[];
  readonly capacity: number;
  readonly status: "idle" | "assigned" | "traveling" | "working" | "recovering";
  readonly busyUntilTick: number | null;
  readonly currentTaskId: string | null;
}

/** 群体世界状态。 */
export interface GroupView {
  readonly groupId: string;
  readonly nodeId: string;
  readonly injured: number;
  readonly deadlineTick: number;
  readonly status: "waiting" | "rescued" | "worsened";
  readonly currentTaskId: string | null;
}

/** 世界指标快照。 */
export interface MetersView {
  readonly "relay.stability": number;
  readonly "orchard.water": number;
  readonly "migration.safety": number;
  readonly "watergate.allocation": WatergateAllocation;
}

/** campaign 状态快照。 */
export interface CampaignView {
  readonly campaignId: string;
  readonly factionId: string;
  readonly playerId: string;
  readonly chapterId: string;
  readonly startTick: number;
  readonly status: "running" | "evaluated";
  readonly outcome: "equilibrium" | "strained" | null;
}

/** 委托快照；stockpileId 为 null 表示只委托队伍，remaining 是各资源的剩余可动用额度。 */
export interface DelegationView {
  readonly delegationId: string;
  readonly grantorFactionId: string;
  readonly granteeId: string;
  readonly teamIds: readonly string[];
  readonly stockpileId: string | null;
  readonly remaining: ResourceAmounts;
  readonly untilTick: number;
}

/** 一次跨多份委托扣减中，单份委托实际承担的资源数量。 */
export interface DelegationAllocation {
  readonly delegationId: string;
  readonly amount: ResourceAmounts;
}

/** 地图查询端口；所有读写都绑定到同一世界事务。 */
export interface GameMapPort {
  road(roadId: string): GameRoad | null;
  roadStatus(roadId: string): RoadStatus | null;
  findRoute(query: RouteQuery): RouteResult | null;
  hasPassage(roadId: string, factionId: string, atTick: number): boolean;
  setRoadStatus(
    roadId: string,
    status: RoadStatus,
    byId: string,
    force?: boolean,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  grantPassage(input: {
    readonly roadId: string;
    readonly granteeFactionId: string;
    readonly untilTick: number;
    readonly byId: string;
  }): { readonly ok: true; readonly grantId: string } | { readonly ok: false; readonly reasonCode: ReasonCode };
}

/** 资源端口；预留、扣减与转移都由资源模块写自己的库存聚合。 */
export interface GameResourcesPort {
  initializeCampaign(content: GameContent): void;
  stockpile(stockpileId: string): StockpileView | null;
  available(stockpileId: string, resource: ResourceId): number;
  level(stockpileId: string): Readonly<Record<ResourceId, ResourceLevel>>;
  reserve(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  release(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  consume(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly reason: string;
    readonly taskId: string | null;
    readonly byId: string;
    readonly fromReservation?: boolean;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  transfer(input: {
    readonly fromStockpileId: string;
    readonly toStockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  adjust(input: {
    readonly stockpileId: string;
    readonly delta: ResourceDelta;
    readonly reason: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
}

/** 世界端口；campaign、指标、角色、队伍、群体、委托与证据位置由世界模块拥有。 */
export interface GameWorldPort {
  campaign(): CampaignView | null;
  meters(): MetersView | null;
  character(agentId: string): CharacterView | null;
  team(teamId: string): TeamView | null;
  group(groupId: string): GroupView | null;
  characters(): readonly CharacterView[];
  teams(): readonly TeamView[];
  groups(): readonly GroupView[];
  delegationsOf(principalId: string): readonly DelegationView[];
  principalFaction(principalId: string): string | null;
  canDispatchTeam(principalId: string, teamId: string): boolean;
  drawAuthority(principalId: string, stockpileId: string): DrawAuthority;
  moveCharacter(agentId: string, nodeId: string): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  moveTeam(teamId: string, nodeId: string): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  setTeamStatus(
    teamId: string,
    status: "idle" | "assigned" | "traveling" | "working" | "recovering",
    busyUntilTick: number | null,
    taskId: string | null,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  setCharacterTask(
    agentId: string,
    taskId: string | null,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  injureCharacter(agentId: string, untilTick: number, cause: string): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  setGroupStatus(
    groupId: string,
    status: "waiting" | "rescued" | "worsened",
    taskId: string | null,
    injured?: number,
    nodeId?: string,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  claimGroup(groupId: string, taskId: string): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  releaseGroup(groupId: string, taskId: string): void;
  /**
   * 扣减覆盖该库存点的委托余额，并返回实际扣减的委托，供回补时按记录定位。
   * `allocations` 为新增可选能力：支持多份委托的实现返回每笔扣减，旧实现可只返回首份 ID。
   */
  drawDelegation(
    principalId: string,
    stockpileId: string,
    delta: ResourceAmounts,
  ):
    | {
        readonly ok: true;
        readonly delegationId: string;
        readonly allocations?: readonly DelegationAllocation[];
      }
    | { readonly ok: false; readonly reasonCode: ReasonCode };
  /** 按实际扣减过的委托 ID 回补余额；不得按主体与库存点重新查找委托。 */
  refundDelegation(
    delegationId: string,
    delta: ResourceAmounts,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  createDelegation(spec: {
    readonly grantorFactionId: string;
    readonly granteeId: string;
    readonly teamIds: readonly string[];
    readonly stockpileId: string | null;
    readonly maxDraw: ResourceAmounts;
    readonly untilTick: number;
  }): { readonly ok: true; readonly delegationId: string };
  changeMeter(
    meter: NumericMeterId,
    delta: number,
    cause: MeterChangeCause,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  setAllocation(
    allocation: WatergateAllocation,
    byId: string,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  /**
   * 在章节终点评估：按协议模块提供的截至当前 tick 的计数，写入 campaign 的 evaluated 状态并提交
   * `ChapterStageEvaluated`。未到章节长度或已成为 evaluated 时返回 undefined；评估成功后返回
   * `{ stopClock: true }` 供时钟步骤请求暂停。
   * 计数以惰性函数传入：只有确认到达评估时机后才遍历协议状态。
   * 实现方只允许协议 provider 的章节终点时钟步骤与宿主调用该操作，一般消费者调用立即失败。
   */
  evaluateChapter(counts: () => AgreementCounts): { readonly stopClock: true } | undefined;
  discoverEvidence(input: {
    readonly evidenceId: string;
    readonly discoveredBy: string;
    readonly taskId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
}

/**
 * 通信模块读取世界事实的最小只读视图：指标与角色位置。
 * 组合根注入已绑定的世界端口；通信模块不再按世界模块 ID 直接读取聚合。
 * 世界状态只记录有角色记录的主体位置；内容包没有角色定义的人类 AI 党魁由内容包派系驻地补足。
 */
export type CommsWorldFacts = Pick<GameWorldPort, "meters" | "character">;

/** 任务查询端口；任务聚合由行动模块拥有。 */
export interface TaskView {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly teamId: string;
  readonly dispatcherId: string;
  /** 受邀角色；受邀者在出发前用 task.respond 回复后才进入 participants。 */
  readonly invitees: readonly string[];
  readonly participants: readonly string[];
  readonly status: TaskStatus;
  readonly params: unknown;
  /** 出发时按路径算出的道路顺序；玩家投影只把「其他任务」的路线给到最小摘要。 */
  readonly route: readonly string[];
  readonly departTick: number;
  /** 不含延误的名义完成 tick；延误只进任务内部状态。 */
  readonly nominalCompletionTick: number;
  readonly completedAtTick: number | null;
  /** 是否已经为延误提交过 TaskDelayed；玩家投影据此显示延误提醒。 */
  readonly delayNoticeSent: boolean;
}

/** 行动模块查询端口；协议履约判定与剧情订阅复用已完成任务事实。 */
export interface GameActionsPort {
  task(taskId: string): TaskView | null;
  tasksOf(principalId: string): readonly TaskView[];
  isRoadEscorted(roadId: string, atTick: number): boolean;
  /**
   * 全部已完成任务，带权威完成 tick。
   * 协议期限 job 与章节统计用它复核「截至期限是否已履约」，不依赖消费者是否追平。
   */
  completedTasks(): readonly TaskView[];
}

/** 协议查询端口；条款状态由协议模块拥有。 */
export interface AgreementView {
  readonly agreementId: string;
  readonly version: number;
  readonly proposerId: string;
  readonly status: "proposed" | "active" | "fulfilled" | "rejected" | "superseded" | "expired" | "breached";
  readonly parties: readonly string[];
  readonly terms: readonly Term[];
  readonly createdAtTick: number;
  readonly expiresAtTick: number;
  readonly supersedesId: string | null;
  /** 已履约与已违约的条款下标；其余条款状态为 open。 */
  readonly fulfilledTerms: readonly number[];
  readonly breachedTerms: readonly number[];
  /** 与 terms 同下标的累计进度；没有进度概念的条款为 0。 */
  readonly progress: readonly number[];
}

/** 截至某个 tick 的协议计数；同一协议只计一次，供章节评估使用。 */
export interface AgreementCounts {
  readonly fulfilled: number;
  readonly breached: number;
}

/** 协议查询端口；协议聚合由协议模块拥有。 */
export interface GameAgreementsPort {
  agreement(agreementId: string): AgreementView | null;
  agreementsOf(principalId: string): readonly AgreementView[];
  activeAgreements(): readonly AgreementView[];
  /**
   * 按已提交事实同步统计截至 `tick` 的已履约与已违约协议数：有违约记录的计入 breached，
   * 全部条款（含期限复核）满足且无违约的计入 fulfilled，未生效或仍有未满足条款的不计。
   */
  countsAsOf(tick: number): AgreementCounts;
}

/** 剧情卡查询端口；具体卡状态由剧情模块拥有，词表与公共契约一致。 */
export interface ScenarioCardView {
  readonly cardId: string;
  readonly version: number;
  readonly status: ScenarioCardStatus;
  readonly triggerAtTick: number;
}

export interface GameScenarioPort {
  card(cardId: string): ScenarioCardView | null;
  cards(): readonly ScenarioCardView[];
}

/** 通信端口：送达计算、知识授权与剧情/对白写入。 */
export interface CommsPostResult {
  readonly eventId: string;
  readonly messageId: string | null;
  readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[];
}

/** 证据分享的一次查询；分享必须落在 [sinceTick, byTick] 内，早于协议生效的分享不构成履约。 */
export interface ShareQuery {
  readonly fromId: string;
  readonly evidenceId: string;
  readonly toPrincipalId: string;
  /** 协议生效 tick；早于它的分享不算履约。 */
  readonly sinceTick: number;
  /** 条款截止 tick；晚于它的分享不算履约。 */
  readonly byTick: number;
}

/** 通信日志的渠道；reported 是剧情卡下发的传闻，来源不是在地主体。 */
export type CommsMessageChannel = "message" | "broadcast" | "seat" | "opening" | "reported";

/** 一条已提交的通信日志；deliverAtTick 是该主体被冻结的送达 tick。 */
export interface CommsMessageView {
  readonly messageId: string;
  readonly fromId: string;
  readonly to: readonly string[];
  readonly channel: CommsMessageChannel;
  readonly text: string;
  readonly intentKind: MessageIntentKind;
  readonly committedAtTick: number;
  readonly deliverAtTick: number;
  readonly conversationId: string | null;
}

/** 一条已固化的对白；deliveries 是提交时冻结的逐主体送达 tick。 */
export interface CommsDialogueLineView {
  readonly seq: number;
  readonly dialogueId: string;
  readonly speakerId: string;
  readonly text: string;
  readonly channel: "face-to-face" | "relay";
  readonly worldTick: number;
  readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[];
}

/** 一条知识授权；itemId 指向内容包的证据或秘密。 */
export interface CommsKnowledgeView {
  readonly itemId: string;
  readonly via: "start" | "share" | "discovery" | "setup";
  readonly grantedAtTick: number;
}

export interface GameCommsPort {
  relayState(): "normal" | "degraded" | "down";
  /** 两个主体此刻是否在同一节点；位置未知的主体（未知主体、内容包有角色定义但世界状态缺少记录的主体）与任何人都不同节点。 */
  sameNode(fromId: string, toId: string): boolean;
  deliverAt(channel: "dialogue" | "message" | "broadcast", fromId: string, toId: string): number | "relay-down";
  holds(principalId: string, itemId: string): boolean;
  /** 已送达给该主体的通信日志：只含投递名单里有该主体且已到送达 tick 的记录，按送达 tick 升序取最近 limit 条。 */
  messagesFor(principalId: string, limit: number): readonly CommsMessageView[];
  /** 该主体参与的会话 ID，按 ID 升序。 */
  conversationsOf(principalId: string): readonly string[];
  /** 会话最近 limit 条对白，按 seq 升序。 */
  conversationMessages(conversationId: string, limit: number): readonly CommsDialogueLineView[];
  /** 该主体持有的知识授权，按授予 tick 与 itemId 升序。 */
  knowledgeOf(principalId: string): readonly CommsKnowledgeView[];
  /** 是否存在由 fromId 在 sinceTick 到 byTick 之间提交、受众包含 toPrincipalId 的证据分享。 */
  hasShare(query: ShareQuery): boolean;
  canJoinConversation(conversationId: string, principalIds: readonly string[]): boolean;
  grantKnowledge(input: {
    readonly principalId: string;
    readonly itemId: string;
    readonly via: "start" | "share" | "discovery" | "setup";
    readonly grantedAtTick?: number;
  }): { readonly grantId: string };
  postMessage(input: {
    readonly fromId: string;
    readonly to: readonly string[];
    readonly text: string;
    readonly channel: "message" | "broadcast" | "seat" | "opening";
    readonly intentKind: MessageIntentKind;
    readonly speechArtifactRef?: string | null;
    readonly audience?: readonly string[];
    /** 广播的发布位置；缺省用发送者当前位置，中继中断时只送达与该位置同节点的主体。 */
    readonly originNodeId?: string;
  }): CommsPostResult;
  postDialogue(input: {
    readonly speakerId: string;
    readonly audience: readonly string[];
    readonly text: string;
    readonly channel: "dialogue" | "message";
    readonly channelKind: "face-to-face" | "relay";
    readonly conversationId: string | null;
    readonly replyToId: string | null;
  }): { readonly eventId: string; readonly conversationId: string; readonly dialogueId: string; readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[] };
  postInformationShare(input: {
    readonly fromId: string;
    readonly evidenceId: string;
    readonly audience: readonly string[];
  }): CommsPostResult;
}

/**
 * 协议统计读取的其他模块只读事实：已完成任务、证据分享、世界指标/队伍与道路状态。
 * 由组合根按已声明能力注入；协议端口不再按实现 ID 读取对方私有聚合。
 */
export interface AgreementQueryPorts {
  readonly actions: Pick<GameActionsPort, "completedTasks">;
  readonly comms: Pick<GameCommsPort, "hasShare">;
  readonly world: Pick<GameWorldPort, "meters" | "teams">;
  readonly map: Pick<GameMapPort, "roadStatus">;
}

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
 * 组合根绑定模块端口时提供的已绑定端口快照与调用方身份。
 * 端口只包含该模块 provides 与 requires 声明的游戏能力，访问未声明的能力会立即失败；
 * 调用方身份供需要校验触发来源的端口区分宿主、特定职责 provider 与一般消费者。
 * 绑定器按依赖顺序构造端口，模块不得借端口快照读取对方聚合。
 */
export interface GamePortBindContext {
  readonly ports: Readonly<Partial<GameModulePorts>>;
  /** 请求该端口视图的处理器的所有者模块；null 表示宿主自身。 */
  readonly callerModuleId: string | null;
  /** 请求方模块提供的能力；宿主自身为空数组。 */
  readonly callerProvides: readonly string[];
}

/** 可空的操作结果；成功时允许携带结果数据。 */
export type GameOpResult<T extends Record<string, unknown> = Record<never, never>> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reasonCode: ReasonCode };
