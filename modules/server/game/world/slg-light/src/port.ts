/**
 * 实现世界模块的 campaign/指标/角色/队伍/群体/委托/证据查询与受控写操作。
 * 依赖内容初始值、世界聚合状态、指标阈值与注入的 scoped WorldTx。
 * 禁止写入地图或库存聚合，也禁止在失败操作中留下部分状态变化。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { MeterChange, MeterChangeCause, NumericMeterId, ReasonCode, ResourceAmounts, WatergateAllocation } from "@ai-npc/contracts";
import {
  addAmounts,
  factionAudience,
  gameModuleIds,
  principalsAudience,
  subtractAmounts,
  totalAmount,
  type CampaignView,
  type CharacterView,
  type DelegationView,
  type DelegationAllocation,
  type DrawAuthority,
  type GameContent,
  type GameIdFactory,
  type GameWorldPort,
  type GroupView,
  type MetersView,
  type ScopedWorldTxFactory,
  type TeamView,
} from "@ai-npc/module-sdk";
import { clampMeter, thresholdEvents } from "./meters";
import {
  campaignStateSchema,
  characterStateSchema,
  delegationStateSchema,
  evidencePlacementStateSchema,
  groupStateSchema,
  metersStateSchema,
  readWorldState,
  teamStateSchema,
  type CharacterState,
  type DelegationState,
  type EvidencePlacementState,
  type GroupState,
  type MetersState,
  type TeamState,
} from "./state";

/** 世界聚合的固定 ID；campaign 与 meters 每个分支各一条。 */
export const campaignAggregateId = "campaign";
export const metersAggregateId = "meters";

type OpFailure = { readonly ok: false; readonly reasonCode: ReasonCode };
type OpSuccess = { readonly ok: true };

function failure(reasonCode: ReasonCode): OpFailure {
  return { ok: false, reasonCode };
}

function compareDelegations(left: DelegationState, right: DelegationState): number {
  if (left.delegationId < right.delegationId) {
    return -1;
  }
  return left.delegationId > right.delegationId ? 1 : 0;
}

interface PlannedDelegationDraw {
  readonly delegation: DelegationState;
  readonly amount: ResourceAmounts;
}

function planDelegationDraws(
  candidates: readonly DelegationState[],
  delta: ResourceAmounts,
): readonly PlannedDelegationDraw[] | null {
  let remainingNeed = delta;
  const draws: PlannedDelegationDraw[] = [];
  for (const delegation of candidates) {
    const amount: ResourceAmounts = {
      supply: Math.min(delegation.remaining.supply, remainingNeed.supply),
      energy: Math.min(delegation.remaining.energy, remainingNeed.energy),
      medical: Math.min(delegation.remaining.medical, remainingNeed.medical),
    };
    if (totalAmount(amount) === 0) {
      continue;
    }
    draws.push({ delegation, amount });
    remainingNeed = subtractAmounts(remainingNeed, amount);
    if (totalAmount(remainingNeed) === 0) {
      return draws;
    }
  }
  return null;
}

function viewOfMeters(state: MetersState): MetersView {
  return {
    "relay.stability": state["relay.stability"],
    "orchard.water": state["orchard.water"],
    "migration.safety": state["migration.safety"],
    "watergate.allocation": state["watergate.allocation"],
  };
}

function meterValue(view: MetersView, meter: NumericMeterId): number {
  switch (meter) {
    case "relay.stability":
      return view["relay.stability"];
    case "orchard.water":
      return view["orchard.water"];
    case "migration.safety":
      return view["migration.safety"];
  }
}

function setMeter(view: MetersView, meter: NumericMeterId, value: number): MetersView {
  switch (meter) {
    case "relay.stability":
      return { ...view, "relay.stability": value };
    case "orchard.water":
      return { ...view, "orchard.water": value };
    case "migration.safety":
      return { ...view, "migration.safety": value };
  }
}

/** 世界端口实现；每个处理器调用构造一次，绑定同一 storage transaction。 */
class SlgWorldPort implements GameWorldPort {
  private readonly txFor: ScopedWorldTxFactory;
  private readonly content: GameContent;
  private readonly ids: GameIdFactory;

  constructor(txFor: ScopedWorldTxFactory, content: GameContent, ids: GameIdFactory) {
    this.txFor = txFor;
    this.content = content;
    this.ids = ids;
  }

  private tx() {
    return this.txFor(gameModuleIds.world);
  }

  campaign(): CampaignView | null {
    const record = readWorldState(this.tx(), "campaign", campaignAggregateId, campaignStateSchema);
    return record?.state ?? null;
  }

  meters(): MetersView | null {
    const record = readWorldState(this.tx(), "meters", metersAggregateId, metersStateSchema);
    return record === null ? null : viewOfMeters(record.state);
  }

