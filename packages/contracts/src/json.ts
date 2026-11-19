/**
 * 定义 JSON 值类型、运行时校验 schema 与规范化序列化。
 * 依赖 zod 的递归校验；供事件 payload、投影内容、配置值与哈希输入共用。
 * 禁止引入 Node/DOM API，禁止接受 NaN、Infinity 或任何非 JSON 值。
 */
import { z } from "zod";

/** JSON 值：null、布尔、有限数字、字符串、数组与字符串键对象。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 面向模型的 JSON Schema 以 JSON 值表示，这里只做别名不另建运行时结构。 */
export type JsonSchema = Json;

/** 递归校验 JSON 值；zod 4 的 number schema 本身拒绝 NaN 与 Infinity。 */
export const jsonValueSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** 以字符串键对象表示的 JSON 对象，用于配置块等只接受对象的位置。 */
export const jsonObjectSchema: z.ZodType<{ [key: string]: Json }> = z.record(z.string(), jsonValueSchema);

/**
 * 生成规范 JSON（键按字典序、无空白），作为哈希与幂等比较的唯一序列化形态。
 * 非有限数字或非 JSON 值直接抛 TypeError，不做隐式转换。
 */
export function canonicalJson(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("规范化 JSON 拒绝非有限数字");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("规范化 JSON 只接受 JSON 值");
  }
  const entries = Object.keys(value).sort();
  const serialized = entries.map((key) => {
    // eslint-disable-next-line security/detect-object-injection -- 键来自 Object.keys(value) 的同一对象。
    const item = (value as { [key: string]: Json })[key];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (item === undefined) {
      throw new TypeError("规范化 JSON 拒绝 undefined 属性值");
    }
    return `${JSON.stringify(key)}:${canonicalJson(item)}`;
  });
  return `{${serialized.join(",")}}`;
}
