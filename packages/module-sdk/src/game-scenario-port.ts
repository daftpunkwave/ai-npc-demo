/**
 * 核心职责：定义剧情模块的游戏端口与剧情卡视图类型。
 * 交互契约：依赖公共契约的剧情卡状态词表；端口查询返回卡状态。
 * 约束与禁忌：具体卡状态由剧情模块拥有；禁止在这里实现触发规则。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type { ScenarioCardStatus } from "@ai-npc/contracts";

/** 剧情卡查询端口；具体卡状态由剧情模块拥有，词表与公共契约一致。 */
export interface ScenarioCardView {
  readonly cardId: string;
  readonly version: number;
  readonly status: ScenarioCardStatus;
  readonly triggerAtTick: number;
}

export interface GameScenarioPort {
  card(cardId: string): ScenarioCardView | null;
  cards(): readonly ScenarioCardView[];
}
