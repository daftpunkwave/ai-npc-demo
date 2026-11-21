/**
 * 通过游戏模块公开端口构造感知位置及决策所需的授权事实。
 * 事务和输入时钟由调用方提供，任务状态只针对 Agent 已收到的邀请读取。
 * 不给策略暴露全量游戏状态、其他主体的记忆或秘密正文。
 */
import type { AgentWorldRead, ReadTurnWorld } from "@ai-npc/agent-runtime";
import type { StoragePort } from "@ai-npc/contracts";
import type { GameContent, GameWorldPort } from "@ai-npc/module-sdk";
import type { LiveRunState } from "./live-state";
import type { HostReadPorts } from "./reads";

function readIdentity(content: GameContent, world: GameWorldPort, agentId: string) {
  const character = world.character(agentId);
  const faction = content.factions.get(agentId);
  return {
    character,
    factionId: character?.factionId ?? faction?.factionId ?? content.characters.get(agentId)?.factionId ?? agentId,
    nodeId: character?.nodeId ?? faction?.factionHomeNodeId ?? faction?.territoryNodeId ?? null,
  };
}

export function agentWorldReaders(input: {
  readonly storage: StoragePort;
  readonly reads: HostReadPorts;
  readonly content: GameContent;
  readonly scope: Pick<LiveRunState, "branchId" | "worldId">;
}): { readonly perception: (agentId: string) => AgentWorldRead; readonly decision: ReadTurnWorld } {
  const { storage, reads, content, scope } = input;
  const principalIds = [...new Set([content.playerPrincipalId, ...content.factions.keys(), ...content.characters.keys()])];
  return {
    perception: (agentId) => storage.transact((tx) => {
      const identity = readIdentity(content, reads.portsIn(tx, scope)["game.world"], agentId);
      return { nodeId: identity.nodeId, factionId: identity.factionId, worldViewText: "", affairsText: "" };
    }),
    decision: (tx, session, frontier, invitedTaskIds) => {
      const ports = reads.portsIn(tx, session);
      const world = ports["game.world"];
      const comms = ports["game.comms"];
      const { agentId } = session;
      const identity = readIdentity(content, world, agentId);
      const knowledge = new Map<string, ReadonlySet<string>>();
      const principalFactions = new Map<string, string>();
      for (const id of principalIds) {
        const factionId = world.principalFaction(id);
        if (factionId !== null) principalFactions.set(id, factionId);
        knowledge.set(id, new Set(comms.knowledgeOf(id)
          .filter(({ grantedAtTick }) => grantedAtTick <= frontier.worldTick).map(({ itemId }) => itemId)));
      }
      const taskInvitations = invitedTaskIds.flatMap((taskId) => {
        const task = ports["game.actions"].task(taskId);
        if (task === null || !task.invitees.includes(agentId) || task.status !== "pending") return [];
        return [{ taskId, dispatcherId: task.dispatcherId, highRiskRoute: task.route.some((id) => content.roads.get(id)?.risk === 2) }];
      });
      return {
        nodeId: identity.nodeId,
        injured: (identity.character?.injuredUntilTick ?? 0) > frontier.worldTick,
        delegations: world.delegationsOf(agentId).filter(({ untilTick }) => untilTick >= frontier.worldTick),
        knowledge, principalFactions, taskInvitations,
      };
    },
  };
}
