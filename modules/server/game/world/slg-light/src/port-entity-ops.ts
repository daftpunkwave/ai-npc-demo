/**
 * 核心职责：实现世界端口的实体写操作：移动、任务指派、伤势、群体状态与恢复调度。
 * 交互契约：依赖内容索引校验节点存在性与注入的 scoped WorldTx；事件受众按世界事实圈定。
 * 约束与禁忌：禁止写入地图或库存聚合，失败操作不得留下部分状态变化。
 */
import {
  factionAudience,
  gameModuleIds,
  principalsAudience,
  type GameContent,
  type GameWorldPort,
  type ScopedWorldTxFactory,
} from "@world-prism/module-sdk";
import { failure, type OpFailure, type OpSuccess } from "./port-result";
import {
  characterStateSchema,
  groupStateSchema,
  readWorldState,
  teamStateSchema,
  type GroupState,
  type TeamState,
} from "./state";

/** 世界端口实体写操作的依赖：调用方作用域事务工厂与内容索引。 */
export interface WorldEntityOpsDeps {
  readonly txFor: ScopedWorldTxFactory;
  readonly content: GameContent;
}

export function createWorldEntityOps({ txFor, content }: WorldEntityOpsDeps): Pick<
  GameWorldPort,
  | "moveCharacter"
  | "moveTeam"
  | "setTeamStatus"
  | "setCharacterTask"
  | "injureCharacter"
  | "setGroupStatus"
  | "claimGroup"
  | "releaseGroup"
> {
  const tx = () => txFor(gameModuleIds.world);
  return {
    moveCharacter(agentId: string, nodeId: string): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "character", agentId, characterStateSchema);
      if (record === null || !content.nodes.has(nodeId)) {
        return failure("invalid-params");
      }
      if (record.state.nodeId === nodeId) {
        return { ok: true };
      }
      tx().put("character", agentId, { ...record.state, nodeId });
      tx().emit(
        "CharacterMoved",
        { id: agentId, fromNodeId: record.state.nodeId, toNodeId: nodeId },
        [{ kind: "public" }],
      );
      return { ok: true };
    },

    moveTeam(teamId: string, nodeId: string): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "team", teamId, teamStateSchema);
      if (record === null || !content.nodes.has(nodeId)) {
        return failure("invalid-params");
      }
      if (record.state.nodeId === nodeId) {
        return { ok: true };
      }
      tx().put("team", teamId, { ...record.state, nodeId });
      tx().emit("TeamMoved", { id: teamId, fromNodeId: record.state.nodeId, toNodeId: nodeId }, [
        { kind: "public" },
      ]);
      return { ok: true };
    },

    setTeamStatus(
      teamId: string,
      status: TeamState["status"],
      busyUntilTick: number | null,
      taskId: string | null,
    ): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "team", teamId, teamStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      tx().put("team", teamId, { ...record.state, status, busyUntilTick, currentTaskId: taskId });
      if (status === "recovering" && busyUntilTick !== null) {
        tx().schedule("team.recover", busyUntilTick, `team-recover:${teamId}:${busyUntilTick}`, { teamId });
      }
      return { ok: true };
    },

    setCharacterTask(agentId: string, taskId: string | null): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "character", agentId, characterStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      tx().put("character", agentId, { ...record.state, currentTaskId: taskId });
      return { ok: true };
    },

    injureCharacter(agentId: string, untilTick: number, cause: string): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "character", agentId, characterStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      const nextUntil = Math.max(untilTick, record.state.injuredUntilTick ?? 0);
      tx().put("character", agentId, { ...record.state, injuredUntilTick: nextUntil });
      tx().emit(
        "CharacterInjured",
        { agentId, untilTick: nextUntil, cause },
        [
          ...principalsAudience([agentId]),
          factionAudience(record.state.factionId),
          { kind: "node", nodeId: record.state.nodeId },
        ],
      );
      tx().schedule("character.recover", nextUntil, `character-recover:${agentId}:${nextUntil}`, { agentId });
      return { ok: true };
    },

    setGroupStatus(groupId: string, status: GroupState["status"], taskId: string | null, injured?: number, nodeId?: string): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "group", groupId, groupStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      tx().put("group", groupId, {
        ...record.state,
        status,
        currentTaskId: taskId,
        ...(injured === undefined ? {} : { injured }),
        ...(nodeId === undefined ? {} : { nodeId }),
      });
      return { ok: true };
    },

    claimGroup(groupId: string, taskId: string): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "group", groupId, groupStateSchema);
      if (record === null || record.state.status === "rescued" || record.state.currentTaskId !== null) {
        return failure("participant-unavailable");
      }
      tx().put("group", groupId, { ...record.state, currentTaskId: taskId });
      return { ok: true };
    },

    releaseGroup(groupId: string, taskId: string): void {
      const record = readWorldState(tx(), "group", groupId, groupStateSchema);
      if (record !== null && record.state.currentTaskId === taskId) {
        tx().put("group", groupId, { ...record.state, currentTaskId: null });
      }
    },
  };
}
