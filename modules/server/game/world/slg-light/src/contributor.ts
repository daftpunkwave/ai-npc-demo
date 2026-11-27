/**
 * 注册世界模块的命令、job、时钟步骤与事件消费者，并实现 campaign 初始化与政策命令。
 * 依赖世界端口、地图/资源端口、内容索引与 authority 的处理器上下文。
 * 禁止在这里直接写地图/库存聚合，或在命令处理器中读取进程时间与随机源。
 */
import type { Json } from "@world-prism/contracts";
import { commandPayloadOf, watergateAllocationSchema } from "@world-prism/contracts";
import {
  controlsWatergate,
  effectivePrincipalId,
  factionAudience,
  principalsAudience,
  requireGameContent,
  type GameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@world-prism/module-sdk";
import { runDailySettlement } from "./settlement";
import { campaignAggregateId, metersAggregateId } from "./port";
import {
  characterStateSchema,
  readWorldState,
  teamStateSchema,
  type CampaignState,
  type CharacterState,
  type GroupState,
  type TeamState,
} from "./state";
import { worldModuleDefinition, worldOwnedAggregates } from "./definition";

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
  if (start.enabled === false) {
    return { kind: "rejected", reasonCode: "unknown-faction", safeMessage: "该派系开局未开放" };
  }
  if (context.tx.get<unknown>("campaign", campaignAggregateId) !== null) {
    return { kind: "rejected", reasonCode: "campaign-exists", safeMessage: "当前分支已经存在 campaign" };
  }
  // 日结、章节评估与剧情卡都以 t0 为绝对时间锚；非零开局会让三者互相错位。
  if (context.tx.worldTick !== 0) {
    return { kind: "rejected", reasonCode: "world-tick-not-zero", safeMessage: "只能在 t0 开局" };
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
    cityResources: null,
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
  // 委托聚合写入与 DelegationCreated 事件统一走世界端口，避免开局路径与端口各自手写一份聚合装配。
  const worldPort = asPorts(context)["game.world"];
  for (const delegation of delegations) {
    worldPort.createDelegation(delegation);
  }
  return { kind: "accepted", result: { campaignId } };
}

function policySet(context: WorldContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("policy.set", payload);
  const principalId = effectivePrincipalId(context.auth);
  const ports = asPorts(context);
  if (input.key === "watergate.allocation") {
    // 主体取自认证上下文，不信任命令自报身份；判定与协议水闸条款共用同一实现。
    const content = requireGameContent(context.content);
    if (!controlsWatergate(content, ports["game.world"].campaign(), principalId)) {
      return { kind: "rejected", reasonCode: "no-authority", safeMessage: "只有占公社席的党魁可以修改水闸分配" };
    }
    const allocation = watergateAllocationSchema.safeParse(input.value);
    if (!allocation.success) {
      return { kind: "rejected", reasonCode: "unknown-policy", safeMessage: "未知的水闸分配值" };
    }
    const oldValue = ports["game.world"].meters()?.["watergate.allocation"] ?? allocation.data;
    const result = ports["game.world"].setAllocation(allocation.data, principalId);
    if (!result.ok) {
      return { kind: "rejected", reasonCode: result.reasonCode, safeMessage: "水闸分配未改变" };
    }
    return { kind: "accepted", result: { oldValue, newValue: allocation.data } };
  }
  // 地图拥有的政策键（如道路状态）由地图端口自行解析、校验与执行，world 不了解其键格式与取值域。
  const mapPolicy = ports["game.map"].applyPolicy(input.key, input.value, principalId);
  if (mapPolicy !== null) {
    return mapPolicy.ok
      ? { kind: "accepted", result: { oldValue: mapPolicy.oldValue, newValue: mapPolicy.newValue } }
      : { kind: "rejected", reasonCode: mapPolicy.reasonCode, safeMessage: mapPolicy.safeMessage };
  }
  return { kind: "rejected", reasonCode: "unknown-policy", safeMessage: "未登记的政策键" };
}

/** 世界模块的规则贡献；handler 使用 context.modules 中已绑定到当前事务的端口。 */
export function createWorldContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: worldModuleDefinition.id,
    ownsAggregates: worldOwnedAggregates,
    commands: [
      {
        type: "campaign.start",
        handler: (context, payload) => {
          const input = commandPayloadOf("campaign.start", payload);
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
          if (record === null) {
            return;
          }
          const { injuredUntilTick } = record.state;
          if (injuredUntilTick === null || injuredUntilTick > context.tx.worldTick) {
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
    ],
  };
}

/** 供测试构造内容适配器的类型别名。 */
export type WorldContent = GameContent;
