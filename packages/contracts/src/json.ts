/**
 * 核心职责：定义 JSON 值类型、输入预算校验与规范化序列化。
 * 交互契约：`jsonValueSchema` 供内部结构判定与既有调用方共用；`boundedJsonValueSchema`
 * 在不可信输入边界（命令、事件与模型工具参数）额外检查深度与节点预算；
 * `canonicalJson` 在序列化前检查同一份预算，因此超深输入得到明确错误而不是 RangeError。
 * 约束与禁忌：禁止引入 Node/DOM API，禁止接受 NaN、Infinity 或任何非 JSON 值。
 */
import { z } from "zod";

/** JSON 值：null、布尔、有限数字、字符串、数组与字符串键对象。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 面向模型的 JSON Schema 以 JSON 值表示，这里只做别名不另建运行时结构。 */
export type JsonSchema = Json;

/**
 * 输入预算：容器嵌套深度上限与节点总数上限。
 * 深度按「容器套容器」计，与 JSON 文本的方括号/花括号层数一致，标量不计入深度；
 * 节点数把标量与容器都算一个节点，用于挡住超宽数组与超多键的对象绕过深度限制。
 * 正常业务载荷（命令、事件、工具参数、配置值）远小于这两个上限，
 * 而超限输入在校验阶段即被拒绝，不会走到哈希或规范化序列化。
 */
export const jsonInputBudget = {
  /** 容器嵌套深度上限。 */
  maxDepth: 200,
  /** 节点总数上限。 */
  maxNodes: 200_000,
} as const;

/** 预算违规类型：深度、节点数与「不是 JSON 对象」三类。 */
export type JsonBudgetViolationKind = "depth" | "nodes" | "type";

/** 一条预算违规：kind 区分超限类型，segments 给出可定位的容器路径段。 */
export interface JsonBudgetViolation {
  readonly kind: JsonBudgetViolationKind;
  readonly message: string;
  readonly path: string;
  /** 违规所在的路径段；可直接用作 zod issue 的 path。 */
  readonly segments: readonly string[];
}

/** 诊断文本里路径段的显示上限：深路径只保留尾部，避免错误信息本身被超长路径淹没。 */
const maxRenderedSegments = 8;

/** 把路径段渲染成诊断文本；超过显示上限时保留尾部并标出被省略的层数。 */
function formatPath(segments: readonly string[]): string {
  if (segments.length === 0) {
    return "$";
  }
  const omitted = Math.max(0, segments.length - maxRenderedSegments);
  const shown = omitted === 0 ? segments : segments.slice(omitted);
  const head = omitted === 0 ? "$" : `$…(${omitted})`;
  return `${head}${shown
    .map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `[${JSON.stringify(segment)}]`))
    .join("")}`;
}

/**
 * 显式栈帧：只保存父帧下标与本层键，避免为每个节点复制一份路径数组。
 * 路径在命中违规时沿父链回溯生成，因此正常情况下不做额外分配。
 */
interface BudgetFrame {
  readonly value: unknown;
  readonly depth: number;
  readonly parent: number;
  readonly key: string | null;
}

/** 沿父链回溯出路径段；根帧的 parent 为 -1。 */
function pathSegments(frames: readonly BudgetFrame[], index: number): string[] {
  const segments: string[] = [];
  let cursor = index;
  while (cursor >= 0) {
    const frame = frames[cursor];
    if (frame === undefined) {
      break;
    }
    if (frame.key !== null) {
      segments.push(frame.key);
    }
    cursor = frame.parent;
  }
  return segments.reverse();
}

function budgetViolation(
  kind: JsonBudgetViolationKind,
  frames: readonly BudgetFrame[],
  index: number,
  reason: string,
): JsonBudgetViolation {
  const segments = pathSegments(frames, index);
  const path = formatPath(segments);
  return { kind, segments, path, message: `${reason}（路径 ${path}）` };
}

/**
 * 判断值是否为 JSON 对象形态：普通对象字面量或 null 原型对象。
 * Date、Map、类实例等不是 JSON 值；预算检查与规范化序列化必须对它们给出一致判定，
 * 否则序列化会把它们悄悄写成 `{}`。
 */
