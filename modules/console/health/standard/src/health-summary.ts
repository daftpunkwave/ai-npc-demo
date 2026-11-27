/**
 * 核心职责：把控制台健康响应转换为页面直接渲染的整体状态、队列、水位与热路径耗时文案。
 * 交互契约：输入已通过 consoleHealthResponseSchema 校验的响应；不发起请求、不保留状态。
 * 约束与禁忌：禁止把缺失的队列或水位字段当作 0，也禁止在响应为 degraded 时输出 ready；
 * 宿主未提供热路径耗时时不生成空行冒充「没有热路径」。
 */
import type { ConsoleHealthResponse, ConsoleHotPathTiming } from "@world-prism/contracts";

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
  /** 热路径耗时行；宿主未提供时为 null。 */
  readonly hotPaths: readonly HotPathRowView[] | null;
}

export interface HotPathRowView {
  readonly name: string;
  /** 累计次数与失败次数。 */
  readonly countText: string;
  /** 最近样本窗口内的中位数、p95 与最大值。 */
  readonly latencyText: string;
}

/** 毫秒文案：十毫秒以内保留两位小数，便于分辨亚毫秒级变化。 */
export function formatDurationMs(value: number): string {
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}

function hotPathRow(entry: ConsoleHotPathTiming): HotPathRowView {
  return {
    name: entry.name,
    countText: entry.errors === 0 ? `${entry.count} 次` : `${entry.count} 次 · 失败 ${entry.errors}`,
    latencyText: `p50 ${formatDurationMs(entry.p50Ms)} · p95 ${formatDurationMs(entry.p95Ms)} · 最大 ${formatDurationMs(entry.maxMs)}（近 ${entry.samples} 次）`,
  };
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
    hotPaths: health.hotPaths === undefined ? null : health.hotPaths.map(hotPathRow),
  };
}
