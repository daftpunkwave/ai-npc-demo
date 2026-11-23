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

/** 一条预算违规：kind 区分深度与节点数两种超限，path 给出可定位的容器路径。 */
export interface JsonBudgetViolation {
  readonly kind: "depth" | "nodes";
  readonly message: string;
  readonly path: string;
  /** 违规所在的路径段；可直接用作 zod issue 的 path。 */
  readonly segments: readonly string[];
}

/**
 * 显式栈帧：只保存父帧下标与在本层的键，避免为每个节点复制一份路径数组。
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

/** 把路径段渲染成诊断文本。 */
function formatPath(segments: readonly string[]): string {
  if (segments.length === 0) {
    return "$";
  }
  return `$${segments
    .map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `[${JSON.stringify(segment)}]`))
    .join("")}`;
}

function violation(
  kind: JsonBudgetViolation["kind"],
  frames: readonly BudgetFrame[],
  index: number,
): JsonBudgetViolation {
  const segments = pathSegments(frames, index);
  const limit = kind === "depth" ? `嵌套深度上限 ${jsonInputBudget.maxDepth}` : `节点数上限 ${jsonInputBudget.maxNodes}`;
  return {
    kind,
    segments,
    path: formatPath(segments),
    message: `JSON 输入超过${limit}（路径 ${formatPath(segments)}）`,
  };
}

/**
 * 以显式栈迭代遍历待校验值，检查深度与节点预算；返回第一条违规，全部通过时返回 null。
 * 只做结构与预算判断，不判断「是不是合法 JSON 值」——非普通对象（Date、Map、类实例等）
 * 留给 schema 报类型错误，避免两处重复维护类型规则。
 * 展开容器前先按子节点数预留预算，因此超宽数组不会先把整个子节点表压进栈。
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
      return violation("nodes", frames, cursor);
    }
    const item = frame.value;
    cursor += 1;
    if (item === null || typeof item !== "object") {
      continue;
    }
    const nextDepth = frame.depth + 1;
    if (nextDepth > jsonInputBudget.maxDepth) {
      return violation("depth", frames, cursor - 1);
    }
    const isArray = Array.isArray(item);
    const keys = isArray ? null : Object.keys(item);
    if (keys !== null) {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        // 非普通对象不是 JSON 值：跳过展开，由 schema 的类型判定给出错误。
        continue;
      }
    }
    const childCount = isArray ? (item as readonly unknown[]).length : (keys ?? []).length;
    if (nodes + childCount > jsonInputBudget.maxNodes) {
      // 子节点本身就必然超预算：直接报告，避免把超大子节点表压进栈。
      return { ...violation("nodes", frames, cursor - 1), message: "JSON 输入超过节点数上限 " + jsonInputBudget.maxNodes };
    }
    const parentIndex = cursor - 1;
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
function budgetIssue(budgetViolation: JsonBudgetViolation): { code: "custom"; message: string; path: string[] } {
  return {
    code: "custom",
    message: budgetViolation.message,
    path: [...budgetViolation.segments],
  };
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
 * 用于不可信输入边界（命令 payload、事件 payload、模型工具参数），
 * 因此超深输入返回确定的校验失败而不是依赖调用栈深度。
 */
export const boundedJsonValueSchema: z.ZodType<Json> = z
  .unknown()
  .superRefine((input, context) => {
    const budgetViolation = checkJsonBudget(input);
    if (budgetViolation !== null) {
      context.addIssue(budgetIssue(budgetViolation));
    }
  })
  .pipe(jsonValueSchema) as unknown as z.ZodType<Json>;

/** 以字符串键对象表示的 JSON 对象，用于配置块等只接受对象的位置。 */
export const jsonObjectSchema: z.ZodType<{ [key: string]: Json }> = z.record(z.string(), jsonValueSchema);

/** 带输入预算的 JSON 对象 schema；用于不可信边界上只接受对象的位置。 */
export const boundedJsonObjectSchema: z.ZodType<{ [key: string]: Json }> = z
  .unknown()
  .superRefine((input, context) => {
    const budgetViolation = checkJsonBudget(input);
    if (budgetViolation !== null) {
      context.addIssue(budgetIssue(budgetViolation));
    }
  })
  .pipe(jsonObjectSchema) as unknown as z.ZodType<{ [key: string]: Json }>;

/**
 * 生成规范 JSON（键按字典序、无空白），作为哈希与幂等比较的唯一序列化形态。
 * 序列化前先检查输入预算：超限输入抛 TypeError 并指明超出的预算与所在路径，
 * 因此在递归途中不会再出现 RangeError。非有限数字或非 JSON 值同样抛 TypeError，不做隐式转换。
 */
export function canonicalJson(value: Json): string {
  const budgetViolation = checkJsonBudget(value);
  if (budgetViolation !== null) {
    throw new TypeError(budgetViolation.message);
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
