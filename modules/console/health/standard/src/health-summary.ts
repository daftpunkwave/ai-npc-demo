/**
 * 核心职责：把控制台健康响应转换为页面直接渲染的整体状态、队列与水位文案。
 * 交互契约：输入已通过 consoleHealthResponseSchema 校验的响应；不发起请求、不保留状态。
 * 约束与禁忌：禁止把缺失的队列或水位字段当作 0，也禁止在响应为 degraded 时输出 ready。
 */
import type { ConsoleHealthResponse } from "@world-prism/contracts";

export interface HealthSummaryView {
  /** 与接口响应一致的整体状态文案。 */
  readonly statusLabel: "ready" | "degraded";
  /** 徽标样式类；degraded 使用独立颜色。 */
  readonly statusClass: string;
  /** 待处理数量：只累加有数据来源的队列。 */
  readonly queuedText: string;
  /** 队列明细；未接入的字段明确标注。 */
  readonly queueDetail: string;
  /** 水位落后 Agent 数；没有数据来源时标注未接入。 */
  readonly laggingText: string;
}

export function healthSummary(health: ConsoleHealthResponse): HealthSummaryView {
  const maintenance = health.queues.maintenanceQueued;
  const running = health.queues.turnsRunning;
  const model = health.queues.modelQueue;
  const details = [
    `turns ${health.queues.turnsQueued}`,
    maintenance === undefined ? "maintenance 未接入" : `maintenance ${maintenance}`,
    ...(running === undefined ? [] : [`running ${running}`]),
    ...(model === undefined ? [] : [`model ${model}`]),
  ];
  return {
    statusLabel: health.status,
    statusClass: `health-chip health-chip-${health.status}`,
    queuedText: String(health.queues.turnsQueued + (maintenance ?? 0)),
    queueDetail: details.join(" / "),
    laggingText: health.laggingAgents === undefined ? "未接入" : String(health.laggingAgents),
  };
}