function isJsonObjectShape(value: object): value is { readonly [key: string]: unknown } {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 以显式栈迭代遍历待校验值，检查深度、节点与对象类型预算；返回第一条违规，全部通过时返回 null。
 * 只做结构与预算判断，不判断标量是否为合法 JSON 值（NaN、Infinity 由 schema 拒绝）。
 * 循环引用最终由深度上限拦下，因此不会无限展开。
 */
export function checkJsonBudget(value: unknown): JsonBudgetViolation | null {
  const frames: BudgetFrame[] = [{ value, depth: 0, parent: -1, key: null }];
  let nodes = 0;
  let cursor = 0;
  while (cursor < frames.length) {
    const frame = frames[cursor];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- noUncheckedIndexedAccess 下索引访问可能为 undefined。
    if (frame === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > jsonInputBudget.maxNodes) {
      return budgetViolation("nodes", frames, cursor, `JSON 输入超过节点数上限 ${jsonInputBudget.maxNodes}`);
    }
    const item = frame.value;
    const frameIndex = cursor;
    cursor += 1;
    if (item === null || typeof item !== "object") {
      continue;
    }
    const nextDepth = frame.depth + 1;
    if (nextDepth > jsonInputBudget.maxDepth) {
      return budgetViolation("depth", frames, frameIndex, `JSON 输入超过嵌套深度上限 ${jsonInputBudget.maxDepth}`);
    }
    const isArray = Array.isArray(item);
    if (!isArray && !isJsonObjectShape(item)) {
      return budgetViolation("type", frames, frameIndex, "JSON 输入包含非 JSON 对象（Date、Map、类实例等）");
    }
    const keys = isArray ? null : Object.keys(item);
    const childCount = isArray ? (item as readonly unknown[]).length : (keys ?? []).length;
    // 预算预留必须覆盖「尚未处理但已入队」的帧：否则超宽数组可以先入队再逐层拒绝，
    // 期间的帧分配会远超上限。已入队 + 本次子节点合计超限时直接拒绝。
    const queued = frames.length - cursor;
    if (nodes + queued + childCount > jsonInputBudget.maxNodes) {
      return budgetViolation("nodes", frames, frameIndex, `JSON 输入超过节点数上限 ${jsonInputBudget.maxNodes}`);
    }
    const parentIndex = frameIndex;
    if (isArray) {
      const array = item as readonly unknown[];
      for (let index = 0; index < array.length; index += 1) {
        frames.push({ value: array[index], depth: nextDepth, parent: parentIndex, key: String(index) });
      }
      continue;
    }
    const record = item as { readonly [key: string]: unknown };
    for (const key of keys ?? []) {
      frames.push({ value: record[key], depth: nextDepth, parent: parentIndex, key });
    }
  }
  return null;
}

/** 把预算违规转成 zod issue，让调用方与 schema 失败走同一套错误处理。 */
function budgetIssue(violation: JsonBudgetViolation): { code: "custom"; message: string; path: string[] } {
  return { code: "custom", message: violation.message, path: [...violation.segments] };
}

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

/**
 * 带输入预算的 JSON 值 schema：先以迭代方式检查预算，再做递归结构判定。
 * 用于不可信输入边界（命令 payload、事件 payload、模型工具参数、回执 result），
 * 因此超深输入返回确定的校验失败而不是依赖调用栈深度。
 */
export const boundedJsonValueSchema: z.ZodType<Json> = z
  .unknown()
  .superRefine((input, context) => {
    const violation = checkJsonBudget(input);
    if (violation !== null) {
      context.addIssue(budgetIssue(violation));
    }
  })
  .pipe(jsonValueSchema) as unknown as z.ZodType<Json>;

/** 以字符串键对象表示的 JSON 对象，用于配置块等只接受对象的位置。 */
export const jsonObjectSchema: z.ZodType<{ [key: string]: Json }> = z.record(z.string(), jsonValueSchema);

/** 带输入预算的 JSON 对象 schema；用于不可信边界上只接受对象的位置。 */
export const boundedJsonObjectSchema: z.ZodType<{ [key: string]: Json }> = z
  .unknown()
  .superRefine((input, context) => {
    const violation = checkJsonBudget(input);
    if (violation !== null) {
      context.addIssue(budgetIssue(violation));
    }
  })
  .pipe(jsonObjectSchema) as unknown as z.ZodType<{ [key: string]: Json }>;

/**
 * 生成规范 JSON（键按字典序、无空白），作为哈希与幂等比较的唯一序列化形态。
 * 序列化前先检查输入预算：超限输入抛 TypeError 并指明超出的预算与所在路径，
 * 因此在递归途中不会再出现 RangeError。非有限数字或非 JSON 值同样抛 TypeError，不做隐式转换。
 */
export function canonicalJson(value: Json): string {
  const violation = checkJsonBudget(value);
  if (violation !== null) {
    throw new TypeError(violation.message);
  }
  return serializeCanonical(value);
}

/** 已通过预算检查后按规范形态序列化；递归深度受 jsonInputBudget.maxDepth 约束。 */
function serializeCanonical(value: Json): string {
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
    return `[${value.map(serializeCanonical).join(",")}]`;
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
    return `${JSON.stringify(key)}:${serializeCanonical(item)}`;
  });
  return `{${serialized.join(",")}}`;
}
