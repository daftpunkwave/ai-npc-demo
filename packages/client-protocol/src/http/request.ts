/**
 * 核心职责：定义 HTTP 请求选项、缺省请求期限和领域请求契约，统一编码查询参数，提供请求与中止竞速用的拒绝信号。
 * 交互契约：依赖公共角色类型与响应 schema，供浏览器 HTTP 客户端内部装配使用。
 * 约束与禁忌：不保存会话、不执行网络请求，领域方法不指定认证身份。
 */
import type { ConsoleActiveRole } from "@world-prism/contracts";
import type { z } from "zod";

/**
 * 单个请求的缺省期限（毫秒）。
 * 服务端处理期限为 30 秒，超期时自己返回可重试的 plugin-failed；客户端期限略长于它，
 * 服务端仍在响应时以服务端的结构化错误为准，只有服务端挂起或连接半开时才由客户端判定超时。
 */
export const defaultRequestTimeoutMs = 35_000;

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly authenticated?: boolean;
  readonly activeRole?: ConsoleActiveRole;
  /** 调用方取消信号；取消后请求被中止，并原样抛出取消原因而不是领域错误。 */
  readonly signal?: AbortSignal | undefined;
}

export type ConsoleRequest = <T>(
  schema: z.ZodType<T>,
  path: string,
  options?: Pick<RequestOptions, "method" | "body" | "signal">,
) => Promise<T>;

/**
 * signal 中止时以中止原因拒绝的 Promise，只用于与请求竞速；dispose 移除监听。
 * 已中止的 signal 不会再派发 abort 事件，因此创建时直接拒绝。
 */
export function rejectWhenAborted(signal: AbortSignal): { readonly promise: Promise<never>; dispose(): void } {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return {
    promise,
    dispose: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

export function queryString(values: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text.length === 0 ? "" : `?${text}`;
}
