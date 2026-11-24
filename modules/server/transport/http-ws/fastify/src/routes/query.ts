/**
 * 核心职责：把 Fastify 查询参数收窄为有界文本、整数，并规范化为公共 schema 的输入类型。
 * 交互契约：只处理不可信输入，不读取会话或业务存储；取值范围由调用方传入的共享 schema 裁决。
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

/** 区分缺省文本筛选与已提供但非法的文本筛选。 */
export function queryOptionalText(query: unknown, key: string): string | null | undefined {
  if (typeof query !== "object" || query === null || Array.isArray(query)) return undefined;
  if (!Object.hasOwn(query, key)) return undefined;
  return queryText(query, key) ?? null;
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

/** 已规范化的查询值：缺省、合法值与非法值三态分开表达，交给公共 schema 判定边界。 */
export interface NormalizedQuery {
  readonly value: Record<string, unknown>;
  readonly invalid: boolean;
}

/**
 * 把查询字符串规范化为公共 schema 的输入类型：数字串转数字、逗号列表转数组。
 *
 * 只做类型规范化，不判断取值范围：`fromSeq` 是否非负、`types` 是否超上限一律由
 * 调用方传入的共享 schema 裁决，避免路由与契约各写一套边界后相互漂移。
 * 任一字段无法规范化时返回 `invalid`，由路由按 400 处理而不是静默丢弃。
 */
export function normalizeQuery(query: unknown): NormalizedQuery {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return { value: {}, invalid: false };
  }
  const value: Record<string, unknown> = {};
  let invalid = false;
  for (const [key, entry] of Object.entries(query as Readonly<Record<string, unknown>>)) {
    if (typeof entry !== "string") {
      // Fastify 对重复查询键给出数组；本项目的查询参数都是单值，重复即视为非法输入。
      invalid = true;
      continue;
    }
    if (key === "types") {
      const items = entry.split(",").map((item) => item.trim());
      value[key] = items.every((item) => item.length > 0) ? items : null;
      continue;
    }
    if (key === "fromSeq" || key === "limit") {
      // 空串与纯空白不是合法整数：Number("") 会得到 0，直接交给 schema 会把「未提供值」当成 0。
      const text = entry.trim();
      value[key] = text.length > 0 && Number.isInteger(Number(text)) ? Number(text) : null;
      continue;
    }
    // 与既有 queryText 一致：纯空白按「未提供」处理，避免空白串冒充合法筛选值。
    const text = entry.trim();
    value[key] = text.length > 0 ? text : null;
  }
  return { value, invalid };
}
