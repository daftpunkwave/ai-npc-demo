/**
 * 核心职责：定义 HTTP 请求选项和领域请求契约，统一编码查询参数。
 * 交互契约：依赖公共角色类型与响应 schema，供浏览器 HTTP 客户端内部装配使用。
 * 约束与禁忌：不保存会话、不执行网络请求，领域方法不指定认证身份。
 */
import type { ConsoleActiveRole } from "@ai-npc/contracts";
import type { z } from "zod";

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly authenticated?: boolean;
  readonly activeRole?: ConsoleActiveRole;
  readonly signal?: AbortSignal | undefined;
}

export type ConsoleRequest = <T>(
  schema: z.ZodType<T>,
  path: string,
  options?: Pick<RequestOptions, "method" | "body" | "signal">,
) => Promise<T>;

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
