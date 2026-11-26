/**
 * 核心职责：定义世界模块的游戏端口与角色、队伍、群体、指标、campaign、委托的视图类型。
 * 交互契约：依赖公共契约的领域值、资源量、原因码与协议计数；视图由世界端口查询返回。
 * 约束与禁忌：禁止在这里实现规则、读取存储或让端口绕过世界模块的聚合所有权。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 接口参数名表达调用契约；Codacy 缺少 workspace 类型解析时会把泛型联合误判为 any。 */
import type {
  CityResourceAmounts,
  MeterChangeCause,
  NumericMeterId,
  ReasonCode,
  ResourceAmounts,
  TaskType,
  WatergateAllocation,
} from "@ai-npc/contracts";
import type { AgreementCounts } from "./game-agreements-port";

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
  /** t168 评估时写入的六种城市资源；序章未结束时为 null。 */
  readonly cityResources: CityResourceAmounts | null;
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

/** 世界端口；campaign、指标、角色、队伍、群体、委托与证据位置由世界模块拥有。 */
export interface GameWorldPort {
  /**
   * 一个章节的长度（tick），取自当前装配的世界模块配置。
   * 剧情发布窗口与协议期限等「一个章节内」的判断一律读这里，
   * 不再各自内联常量，否则装配改成非默认长度时只有部分规则跟随。
   */
  chapterLengthTicks(): number;
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
