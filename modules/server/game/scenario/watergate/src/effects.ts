/**
 * 执行剧情卡与调试覆盖的效果白名单：广播、消息、传闻、叙事事实、库存调整、唤醒 Agent，以及覆盖专用指标/道路设置。
 * 依赖世界/地图/资源/通信端口与 authority 事务；效果写入同一事务。
 * 禁止修改指标或道路状态（覆盖效果除外），也禁止调用模型生成正文。
 */
import type { CardEffect, OverrideEffect } from "@ai-npc/contracts";
import type { GameModulePorts, HandlerContext } from "@ai-npc/module-sdk";
import { DomainError } from "@ai-npc/contracts";

type EffectContext = HandlerContext<GameModulePorts, unknown>;

/** 应用标准剧情卡效果。 */
export function applyCardEffects(context: EffectContext, cardId: string, effects: readonly CardEffect[]): void {
  const ports = context.modules;
  for (const effect of effects) {
    if (effect.kind === "broadcast") {
      ports["game.comms"].postMessage({
        fromId: effect.speakerId,
        to: ["public"],
        text: effect.text,
        channel: "broadcast",
        intentKind: "scenario",
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
      const result = ports["game.resources"].adjust({
        stockpileId: effect.stockpileId,
        delta: effect.delta,
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
        [{ kind: "principals", ids: [...effect.agentIds] }],
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
