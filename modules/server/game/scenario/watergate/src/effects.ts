/**
 * 执行并校验剧情卡与调试覆盖的效果白名单：广播、消息、传闻、叙事事实、库存调整、唤醒 Agent，以及覆盖专用指标/道路设置。
 * 依赖世界/地图/资源/通信端口、内容索引与 authority 事务；效果写入同一事务。
 * 禁止修改指标或道路状态（覆盖效果除外），也禁止调用模型生成正文。
 */
import type { AudienceSpec, CardEffect, OverrideEffect, ResourceDelta } from "@ai-npc/contracts";
import {
  principalsAudience,
  type GameContent,
  type GameModulePorts,
  type HandlerContext,
} from "@ai-npc/module-sdk";
import { DomainError } from "@ai-npc/contracts";

type EffectContext = HandlerContext<GameModulePorts, unknown>;

/** 规则第 9 节规定剧情卡广播视为在 grayharbor 发布，与玩家当前起点无关。 */
const scenarioBroadcastOriginNodeId = "grayharbor";

/** 应用标准剧情卡效果。 */
export function applyCardEffects(context: EffectContext, cardId: string, effects: readonly CardEffect[]): void {
  const ports = context.modules;
  for (const effect of effects) {
    if (effect.kind === "broadcast") {
      // 中继中断时只送达该发布节点的主体，正常与降级时远端按规则延迟。
      ports["game.comms"].postMessage({
        fromId: effect.speakerId,
        to: ["public"],
        text: effect.text,
        channel: "broadcast",
        intentKind: "scenario",
        originNodeId: scenarioBroadcastOriginNodeId,
      });
    } else if (effect.kind === "message") {
      ports["game.comms"].postMessage({
        fromId: effect.from,
        to: effect.to,
        text: effect.text,
        channel: "message",
        intentKind: "scenario",
      });
    } else if (effect.kind === "rumor") {
      context.tx.emit(
        "RumorSpread",
        { rumorId: context.ids("rum"), sourceId: effect.sourceId, aboutIds: [...effect.aboutIds], text: effect.text },
        [{ kind: "public" }],
      );
    } else if (effect.kind === "world-fact") {
      context.tx.emit(
        "WorldFactRecorded",
        { factId: context.ids("fact"), factType: effect.factType, payload: effect.payload },
        [effect.audience],
      );
    } else if (effect.kind === "stockpile-adjust") {
      // 负向调整只扣可用量（amount − reserved）：预留不会被击穿，可用量不足时按实际可扣量结算，不拒绝整张卡。
      const delta: ResourceDelta = { ...effect.delta };
      for (const resource of ["supply", "energy", "medical"] as const) {
        const value = delta[resource];
        if (value !== undefined && value < 0) {
          delta[resource] = Math.max(value, -ports["game.resources"].available(effect.stockpileId, resource));
        }
      }
      if ((delta.supply ?? 0) === 0 && (delta.energy ?? 0) === 0 && (delta.medical ?? 0) === 0) {
        continue;
      }
      const result = ports["game.resources"].adjust({
        stockpileId: effect.stockpileId,
        delta,
        reason: effect.reason,
      });
      if (!result.ok) {
        throw new DomainError("invalid-state", `剧情卡 ${cardId} 库存调整失败`, {
          details: { stockpileId: effect.stockpileId },
        });
      }
    } else {
      context.tx.emit(
        "AgentsSummoned",
        { agentIds: [...effect.agentIds], reason: effect.reason, cardId },
        principalsAudience(effect.agentIds),
      );
    }
  }
}

/** 应用覆盖效果；额外允许直接设置指标与道路状态。 */
export function applyOverrideEffects(context: EffectContext, effects: readonly OverrideEffect[]): void {
  const ports = context.modules;
  for (const effect of effects) {
    if (effect.kind === "meter-set") {
      const current = ports["game.world"].meters()?.[effect.meter];
      if (current === undefined) {
        throw new DomainError("invalid-state", `未知指标 ${effect.meter}`);
      }
      ports["game.world"].changeMeter(effect.meter, effect.value - current, "scenario-pressure");
    } else if (effect.kind === "road-status-set") {
      const result = ports["game.map"].setRoadStatus(effect.roadId, effect.status, "scenario-override", true);
      if (!result.ok) {
        throw new DomainError("invalid-state", `覆盖道路 ${effect.roadId} 失败`);
      }
    } else {
      applyCardEffects(context, "override", [effect]);
    }
  }
}

/** 主体是否由内容包定义：玩家、角色与作为战略主体的派系。 */
function knownPrincipal(content: GameContent, principalId: string): boolean {
  return (
    principalId === content.playerPrincipalId ||
    content.characters.has(principalId) ||
    content.factions.has(principalId)
  );
}

/** 受众声明引用的节点、主体与派系是否都存在于内容包。 */
function knownAudience(content: GameContent, audience: AudienceSpec): boolean {
  switch (audience.kind) {
    case "public":
    case "system":
      return true;
    case "node":
      return content.nodes.has(audience.nodeId);
    case "principals":
      return audience.ids.every((id) => knownPrincipal(content, id));
    case "faction":
      return content.factions.has(audience.factionId);
  }
}

/** 校验单条卡片效果引用的内容对象；返回第一处问题描述，全部存在时返回 null。 */
export function invalidEffectReference(content: GameContent, effect: CardEffect): string | null {
  switch (effect.kind) {
    case "broadcast":
      return knownPrincipal(content, effect.speakerId) ? null : `广播署名 ${effect.speakerId}`;
    case "message": {
      if (!knownPrincipal(content, effect.from)) {
        return `消息发送者 ${effect.from}`;
      }
      const unknown = effect.to.find((id) => !knownPrincipal(content, id));
      return unknown === undefined ? null : `消息接收者 ${unknown}`;
    }
    case "rumor": {
      const unknown = effect.aboutIds.find((id) => !knownPrincipal(content, id));
      return unknown === undefined ? null : `传闻对象 ${unknown}`;
    }
    case "world-fact":
      return knownAudience(content, effect.audience) ? null : "世界事实受众";
    case "stockpile-adjust":
      return content.stockpiles.has(effect.stockpileId) ? null : `库存点 ${effect.stockpileId}`;
    case "wake-agents": {
      const unknown = effect.agentIds.find((id) => !knownPrincipal(content, id));
      return unknown === undefined ? null : `召集对象 ${unknown}`;
    }
  }
}

/** 校验一组卡片效果引用；返回第一处问题描述，全部合法时返回 null。 */
export function invalidEffectReferences(
  content: GameContent,
  effects: readonly CardEffect[],
): string | null {
  for (const effect of effects) {
    const invalid = invalidEffectReference(content, effect);
    if (invalid !== null) {
      return invalid;
    }
  }
  return null;
}
