/**
 * 定义运行中生成的 ID 前缀与格式校验，以及内容包固定 ID 的校验。
 * 依赖 zod 的正则校验；供信封、领域对象与 API DTO 约束标识符。
 * 禁止在此生成 ID 或读取时间/随机源，ID 由宿主注入的服务生成。
 */
import { z } from "zod";

/**
 * 运行中 ID 的前缀全集，按用途分组排列。
 * 前缀只是标识类别，不携带排序或权限语义。
 */
export const idPrefixes = [
  "wld",
  "br",
  "run",
  "cmp",
  "cmd",
  "rcp",
  "evt",
  "job",
  "op",
  "task",
  "inv",
  "agr",
  "conv",
  "dlg",
  "msg",
  "shr",
  "del",
  "pg",
  "kg",
  "obs",
  "mem",
  "turn",
  "att",
  "llm",
  "tc",
  "art",
  "trc",
  "spn",
  "snap",
  "ses",
  "prb",
  "rr",
  "mnt",
  "trg",
  "exp",
  "rum",
] as const;

export type IdPrefix = (typeof idPrefixes)[number];

export const idPrefixSchema = z.enum(idPrefixes);

/**
 * 尾段使用小写 Crockford base32 字母表（排除易混的 i、l、o、u），与既有 ID 样例的字符形态一致。
 * 随机 ID 只用于标识，不参与随机种子、排序或哈希输入的语义字段。
 */
const idBodyPattern = "[0-9a-hjkmnp-tv-z]{12}";

/** 任意运行中 ID 的完整格式：<前缀>-<12 位小写 base32>。 */
export const runtimeIdSchema = z
  .string()
  .regex(new RegExp(`^(${idPrefixes.join("|")})-${idBodyPattern}$`), "不是合法的运行中 ID");

/** 按前缀生成完整图案，供 schema 与布尔校验函数复用。 */
const idPatternForPrefix = (prefix: IdPrefix): RegExp => new RegExp(`^${prefix}-${idBodyPattern}$`);

/** 生成某前缀的运行中 ID schema；前缀固定后不接受其他前缀。 */
export function runtimeIdSchemaFor(prefix: IdPrefix): z.ZodString {
  return z.string().regex(idPatternForPrefix(prefix), `不是合法的 ${prefix} ID`);
}

/** 校验字符串是否为指定前缀的运行中 ID。 */
export function isRuntimeIdFor(prefix: IdPrefix, value: string): boolean {
  return idPatternForPrefix(prefix).test(value);
}

/** 校验字符串是否为任意前缀的运行中 ID。 */
export function isRuntimeId(value: string): boolean {
  return runtimeIdSchema.safeParse(value).success;
}

/** 全部前缀对应的 ID schema，避免调用方手写前缀字符串。 */
export const idSchemas = Object.fromEntries(
  idPrefixes.map((prefix) => [prefix, runtimeIdSchemaFor(prefix)]),
) as unknown as Readonly<Record<IdPrefix, z.ZodString>>;

/**
 * 主体 ID：玩家、Agent、控制台账号与系统主体共用。
 * 主体 ID 来自认证上下文或内容包，形态不统一，因此只约束非空字符串。
 */
export const principalIdSchema = z.string().min(1);

/** 内容包固定字符串 ID：小写字母开头，只含小写字母、数字与连字符。 */
const contentTokenPattern = /^[a-z][a-z0-9-]*$/;

export const contentTokenIdSchema = z.string().regex(contentTokenPattern, "不是合法的内容 ID");

/** 节点名即节点 ID。 */
export const nodeIdSchema = contentTokenIdSchema;

/** 派系 ID 是内容包固定字符串。 */
export const factionIdSchema = contentTokenIdSchema;

/** 内容 ID 的固定前缀形态，随机后缀不适用于内容 ID。 */
const contentIdSchemaWithPrefix = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}[a-z0-9-]+$`), `不是合法的 ${prefix} 内容 ID`);

export const roadIdSchema = contentIdSchemaWithPrefix("r-");
export const stockpileIdSchema = contentIdSchemaWithPrefix("sp-");
export const teamIdSchema = contentIdSchemaWithPrefix("team-");
export const groupIdSchema = contentIdSchemaWithPrefix("grp-");
export const evidenceIdSchema = contentIdSchemaWithPrefix("ev-");
export const secretIdSchema = contentIdSchemaWithPrefix("sec-");
export const scenarioCardIdSchema = contentIdSchemaWithPrefix("card-");
export const sourceIdSchema = contentIdSchemaWithPrefix("src-");

/** 全部内容 ID schema，按内容对象类别命名，避免与运行中前缀混淆。 */
export const contentIdSchemas = {
  node: nodeIdSchema,
  r: roadIdSchema,
  sp: stockpileIdSchema,
  team: teamIdSchema,
  grp: groupIdSchema,
  ev: evidenceIdSchema,
  sec: secretIdSchema,
  card: scenarioCardIdSchema,
  src: sourceIdSchema,
} as const;

/** 内容包中的一种固定 ID，供需要接受任意内容 ID 的字段使用。 */
export const contentIdSchema = z.union([
  nodeIdSchema,
  factionIdSchema,
  roadIdSchema,
  stockpileIdSchema,
  teamIdSchema,
  groupIdSchema,
  evidenceIdSchema,
  secretIdSchema,
  scenarioCardIdSchema,
  sourceIdSchema,
]);
