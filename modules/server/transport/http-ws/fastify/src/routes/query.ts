/**
 * 核心职责：把 Fastify 查询参数收窄为有界文本、整数与逗号分隔列表。
 * 交互契约：只处理不可信输入，不读取会话或业务存储。
 * 约束与禁忌：不得把非法数字静默替换为默认值，也不得允许无界列表进入 SQL 筛选。
 */
export function queryText(query: unknown, key: string): string | undefined {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return undefined;
  }
  // key 只来自本目录固定路由字段名，不接收调用方拼接。
  // eslint-disable-next-line security/detect-object-injection
  const value = (query as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function queryInteger(query: unknown, key: string, fallback: number): number | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) return fallback;
  const record = query as Readonly<Record<string, unknown>>;
  if (!Object.hasOwn(record, key)) return fallback;
  // key 只来自本目录固定路由字段名，不接收调用方拼接。
  // eslint-disable-next-line security/detect-object-injection
  const raw = record[key];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export function queryCsv(
  query: unknown,
  key: string,
  maxLength: number,
  maxItems: number,
): string[] | null | undefined {
  const raw = queryText(query, key);
  if (raw === undefined) return undefined;
  if (raw.length > maxLength) return null;
  // 长度上界保证拆分结果有界，扫描器仍可能把规范化步骤误判为无界循环。
  // nosemgrep
  const values = raw.split(",");
  return values.length <= maxItems && values.every((value) => value.length > 0)
    ? values
    : null;
}
