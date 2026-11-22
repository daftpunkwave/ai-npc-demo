/**
 * 核心职责：实现世界端口的查询操作：campaign、指标、角色、队伍、群体、委托与主体动用权判定。
 * 交互契约：依赖内容初始值、注入的 scoped WorldTx 与指标视图转换；委托查找供委托操作复用。
 * 约束与禁忌：只读世界聚合，不写状态；禁止读取地图或库存模块的聚合。
 */
import {
  addAmounts,
  gameModuleIds,
  type CampaignView,
  type CharacterView,
  type DelegationView,
  type DrawAuthority,
  type GameContent,
  type GroupView,
  type MetersView,
  type ScopedWorldTxFactory,
  type TeamView,
} from "@ai-npc/module-sdk";
import { viewOfMeters } from "./port-meter-ops";
import { campaignAggregateId, metersAggregateId } from "./port-aggregates";
import {
  campaignStateSchema,
  characterStateSchema,
  delegationStateSchema,
  groupStateSchema,
  metersStateSchema,
  readWorldState,
  teamStateSchema,
  type CharacterState,
  type DelegationState,
  type GroupState,
  type TeamState,
} from "./state";

/** 世界端口的查询片段；findDelegations 供委托扣减与回补定位复用，不属于公开端口。 */
export interface WorldQueries {
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
  /** 查找覆盖该库存点的有效委托；stockpileId 为 null 的仅队伍委托不提供动用权。 */
  findDelegations(principalId: string, stockpileId: string): readonly {
    readonly state: DelegationState;
  }[];
}

function compareDelegations(left: DelegationState, right: DelegationState): number {
  if (left.delegationId < right.delegationId) {
    return -1;
  }
  return left.delegationId > right.delegationId ? 1 : 0;
}

/** 世界端口查询操作的依赖：调用方作用域事务工厂与内容索引。 */
export interface WorldQueriesDeps {
  readonly txFor: ScopedWorldTxFactory;
  readonly content: GameContent;
}

export function createWorldQueries({ txFor, content }: WorldQueriesDeps): WorldQueries {
  const tx = () => txFor(gameModuleIds.world);

  const campaign = (): CampaignView | null => {
    const record = readWorldState(tx(), "campaign", campaignAggregateId, campaignStateSchema);
    return record?.state ?? null;
  };

  const character = (agentId: string): CharacterView | null =>
    readWorldState(tx(), "character", agentId, characterStateSchema)?.state ?? null;

  const team = (teamId: string): TeamView | null =>
    readWorldState(tx(), "team", teamId, teamStateSchema)?.state ?? null;

  const isStrategicPrincipal = (principalId: string): boolean => content.factions.has(principalId);

  const principalFaction = (principalId: string): string | null => {
    if (content.factions.has(principalId)) {
      return principalId;
    }
    const characterDefinition = content.characters.get(principalId);
    if (characterDefinition !== undefined) {
      return characterDefinition.factionId;
    }
    const campaignState = campaign();
    if (campaignState !== null && campaignState.playerId === principalId) {
      return campaignState.factionId;
    }
    return null;
  };

  const findDelegations = (principalId: string, stockpileId: string): readonly {
    readonly state: DelegationState;
  }[] =>
    tx()
      .list<DelegationState>("delegation")
      .filter(
        (entry) =>
          entry.state.granteeId === principalId &&
          entry.state.stockpileId !== null &&
          entry.state.stockpileId === stockpileId &&
          entry.state.untilTick >= tx().worldTick,
      )
      .sort((left, right) => compareDelegations(left.state, right.state));

  return {
    campaign,

    meters(): MetersView | null {
      const record = readWorldState(tx(), "meters", metersAggregateId, metersStateSchema);
      return record === null ? null : viewOfMeters(record.state);
    },

    character,

    team,

    group(groupId: string): GroupView | null {
      return readWorldState(tx(), "group", groupId, groupStateSchema)?.state ?? null;
    },

    characters(): readonly CharacterView[] {
      return tx()
        .list<CharacterState>("character")
        .map((entry) => entry.state);
    },

    teams(): readonly TeamView[] {
      return tx().list<TeamState>("team").map((entry) => entry.state);
    },

    groups(): readonly GroupView[] {
      return tx().list<GroupState>("group").map((entry) => entry.state);
    },

    delegationsOf(principalId: string): readonly DelegationView[] {
      return tx()
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
    },

    principalFaction,

    canDispatchTeam(principalId: string, teamId: string): boolean {
      const teamState = team(teamId);
      if (teamState === null) {
        return false;
      }
      if (isStrategicPrincipal(principalId) && principalFaction(principalId) === teamState.ownerFactionId) {
        return true;
      }
      return tx()
        .list<DelegationState>("delegation")
        .some(
          (entry) =>
            entry.state.granteeId === principalId &&
            entry.state.teamIds.includes(teamId) &&
            entry.state.untilTick >= tx().worldTick,
        );
    },

    drawAuthority(principalId: string, stockpileId: string): DrawAuthority {
      const stockpile = content.stockpiles.get(stockpileId);
      if (stockpile === undefined) {
        return { kind: "none" };
      }
      if (
        isStrategicPrincipal(principalId) &&
        principalFaction(principalId) === stockpile.ownerFactionId
      ) {
        return { kind: "owner", factionId: stockpile.ownerFactionId };
      }
      const delegations = findDelegations(principalId, stockpileId).map((entry) => entry.state);
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
    },

    findDelegations,
  };
}
