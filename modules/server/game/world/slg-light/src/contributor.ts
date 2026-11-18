/**
 * 注册世界模块的命令、job、时钟步骤与事件消费者，并实现 campaign 初始化与政策命令。
 * 依赖世界端口、地图/资源端口、内容索引与 authority 的处理器上下文。
 * 禁止在这里直接写地图/库存聚合，或在命令处理器中读取进程时间与随机源。
 */
import type { EventEnvelope, Json } from "@ai-npc/contracts";
import { roadStatusSchema, watergateAllocationSchema } from "@ai-npc/contracts";
import {
  effectivePrincipalId,
  factionAudience,
  gameModuleIds,
  principalsAudience,
  requireGameContent,
  type GameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import { runChapterEvaluation, runDailySettlement } from "./settlement";
import { campaignAggregateId, metersAggregateId } from "./port";
import {
  characterStateSchema,
  chapterStatsStateSchema,
  readWorldState,
  teamStateSchema,
  type CampaignState,
  type ChapterStatsState,
  type CharacterState,
  type GroupState,
  type TeamState,
} from "./state";

type WorldContext = HandlerContext<GameModulePorts, unknown>;

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

function initializeCampaign(context: WorldContext, factionId: string): HandlerResult {
  const content = requireGameContent(context.content);
  const faction = content.factions.get(factionId);
  const start = content.starts.get(factionId);
  if (faction === undefined || faction.kind !== "human" || start === undefined) {
    return { kind: "rejected", reasonCode: "unknown-faction", safeMessage: "未知的人类派系开局" };
  }
  if (context.tx.get<unknown>("campaign", campaignAggregateId) !== null) {
    return { kind: "rejected", reasonCode: "campaign-exists", safeMessage: "当前分支已经存在 campaign" };
  }
  const campaignId = context.ids("cmp");
  const campaign: CampaignState = {
    campaignId,
    factionId,
    playerId: context.auth.principalId,
    chapterId: content.chapterId,
    startTick: context.tx.worldTick,
    status: "running",
    outcome: null,
  };
  context.tx.put("campaign", campaignAggregateId, campaign);
  context.tx.put("meters", metersAggregateId, {
    ...content.initialMeters,
    triggered: [],
    lastDailyTick: null,
  });

  for (const character of content.characters.values()) {
    const state: CharacterState = {
      agentId: character.agentId,
      factionId: character.factionId,
      nodeId: character.spawnNodeId,
      injuredUntilTick: null,
      currentTaskId: null,
    };
    context.tx.put("character", character.agentId, state);
  }
  for (const team of content.teams.values()) {
    const state: TeamState = {
      teamId: team.teamId,
      ownerFactionId: team.ownerFactionId,
      nodeId: team.nodeId,
      capabilities: [...team.capabilities],
      capacity: team.capacity,
      status: "idle",
      busyUntilTick: null,
      currentTaskId: null,
    };
    context.tx.put("team", team.teamId, state);
  }
  for (const group of content.groups.values()) {
    const state: GroupState = {
      groupId: group.groupId,
      nodeId: group.nodeId,
      injured: group.injured,
      deadlineTick: group.deadlineTick,
      status: "waiting",
      currentTaskId: null,
    };
    context.tx.put("group", group.groupId, state);
    context.tx.schedule("group.deadline", group.deadlineTick, `group-deadline:${group.groupId}`, {
      groupId: group.groupId,
    });
  }
  for (const evidence of content.evidence.values()) {
    context.tx.put("evidence-placement", evidence.evidenceId, {
      evidenceId: evidence.evidenceId,
      nodeId: evidence.nodeId ?? null,
      discoveredBy: null,
    });
  }
  context.tx.emit(
    "CampaignStarted",
    { campaignId, factionId, playerId: context.auth.principalId },
    [{ kind: "public" }],
  );

  const delegations = content.dutyDelegations.map((delegation) => ({
    grantorFactionId: delegation.grantorFactionId,
    granteeId: delegation.granteeId,
    teamIds: [...delegation.teamIds],
    stockpileId: delegation.stockpileId,
    maxDraw: delegation.maxDraw,
    untilTick: delegation.untilTick,
  }));
  delegations.push({
    grantorFactionId: factionId,
    granteeId: context.auth.principalId,
    teamIds: [...start.playerDelegation.teamIds],
    stockpileId: start.playerDelegation.stockpileId,
    maxDraw: start.playerDelegation.maxDraw,
    untilTick: start.playerDelegation.untilTick,
  });
  for (const delegation of delegations) {
    const delegationId = context.ids("del");
    context.tx.put("delegation", delegationId, {
      delegationId,
      grantorFactionId: delegation.grantorFactionId,
      granteeId: delegation.granteeId,
      teamIds: delegation.teamIds,
      stockpileId: delegation.stockpileId,
      remaining: delegation.maxDraw,
      limit: delegation.maxDraw,
      untilTick: delegation.untilTick,
    });
    context.tx.emit(
      "DelegationCreated",
      { delegationId, ...delegation },
      [...principalsAudience([delegation.granteeId]), factionAudience(delegation.grantorFactionId)],
    );
  }
  return { kind: "accepted", result: { campaignId } };
}

function policySet(context: WorldContext, payload: Json): HandlerResult {
  const input = payload as { readonly key: string; readonly value: string };
  const principalId = effectivePrincipalId(context.auth);
  const ports = asPorts(context);
  if (input.key === "watergate.allocation") {
    if (principalId !== "human-neutral") {
      return { kind: "rejected", reasonCode: "no-authority", safeMessage: "只有灰港公社可以修改水闸分配" };
    }
    const allocation = watergateAllocationSchema.safeParse(input.value);
    if (!allocation.success) {
      return { kind: "rejected", reasonCode: "unknown-policy", safeMessage: "未知的水闸分配值" };
    }
    const result = ports["game.world"].setAllocation(allocation.data, principalId);
    if (!result.ok) {
      return { kind: "rejected", reasonCode: result.reasonCode, safeMessage: "水闸分配未改变" };
    }
    return { kind: "accepted" };
  }
  if (input.key.startsWith("road.status:")) {
    const roadId = input.key.slice("road.status:".length);
    if (ports["game.map"].road(roadId) === null) {
      return { kind: "rejected", reasonCode: "unknown-policy", safeMessage: "道路不存在" };
    }
    const status = roadStatusSchema.safeParse(input.value);
    if (!status.success) {
      return { kind: "rejected", reasonCode: "unknown-policy", safeMessage: "未知的道路状态" };
    }
    const result = ports["game.map"].setRoadStatus(roadId, status.data, principalId);
    if (!result.ok) {
      return { kind: "rejected", reasonCode: result.reasonCode, safeMessage: "道路状态未改变" };
    }
    return { kind: "accepted" };
  }
  return { kind: "rejected", reasonCode: "unknown-policy", safeMessage: "未登记的政策键" };
}

/** 世界模块的规则贡献；handler 使用 context.modules 中已绑定到当前事务的端口。 */
export interface WorldContributorOptions {
  readonly chapterLengthTicks?: number;
}

export function createWorldContributor(options: WorldContributorOptions = {}): GameRuleContributor<GameModulePorts, unknown> {
  const chapterLengthTicks = options.chapterLengthTicks ?? 168;
  return {
    moduleId: gameModuleIds.world,
    ownsAggregates: [
      "campaign",
      "meters",
      "character",
      "team",
      "group",
      "delegation",
      "evidence-placement",
      "chapter-stats",
    ],
    commands: [
      {
        type: "campaign.start",
        handler: (context, payload) => {
          const input = payload as { readonly factionId: string };
          return initializeCampaign(context as WorldContext, input.factionId);
        },
      },
      {
        type: "policy.set",
        handler: (context, payload) => policySet(context as WorldContext, payload),
      },
    ],
    jobs: [
      {
        kind: "group.deadline",
        handler: (context, job) => {
          const { groupId } = job.payload as { readonly groupId: string };
          const ports = asPorts(context);
          const group = ports["game.world"].group(groupId);
          if (group === null || group.status !== "waiting" || group.currentTaskId !== null || group.injured === 0) {
            return;
          }
          ports["game.world"].setGroupStatus(groupId, "worsened", null);
          context.tx.emit("GroupWorsened", { groupId }, [{ kind: "public" }]);
          ports["game.world"].changeMeter("migration.safety", -10, "group-deadline");
        },
      },
      {
        kind: "character.recover",
        handler: (context, job) => {
          const { agentId } = job.payload as { readonly agentId: string };
          const record = readWorldState(context.tx, "character", agentId, characterStateSchema);
          if (record === null || record.state.injuredUntilTick === null) {
            return;
          }
          // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- record 已在上方判空，不需要可选链。
          if (record.state.injuredUntilTick > context.tx.worldTick) {
            return;
          }
          context.tx.put("character", agentId, { ...record.state, injuredUntilTick: null });
          context.tx.emit(
            "CharacterRecovered",
            { agentId, untilTick: context.tx.worldTick, cause: "recovery" },
            [
              ...principalsAudience([agentId]),
              factionAudience(record.state.factionId),
              { kind: "node", nodeId: record.state.nodeId },
            ],
          );
        },
      },
      {
        kind: "team.recover",
        handler: (context, job) => {
          const { teamId } = job.payload as { readonly teamId: string };
          const record = readWorldState(context.tx, "team", teamId, teamStateSchema);
          if (record === null || record.state.status !== "recovering") {
            return;
          }
          if (record.state.busyUntilTick !== null && record.state.busyUntilTick > context.tx.worldTick) {
            return;
          }
          context.tx.put("team", teamId, {
            ...record.state,
            status: "idle",
            busyUntilTick: null,
            currentTaskId: null,
          });
          context.tx.emit("TeamRecovered", { teamId }, [factionAudience(record.state.ownerFactionId)]);
        },
      },
    ],
    clockSteps: [
      {
        stepId: "world.daily-settlement",
        when: (tick) => tick > 0,
        handler: (context, tick) => {
          runDailySettlement(context as WorldContext, tick);
        },
      },
      {
        stepId: "world.chapter-evaluation",
        when: (tick) => tick > 0,
        handler: (context) => {
          runChapterEvaluation(context as WorldContext, chapterLengthTicks);
        },
      },
    ],
    consumers: [
      {
        consumerId: "world.agreement-counts",
        eventTypes: ["AgreementFulfilled", "AgreementBreached"],
        handler: (context, event: EventEnvelope) => {
          if (event.type !== "AgreementFulfilled" && event.type !== "AgreementBreached") {
            return;
          }
          const record = readWorldState(context.tx, "chapter-stats", "chapter-stats", chapterStatsStateSchema);
          const stats: ChapterStatsState = record?.state ?? { fulfilled: 0, breached: 0 };
          context.tx.put("chapter-stats", "chapter-stats", {
            fulfilled: stats.fulfilled + (event.type === "AgreementFulfilled" ? 1 : 0),
            breached: stats.breached + (event.type === "AgreementBreached" ? 1 : 0),
          });
        },
      },
    ],
  };
}

/** 供测试构造内容适配器的类型别名。 */
export type WorldContent = GameContent;
