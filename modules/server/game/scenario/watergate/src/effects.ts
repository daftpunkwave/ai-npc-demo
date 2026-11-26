/**
 * 执行并校验剧情卡与调试覆盖的效果白名单：广播、消息、传闻、叙事事实、库存调整、唤醒 Agent，以及覆盖专用指标/道路设置。
 * 依赖世界/地图/资源/通信端口、内容索引与 authority 事务；效果写入同一事务。
 * 禁止修改指标或道路状态（覆盖效果除外），也禁止调用模型生成正文。
 */
import type { AudienceSpec, CardEffect, OverrideEffect, ResourceDelta, ResourceId } from "@world-prism/contracts";
import {
  principalsAudience,
  requireGameContent,
  type GameContent,
  type GameModulePorts,
  type HandlerContext,
} from "@world-prism/module-sdk";
import { DomainError } from "@world-prism/contracts";

type EffectContext = HandlerContext<GameModulePorts, unknown>;

/** 读取剧情声明的广播发布节点；与玩家当前起点无关。 */
function broadcastOriginNodeId(content: GameContent): string | undefined {
  return content.scenarios.get(content.defaultScenario)?.broadcastOriginNodeId;
}

/** 读取剧情声明的 signature-only 署名名单；名单之外的署名按已定义主体校验。 */
function signatureOnlyIds(content: GameContent): readonly string[] {
  return content.scenarios.get(content.defaultScenario)?.signatureOnlyPrincipalIds ?? [];
}

/** 应用标准剧情卡效果。 */
export function applyCardEffects(context: EffectContext, cardId: string, effects: readonly CardEffect[]): void {
  const ports = context.modules;
  const content = requireGameContent(context.content);
  const originNodeId = broadcastOriginNodeId(content);
  for (const effect of effects) {
    if (effect.kind === "broadcast") {
      // 中继中断时只送达该发布节点的主体，正常与降级时远端按规则延迟。
      ports["game.comms"].postMessage({
        fromId: effect.speakerId,
        to: ["public"],
        text: effect.text,
        channel: "broadcast",
        intentKind: "scenario",
        ...(originNodeId === undefined ? {} : { originNodeId }),
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
      // 只有显式声明 clampToAvailable 的调整按可用量（amount − reserved）截断；
      // 其余调整交给资源端口整笔校验，任一资源不足就失败，不留下部分扣减。
      const delta = effect.clampToAvailable === true
        ? clampToAvailable(ports["game.resources"], effect.stockpileId, effect.delta)
        : effect.delta;
      if (effect.clampToAvailable === true && isZeroDelta(delta)) {
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

/** 负向增量夹到可用量（amount − reserved）；正向增量与未声明的资源保持原样。 */
function clampToAvailable(
  resources: GameModulePorts["game.resources"],
  stockpileId: string,
  delta: ResourceDelta,
): ResourceDelta {
  // 缺少运行时状态时不能把可用量当成 0：那会让效果静默变成空操作。
  if (resources.stockpile(stockpileId) === null) {
    throw new DomainError("invalid-state", `剧情卡引用的库存点 ${stockpileId} 没有运行时状态`, {
      details: { stockpileId },
    });
  }
  const clamp = (value: number | undefined, resource: ResourceId): number | undefined =>
    value === undefined || value >= 0 ? value : Math.max(value, -resources.available(stockpileId, resource));
  const supply = clamp(delta.supply, "supply");
  const energy = clamp(delta.energy, "energy");
  const medical = clamp(delta.medical, "medical");
  return {
    ...(supply === undefined ? {} : { supply }),
    ...(energy === undefined ? {} : { energy }),
    ...(medical === undefined ? {} : { medical }),
  };
}

/** 三资源增量是否全为零；用于跳过被夹到空操作的调整。 */
function isZeroDelta(delta: ResourceDelta): boolean {
  return (delta.supply ?? 0) === 0 && (delta.energy ?? 0) === 0 && (delta.medical ?? 0) === 0;
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

/** 主体是否由内容包定义：玩家、角色、作为战略主体的派系，或剧情声明的 signature-only 署名。 */
function knownPrincipal(content: GameContent, principalId: string): boolean {
  return (
    principalId === content.playerPrincipalId ||
    content.characters.has(principalId) ||
    content.factions.has(principalId) ||
    signatureOnlyIds(content).includes(principalId)
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