  character(agentId: string): CharacterView | null {
    return readWorldState(this.tx(), "character", agentId, characterStateSchema)?.state ?? null;
  }

  team(teamId: string): TeamView | null {
    return readWorldState(this.tx(), "team", teamId, teamStateSchema)?.state ?? null;
  }

  group(groupId: string): GroupView | null {
    return readWorldState(this.tx(), "group", groupId, groupStateSchema)?.state ?? null;
  }

  characters(): readonly CharacterView[] {
    return this.tx()
      .list<CharacterState>("character")
      .map((entry) => entry.state);
  }

  teams(): readonly TeamView[] {
    return this.tx().list<TeamState>("team").map((entry) => entry.state);
  }

  groups(): readonly GroupView[] {
    return this.tx().list<GroupState>("group").map((entry) => entry.state);
  }

  delegationsOf(principalId: string): readonly DelegationView[] {
    return this.tx()
      .list<DelegationState>("delegation")
      .filter((entry) => entry.state.granteeId === principalId)
      .sort((left, right) => compareDelegations(left.state, right.state))
      .map((entry) => ({
        delegationId: entry.state.delegationId,
        grantorFactionId: entry.state.grantorFactionId,
        granteeId: entry.state.granteeId,
        teamIds: entry.state.teamIds,
        stockpileId: entry.state.stockpileId,
        remaining: entry.state.remaining,
        untilTick: entry.state.untilTick,
      }));
  }

  principalFaction(principalId: string): string | null {
    if (this.content.factions.has(principalId)) {
      return principalId;
    }
    const character = this.content.characters.get(principalId);
    if (character !== undefined) {
      return character.factionId;
    }
    const campaign = this.campaign();
    if (campaign !== null && campaign.playerId === principalId) {
      return campaign.factionId;
    }
    return null;
  }

  canDispatchTeam(principalId: string, teamId: string): boolean {
    const team = this.team(teamId);
    if (team === null) {
      return false;
    }
    if (this.isStrategicPrincipal(principalId) && this.principalFaction(principalId) === team.ownerFactionId) {
      return true;
    }
    return this.tx()
      .list<DelegationState>("delegation")
      .some(
        (entry) =>
          entry.state.granteeId === principalId &&
          entry.state.teamIds.includes(teamId) &&
          entry.state.untilTick >= this.tx().worldTick,
      );
  }

  private isStrategicPrincipal(principalId: string): boolean {
    return this.content.factions.has(principalId);
  }

  drawAuthority(principalId: string, stockpileId: string): DrawAuthority {
    const stockpile = this.content.stockpiles.get(stockpileId);
    if (stockpile === undefined) {
      return { kind: "none" };
    }
    if (
      this.isStrategicPrincipal(principalId) &&
      this.principalFaction(principalId) === stockpile.ownerFactionId
    ) {
      return { kind: "owner", factionId: stockpile.ownerFactionId };
    }
    const delegations = this.findDelegations(principalId, stockpileId).map((entry) => entry.state);
    if (delegations.length === 0) {
      return { kind: "none" };
    }
    const first = delegations[0] as DelegationState;
    return {
      kind: "delegation",
      delegationId: first.delegationId,
      remaining: delegations.reduce(
        (remaining, delegation) => addAmounts(remaining, delegation.remaining),
        { supply: 0, energy: 0, medical: 0 },
      ),
      untilTick: Math.min(...delegations.map((delegation) => delegation.untilTick)),
    };
  }

  /** 查找覆盖该库存点的有效委托；stockpileId 为 null 的仅队伍委托不提供动用权。 */
  private findDelegations(principalId: string, stockpileId: string): readonly {
    readonly state: DelegationState;
  }[] {
    return this.tx()
      .list<DelegationState>("delegation")
      .filter(
        (entry) =>
          entry.state.granteeId === principalId &&
          entry.state.stockpileId !== null &&
          entry.state.stockpileId === stockpileId &&
          entry.state.untilTick >= this.tx().worldTick,
      )
      .sort((left, right) => compareDelegations(left.state, right.state));
  }

