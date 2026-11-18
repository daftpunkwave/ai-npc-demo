/**
 * 定义服务端游戏模块之间共享的查询与操作端口，以及模块绑定的内容索引视图。
 * 依赖公共契约的领域值、资源量与原因码；端口方法在调用方事务内同步执行。
 * 禁止在这里实现规则、读取存储或让端口绕过所属模块的聚合所有权。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 接口参数名表达调用契约；Codacy 缺少 workspace 类型解析时会把泛型联合误判为 any。 */
import type {
  MessageIntentKind,
  MeterChangeCause,
  NumericMeterId,
  ReasonCode,
  ResourceAmounts,
  ResourceDelta,
  ResourceId,
  RoadStatus,
  TaskStatus,
  TaskType,
  WatergateAllocation,
} from "@ai-npc/contracts";

/** 宿主 ID 生成器的游戏端口视图；参数为 ID 前缀。 */
export type GameIdFactory = (...args: [string]) => string;

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
  readonly homeNodeId: string;
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

/** 资源展示等级。 */
export type ResourceLevel = "scarce" | "adequate" | "surplus";

/** 库存点快照。 */
export interface StockpileView {
  readonly stockpileId: string;
  readonly nodeId: string;
  readonly ownerFactionId: string;
  readonly amount: ResourceAmounts;
  readonly reserved: ResourceAmounts;
  readonly baseline: ResourceAmounts;
}

/** 委托余额视图；owner 表示由派系战略 Agent 直接动用。 */
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

/** 委托快照；remaining 是各资源的剩余可动用额度。 */
export interface DelegationView {
  readonly delegationId: string;
  readonly grantorFactionId: string;
  readonly granteeId: string;
  readonly teamIds: readonly string[];
  readonly stockpileId: string;
  readonly remaining: ResourceAmounts;
  readonly untilTick: number;
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
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  drawDelegation(
    principalId: string,
    stockpileId: string,
    delta: ResourceAmounts,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  refundDelegation(
    principalId: string,
    stockpileId: string,
    delta: ResourceAmounts,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  createDelegation(spec: {
    readonly grantorFactionId: string;
    readonly granteeId: string;
    readonly teamIds: readonly string[];
    readonly stockpileId: string;
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
  discoverEvidence(input: {
    readonly evidenceId: string;
    readonly discoveredBy: string;
    readonly taskId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
}

/** 任务查询端口；任务聚合由行动模块拥有。 */
export interface TaskView {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly teamId: string;
  readonly dispatcherId: string;
  readonly participants: readonly string[];
  readonly status: TaskStatus;
  readonly params: unknown;
  readonly completedAtTick: number | null;
}

/** 协议查询端口；条款状态由协议模块拥有。 */
export interface AgreementView {
  readonly agreementId: string;
  readonly status: "proposed" | "active" | "fulfilled" | "rejected" | "superseded" | "expired" | "breached";
  readonly parties: readonly string[];
}

/** 通信端口：送达计算、知识授权与剧情/对白写入。 */
export interface CommsPostResult {
  readonly eventId: string;
  readonly deliveries: readonly { readonly principalId: string; readonly deliverAtTick: number }[];
}

export interface GameCommsPort {
  relayState(): "normal" | "degraded" | "down";
  deliverAt(channel: "dialogue" | "message" | "broadcast", fromId: string, toId: string): number | "relay-down";
  holds(principalId: string, itemId: string): boolean;
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

/** 游戏模块绑定的全部端口；宿主按能力解析后注入处理器上下文。 */
export interface GameModulePorts {
  readonly "game.map": GameMapPort;
  readonly "game.resources": GameResourcesPort;
  readonly "game.world": GameWorldPort;
  readonly "game.actions": { task(taskId: string): TaskView | null; tasksOf(principalId: string): readonly TaskView[] };
  readonly "game.agreements": {
    agreement(agreementId: string): AgreementView | null;
    agreementsOf(principalId: string): readonly AgreementView[];
  };
  readonly "game.comms": GameCommsPort;
}

/** 可空的操作结果；成功时允许携带结果数据。 */
export type GameOpResult<T extends Record<string, unknown> = Record<never, never>> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reasonCode: ReasonCode };
