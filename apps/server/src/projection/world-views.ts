/**
 * 核心职责：从世界端口与内容索引构建队伍与角色的玩家可见视图。
 * 交互契约：依赖内容索引、世界端口与委托视图；内容包没有角色定义的人类 AI 党魁由派系驻地补位。
 * 约束与禁忌：禁止暴露委托之外的队伍内部状态或角色的私有事实。
 */
import type { CharacterView, TeamView } from "@ai-npc/contracts";
import { factionStandingNode } from "@ai-npc/module-sdk";
import type { GameContent, GameWorldPort } from "@ai-npc/module-sdk";

/** 队伍：位置、所属与状态公开；仍有效的玩家委托覆盖的队伍标 delegatedToMe。 */
export function teamViews(input: {
  readonly world: GameWorldPort;
  readonly delegations: ReturnType<GameWorldPort["delegationsOf"]>;
  readonly tick: number;
}): TeamView[] {
  const delegatedTeamIds = new Set<string>();
  for (const delegation of input.delegations) {
    if (delegation.untilTick < input.tick) {
      continue;
    }
    for (const teamId of delegation.teamIds) {
      delegatedTeamIds.add(teamId);
    }
  }
  return input.world
    .teams()
    .map((team) => ({
      teamId: team.teamId,
      nodeId: team.nodeId,
      ownerFactionId: team.ownerFactionId,
      status: team.status,
      delegatedToMe: delegatedTeamIds.has(team.teamId),
    }))
    .sort((left, right) => left.teamId.localeCompare(right.teamId));
}

/** 角色：世界状态提供位置与伤势，内容索引提供名称、派系、职责与公开主张。 */
export function characterViews(input: {
  readonly content: GameContent;
  readonly world: GameWorldPort;
  readonly tick: number;
}): CharacterView[] {
  const views: CharacterView[] = [];
  const present = new Set<string>();
  for (const state of input.world.characters()) {
    const definition = input.content.characters.get(state.agentId);
    if (definition === undefined) {
      continue;
    }
    views.push({
      agentId: state.agentId,
      name: definition.name,
      factionId: definition.factionId,
      role: definition.role,
      nodeId: state.nodeId,
      injured: state.injuredUntilTick !== null && state.injuredUntilTick > input.tick,
      injuredUntilTick: state.injuredUntilTick,
      publicClaim: definition.values[0] ?? null,
    });
    present.add(state.agentId);
  }
  if (input.world.campaign() !== null) {
    for (const faction of input.content.factions.values()) {
      // 有角色定义的主体只从世界状态取位置；内容包驻地只补无角色定义的人类 AI 党魁。
      if (
        present.has(faction.factionId) ||
        input.content.characters.has(faction.factionId) ||
        faction.leaderName === undefined
      ) {
        continue;
      }
      const presentation = faction as typeof faction & {
        readonly playerSeat?: string;
        readonly persona?: {
          readonly role?: string;
          readonly values?: readonly string[];
        };
      };
      if (presentation.playerSeat !== undefined) {
        continue;
      }
      // 内容包没有角色定义的人类 AI 党魁用派系驻地补位，与通信的位置口径共用同一纯函数。
      const nodeId = factionStandingNode(faction);
      if (nodeId === undefined) {
        continue;
      }
      views.push({
        agentId: faction.factionId as CharacterView["agentId"],
        name: faction.leaderName,
        factionId: faction.factionId,
        role: presentation.persona?.role ?? `${faction.name}党魁`,
        nodeId: nodeId as CharacterView["nodeId"],
        injured: false,
        injuredUntilTick: null,
        publicClaim: presentation.persona?.values?.[0] ?? null,
      });
    }
  }
  return views.sort((left, right) => left.agentId.localeCompare(right.agentId));
}