  moveCharacter(agentId: string, nodeId: string): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "character", agentId, characterStateSchema);
    if (record === null || !this.content.nodes.has(nodeId)) {
      return failure("invalid-params");
    }
    if (record.state.nodeId === nodeId) {
      return { ok: true };
    }
    this.tx().put("character", agentId, { ...record.state, nodeId });
    this.tx().emit(
      "CharacterMoved",
      { id: agentId, fromNodeId: record.state.nodeId, toNodeId: nodeId },
      [{ kind: "public" }],
    );
    return { ok: true };
  }

  moveTeam(teamId: string, nodeId: string): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "team", teamId, teamStateSchema);
    if (record === null || !this.content.nodes.has(nodeId)) {
      return failure("invalid-params");
    }
    if (record.state.nodeId === nodeId) {
      return { ok: true };
    }
    this.tx().put("team", teamId, { ...record.state, nodeId });
    this.tx().emit("TeamMoved", { id: teamId, fromNodeId: record.state.nodeId, toNodeId: nodeId }, [
      { kind: "public" },
    ]);
    return { ok: true };
  }

  setTeamStatus(
    teamId: string,
    status: TeamState["status"],
    busyUntilTick: number | null,
    taskId: string | null,
  ): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "team", teamId, teamStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    this.tx().put("team", teamId, { ...record.state, status, busyUntilTick, currentTaskId: taskId });
    if (status === "recovering" && busyUntilTick !== null) {
      this.tx().schedule("team.recover", busyUntilTick, `team-recover:${teamId}:${busyUntilTick}`, { teamId });
    }
    return { ok: true };
  }

  setCharacterTask(agentId: string, taskId: string | null): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "character", agentId, characterStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    this.tx().put("character", agentId, { ...record.state, currentTaskId: taskId });
    return { ok: true };
  }

  injureCharacter(agentId: string, untilTick: number, cause: string): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "character", agentId, characterStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    const nextUntil = Math.max(untilTick, record.state.injuredUntilTick ?? 0);
    this.tx().put("character", agentId, { ...record.state, injuredUntilTick: nextUntil });
    this.tx().emit(
      "CharacterInjured",
      { agentId, untilTick: nextUntil, cause },
      [
        ...principalsAudience([agentId]),
        factionAudience(record.state.factionId),
        { kind: "node", nodeId: record.state.nodeId },
      ],
    );
    this.tx().schedule("character.recover", nextUntil, `character-recover:${agentId}:${nextUntil}`, { agentId });
    return { ok: true };
  }

  setGroupStatus(groupId: string, status: GroupState["status"], taskId: string | null, injured?: number, nodeId?: string): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "group", groupId, groupStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    this.tx().put("group", groupId, {
      ...record.state,
      status,
      currentTaskId: taskId,
      ...(injured === undefined ? {} : { injured }),
      ...(nodeId === undefined ? {} : { nodeId }),
    });
    return { ok: true };
  }

  claimGroup(groupId: string, taskId: string): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "group", groupId, groupStateSchema);
    if (record === null || record.state.status === "rescued" || record.state.currentTaskId !== null) {
      return failure("participant-unavailable");
    }
    this.tx().put("group", groupId, { ...record.state, currentTaskId: taskId });
    return { ok: true };
  }

  releaseGroup(groupId: string, taskId: string): void {
    const record = readWorldState(this.tx(), "group", groupId, groupStateSchema);
    if (record !== null && record.state.currentTaskId === taskId) {
      this.tx().put("group", groupId, { ...record.state, currentTaskId: null });
    }
  }

  drawDelegation(
    principalId: string,
    stockpileId: string,
    delta: ResourceAmounts,
  ): { readonly ok: true; readonly delegationId: string; readonly allocations: readonly DelegationAllocation[] } | OpFailure {
    const candidates = this.findDelegations(principalId, stockpileId).map((entry) => entry.state);
    if (candidates.length === 0) {
      return failure("draw-limit-exceeded");
    }
    const first = candidates[0] as DelegationState;
    if (totalAmount(delta) === 0) {
      return { ok: true, delegationId: first.delegationId, allocations: [] };
    }
    const plannedDraws = planDelegationDraws(candidates, delta);
    if (plannedDraws === null || plannedDraws.length === 0) {
      return failure("draw-limit-exceeded");
    }
    for (const draw of plannedDraws) {
      this.tx().put("delegation", draw.delegation.delegationId, {
        ...draw.delegation,
        remaining: subtractAmounts(draw.delegation.remaining, draw.amount),
      });
    }
    const allocations: readonly DelegationAllocation[] = plannedDraws.map((draw) => ({
      delegationId: draw.delegation.delegationId,
      amount: draw.amount,
    }));
    const firstAllocation = allocations[0];
    if (firstAllocation === undefined) {
      return failure("draw-limit-exceeded");
    }
    // 保留稳定的单委托 ID 字段供兼容调用；回补方使用 allocations 逐笔处理所有已扣减委托。
    return { ok: true, delegationId: firstAllocation.delegationId, allocations };
  }

  refundDelegation(delegationId: string, delta: ResourceAmounts): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "delegation", delegationId, delegationStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    const delegation = record.state;
    const next = addAmounts(delegation.remaining, delta);
    this.tx().put("delegation", delegation.delegationId, {
      ...delegation,
      remaining: {
        supply: Math.min(next.supply, delegation.limit.supply),
        energy: Math.min(next.energy, delegation.limit.energy),
        medical: Math.min(next.medical, delegation.limit.medical),
      },
    });
    return { ok: true };
  }

  createDelegation(spec: {
    readonly grantorFactionId: string;
    readonly granteeId: string;
    readonly teamIds: readonly string[];
    readonly stockpileId: string | null;
    readonly maxDraw: ResourceAmounts;
    readonly untilTick: number;
  }): { readonly ok: true; readonly delegationId: string } {
    const delegationId = this.ids("del");
    const state: DelegationState = {
      delegationId,
      grantorFactionId: spec.grantorFactionId,
      granteeId: spec.granteeId,
      teamIds: [...spec.teamIds],
      stockpileId: spec.stockpileId,
      remaining: spec.maxDraw,
      limit: spec.maxDraw,
      untilTick: spec.untilTick,
    };
    this.tx().put("delegation", delegationId, state);
    this.tx().emit(
      "DelegationCreated",
      {
        delegationId,
        grantorFactionId: spec.grantorFactionId,
        granteeId: spec.granteeId,
        teamIds: [...spec.teamIds],
        stockpileId: spec.stockpileId,
        maxDraw: spec.maxDraw,
        untilTick: spec.untilTick,
      },
      [...principalsAudience([spec.granteeId]), factionAudience(spec.grantorFactionId)],
    );
    return { ok: true, delegationId };
  }

  changeMeter(meter: NumericMeterId, delta: number, cause: MeterChangeCause): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "meters", metersAggregateId, metersStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    const state = record.state;
    const previous = viewOfMeters(state);
    const previousValue = meterValue(previous, meter);
    const next = setMeter(previous, meter, clampMeter(previousValue + delta));
    const nextValue = meterValue(next, meter);
    const change: MeterChange | null =
      previousValue === nextValue ? null : { meter, from: previousValue, to: nextValue, cause };
    const threshold = thresholdEvents(previous, next, new Set(state.triggered));
    const triggered = [...state.triggered, ...threshold.added];
    this.tx().put("meters", metersAggregateId, { ...state, ...next, triggered });
    if (change !== null) {
      this.tx().emit("MetersChanged", { changes: [change] }, [{ kind: "public" }]);
    }
    for (const event of threshold.events) {
      this.tx().emit(event.type, { value: event.value }, [{ kind: "public" }]);
    }
    return { ok: true };
  }

  setAllocation(allocation: WatergateAllocation, byId: string): OpSuccess | OpFailure {
    const record = readWorldState(this.tx(), "meters", metersAggregateId, metersStateSchema);
    if (record === null) {
      return failure("invalid-params");
    }
    const oldValue = record.state["watergate.allocation"];
    if (oldValue === allocation) {
      return failure("no-change");
    }
    this.tx().put("meters", metersAggregateId, { ...record.state, "watergate.allocation": allocation });
    this.tx().emit(
      "PolicyChanged",
      { key: "watergate.allocation", oldValue, newValue: allocation, byId },
      [{ kind: "public" }],
    );
    return { ok: true };
  }

  discoverEvidence(input: {
    readonly evidenceId: string;
    readonly discoveredBy: string;
    readonly taskId: string;
  }): OpSuccess | OpFailure {
    const evidence = this.content.evidence.get(input.evidenceId);
    if (evidence === undefined || evidence.discoverable !== true) {
      return failure("invalid-params");
    }
    const record = readWorldState(
      this.tx(),
      "evidence-placement",
      input.evidenceId,
      evidencePlacementStateSchema,
    );
    const placement: EvidencePlacementState = record?.state ?? {
      evidenceId: input.evidenceId,
      nodeId: evidence.nodeId ?? null,
      discoveredBy: null,
    };
    if (placement.discoveredBy !== null) {
      return failure("no-change");
    }
    this.tx().put("evidence-placement", input.evidenceId, {
      ...placement,
      discoveredBy: input.discoveredBy,
    });
    this.tx().emit(
      "EvidenceDiscovered",
      { evidenceId: input.evidenceId, discoveredBy: input.discoveredBy, taskId: input.taskId },
      [...principalsAudience([input.discoveredBy])],
    );
    return { ok: true };
  }
}

/** 构造绑定到当前事务的世界端口。 */
export function createWorldPort(
  txFor: ScopedWorldTxFactory,
  content: GameContent,
  ids: GameIdFactory,
): GameWorldPort {
  return new SlgWorldPort(txFor, content, ids);
}

/** 判断资源量是否超过队伍容量，供行动模块与规则测试复用。 */
export function cargoExceedsCapacity(cargo: ResourceAmounts, capacity: number): boolean {
  return totalAmount(cargo) > capacity;
}
