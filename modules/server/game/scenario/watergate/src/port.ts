/**
 * 实现剧情卡查询端口；控制台读取草稿与分支状态。
 * 依赖 scenario-card 聚合与 scoped WorldTx；不触发卡片或应用效果。
 * 禁止在查询中改写卡片状态。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 接口参数名用于表达调用契约；Codacy 缺少 workspace 类型解析时将联合类型误判为 any。 */
import { gameModuleIds, type ScenarioCardView, type ScopedWorldTxFactory } from "@ai-npc/module-sdk";
import { readCardState, type ScenarioCardState } from "./state";

/** 剧情卡查询形状；控制台与运营 API 复用。 */
export interface ScenarioPort {
  card(cardId: string): ScenarioCardView | null;
  cards(): readonly ScenarioCardView[];
}

/** 构造绑定到当前事务的剧情查询端口；moduleId 区分标准版与升级版。 */
export function createScenarioPort(txFor: ScopedWorldTxFactory, moduleId: string = gameModuleIds.scenario): ScenarioPort {
  const tx = () => txFor(moduleId);
  return {
    card: (cardId) => {
      const state = readCardState(tx(), cardId);
      return state === null ? null : { cardId: state.cardId, version: state.version, status: state.status, triggerAtTick: state.triggerAtTick };
    },
    cards: () => {
      const cards: ScenarioCardView[] = [];
      for (const entry of tx().list<ScenarioCardState>("scenario-card")) {
        const state = entry.state;
        cards.push({ cardId: state.cardId, version: state.version, status: state.status, triggerAtTick: state.triggerAtTick });
      }
      return cards;
    },
  };
}
