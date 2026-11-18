/**
 * 内容 schema 共用的版本、ID、文本与严格对象构造辅助。
 * 依赖 zod；只提供字段形状原语，不包含任何具体内容文件的业务字段。
 * 禁止在此做跨文件引用检查或填充默认值。
 */
import { z } from "zod";

/** 内容文件共用的 schema 版本。 */
export const schemaVersion = z.literal(1);

/** 内容文件内固定字符串 ID：小写字母开头，只含小写字母、数字与连字符。 */
export const contentIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "不是合法的内容 ID");

/** 节点、派系等对象的稳定 ID。 */
export const nodeIdSchema = contentIdSchema;
export const factionIdSchema = contentIdSchema;
export const roadIdSchema = z.string().regex(/^r-[a-z0-9-]+$/, "不是合法的道路 ID");
export const stockpileIdSchema = z.string().regex(/^sp-[a-z0-9-]+$/, "不是合法的库存点 ID");
export const teamIdSchema = z.string().regex(/^team-[a-z0-9-]+$/, "不是合法的队伍 ID");
export const groupIdSchema = z.string().regex(/^grp-[a-z0-9-]+$/, "不是合法的群体 ID");
export const evidenceIdSchema = z.string().regex(/^ev-[a-z0-9-]+$/, "不是合法的证据 ID");
export const secretIdSchema = z.string().regex(/^sec-[a-z0-9-]+$/, "不是合法的秘密 ID");
export const scenarioCardIdSchema = z.string().regex(/^card-[a-z0-9-]+$/, "不是合法的剧情卡 ID");

/** 非空中文文本。 */
export const textSchema = z.string().min(1);

/** 非负整数。 */
export const nonNegativeIntSchema = z.number().int().nonnegative();

/** 按给定键构造严格对象；用于要求模板与词典恰好覆盖已知键集合。 */
export function exactRecord<K extends string, S extends z.ZodType>(
  keys: readonly K[],
  valueSchema: S,
) {
  const shape = Object.fromEntries(keys.map((key) => [key, valueSchema])) as Record<K, S>;
  return z.object(shape).strict();
}

/** 角色与战略 Agent 共同的人格字段。 */
export const personaFieldsSchema = {
  values: z.array(textSchema).min(1),
  speechStyle: textSchema,
  bottomLines: z.array(textSchema).min(1),
  goals: z.array(textSchema).min(1),
};
