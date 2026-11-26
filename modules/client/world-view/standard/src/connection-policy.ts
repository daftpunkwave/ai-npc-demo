/**
 * 核心职责：定义玩家流连接的重连退避节奏与会话失效判定。
 * 交互契约：调用方传入重连次数、随机源、关闭码或传输层错误；函数不建立连接、不读写状态。
 * 约束与禁忌：禁止依赖全局随机源、计时器或浏览器 WebSocket，保持纯函数以便独立验证。
 */
import { DomainError, isSessionInvalidCloseCode, isTicketInvalidCloseCode } from "@world-prism/contracts";

/** 重连与会话失效判定所用的关闭码语义由公共契约统一定义，客户端不再另存一份常量。 */
export { isSessionInvalidCloseCode, isTicketInvalidCloseCode };

/** 首次重连的基础等待；之后按 2 的幂递增。 */
export const RECONNECT_BASE_DELAY_MS = 1_000;

/** 单次重连等待上限，避免后台标签页长期高频请求。 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** 抖动比例：实际等待在指数值的 ±20% 内浮动，避免多标签页同时重连。 */
export const RECONNECT_JITTER_RATIO = 0.2;

/**
 * 判断错误是否表示会话已失效。
 * 票据请求返回 401/403（ApiClient 映射为 unauthenticated/forbidden）时继续重连只会重复失败，
 * 因此与 4401 关闭码一样停止重连并清除本地令牌。
 */
export function isSessionInvalidError(error: unknown): boolean {
  return (
    error instanceof DomainError && (error.code === "unauthenticated" || error.code === "forbidden")
  );
}

/** 第 attempt 次重连（从 1 起）的等待毫秒数；指数增长、封顶并带抖动。 */
export function reconnectDelayMs(attempt: number, random: () => number): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exponent);
  const jitter = 1 - RECONNECT_JITTER_RATIO + random() * RECONNECT_JITTER_RATIO * 2;
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(exponential * jitter));
}
