/**
 * 清洗面向模型的 JSON Schema，并维护工具 ID 与线协议工具名的映射。
 * 依赖 JSON 类型；清洗只改变传输形态，模型返回后仍用原始 Zod schema 校验。
 * 禁止在此调用模型、放宽字段约束或接受递归 schema。
 */
import type { Json, JsonSchema } from "./json";

/** 模型协议允许的工具名形态。 */
export const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 清洗后保留的 JSON Schema 关键字白名单。 */
export const modelSchemaAllowedKeywords = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "description",
  "additionalProperties",
] as const;

/** 模型协议不支持、清洗时删除的约束关键字。 */
export const modelSchemaRemovedKeywords = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "format",
  "default",
  "$schema",
] as const;

const allowedKeywordSet = new Set<string>(modelSchemaAllowedKeywords);

/** 工具 ID 转线协议工具名：点号替换为下划线。 */
export function toModelToolName(toolId: string): string {
  return toolId.replaceAll(".", "_");
}

/** 判断字符串是否是合法的模型工具名。 */
export function isModelToolName(value: string): boolean {
  return MODEL_TOOL_NAME_PATTERN.test(value);
}

/** 工具名双向映射；未知名字不会猜测，调用方按未授权工具处理。 */
export interface ToolNameRegistry {
  readonly toolIds: readonly string[];
  readonly wireNames: readonly string[];
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  toWireName(toolId: string): string;
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  toToolId(wireName: string): string | undefined;
}

/**
 * 建立工具 ID 到线协议名的全局唯一映射。
 * 工具名为空、超长、含非法字符或与另一工具冲突时立即抛错，阻止注册。
 */
export function createToolNameRegistry(toolIds: readonly string[]): ToolNameRegistry {
  const byToolId = new Map<string, string>();
  const byWireName = new Map<string, string>();
  const wireNames: string[] = [];
  for (const toolId of toolIds) {
    if (byToolId.has(toolId)) {
      throw new Error(`工具 ID 重复注册: ${toolId}`);
    }
    const wireName = toModelToolName(toolId);
    if (!isModelToolName(wireName)) {
      throw new Error(`工具名不符合模型协议约束: ${toolId} -> ${wireName}`);
    }
    const conflict = byWireName.get(wireName);
    if (conflict !== undefined) {
      throw new Error(`工具名冲突: ${toolId} 与 ${conflict} 都映射到 ${wireName}`);
    }
    byToolId.set(toolId, wireName);
    byWireName.set(wireName, toolId);
    wireNames.push(wireName);
  }
  return {
    toolIds: [...toolIds],
    wireNames,
    toWireName(toolId: string): string {
      const wireName = byToolId.get(toolId);
      if (wireName === undefined) {
        throw new Error(`未注册的工具 ID: ${toolId}`);
      }
      return wireName;
    },
    toToolId(wireName: string): string | undefined {
      return byWireName.get(wireName);
    },
  };
}

function isJsonObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按 JSON Pointer 解析内部 $ref；外部引用直接拒绝。 */
function resolveJsonPointer(root: Json, ref: string): Json {
  if (!ref.startsWith("#")) {
    throw new TypeError(`不支持外部 schema 引用: ${ref}`);
  }
  const pointer = ref.slice(1);
  if (pointer === "") {
    return root;
  }
  if (!pointer.startsWith("/")) {
    throw new TypeError(`不是合法的 JSON Pointer: ${ref}`);
  }
  let current: Json = root;
  for (const token of pointer.slice(1).split("/")) {
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(decoded);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new TypeError(`schema 引用路径不存在: ${ref}`);
      }
      // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件遍历的 schema 键与引用路径，只读访问。
      current = current[index] as Json;
      continue;
    }
    if (!isJsonObject(current) || !Object.hasOwn(current, decoded)) {
      throw new TypeError(`schema 引用路径不存在: ${ref}`);
    }
    // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件遍历的 schema 键与引用路径，只读访问。
    current = current[decoded] as Json;
  }
  return current;
}

/** 内联所有 $ref；递归引用无法安全展开，直接拒绝。 */
function inlineReferences(node: Json, root: Json, stack: readonly string[]): Json {
  if (Array.isArray(node)) {
    return node.map((item) => inlineReferences(item, root, stack));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const ref = node.$ref;
  if (typeof ref === "string") {
    if (stack.includes(ref)) {
      throw new TypeError(`不允许递归 schema: ${ref}`);
    }
    const target = resolveJsonPointer(root, ref);
    const inlined = inlineReferences(target, root, [...stack, ref]);
    const siblings = Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "$ref")
        .map(([key, value]) => [key, inlineReferences(value, root, stack)]),
    );
    return isJsonObject(inlined) ? { ...inlined, ...siblings } : inlined;
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, inlineReferences(value, root, stack)]),
  );
}

/**
 * 把固定属性对象规范为模型 strict profile：全部属性必填并禁止额外属性。
 * 无固定属性的自由对象保留开放语义；strict profile 无法表达的组合直接拒绝。
 * 嵌套对象同样处理，数组元素递归清洗。
 */
function cleanNode(node: Json, path: string): Json {
  if (Array.isArray(node)) {
    return node.map((item, index) => cleanNode(item, `${path}[${index}]`));
  }
  if (!isJsonObject(node)) {
    if (path === "") {
      throw new TypeError("模型 schema 的根必须是对象");
    }
    return node;
  }

  const cleaned: { [key: string]: Json } = {};
  let additionalProperties: Json | undefined;
  let hasAdditionalProperties = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties") {
      if (!isJsonObject(value)) {
        throw new TypeError(`properties 必须是对象: ${path}`);
      }
      cleaned.properties = Object.fromEntries(
        Object.entries(value).map(([name, propertySchema]) => [
          name,
          cleanNode(propertySchema, `${path}.properties.${name}`),
        ]),
      );
      continue;
    }
    if (key === "items") {
      cleaned.items = cleanNode(value, `${path}.items`);
      continue;
    }
    if (key === "oneOf" || key === "anyOf") {
      if (!Array.isArray(value)) {
        throw new TypeError(`${key} 必须是数组: ${path}`);
      }
      const branches = value.map((branch, index) => cleanNode(branch, `${path}.${key}[${index}]`));
      cleaned.anyOf = branches;
      continue;
    }
    if (key === "additionalProperties") {
      if (value !== true && value !== false && !isJsonObject(value)) {
        throw new TypeError(`additionalProperties 必须是布尔值或 schema: ${path}`);
      }
      additionalProperties = value;
      hasAdditionalProperties = true;
      continue;
    }
    if (key === "required" || key === "$defs" || key === "definitions") {
      continue;
    }
    if (allowedKeywordSet.has(key)) {
      // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件遍历的 schema 键与引用路径，只读访问。
      cleaned[key] = value;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
  const hasProperties = cleaned.properties !== undefined;
  const properties = hasProperties
    ? cleaned.properties as { [key: string]: Json }
    : undefined;
  const propertyNames = properties === undefined ? [] : Object.keys(properties);
  if (propertyNames.length > 0 && hasAdditionalProperties && additionalProperties !== false) {
    throw new TypeError(`strict profile 无法表达固定属性与开放 additionalProperties 的组合: ${path}`);
  }
  const allowsAdditionalProperties =
    hasAdditionalProperties &&
    additionalProperties !== undefined &&
    (additionalProperties === true || isJsonObject(additionalProperties));
  const isObjectType = cleaned.type === "object" || hasProperties || hasAdditionalProperties;
  const preservesFreeFormObject =
    propertyNames.length === 0 && (allowsAdditionalProperties || !hasAdditionalProperties);
  if (isObjectType && preservesFreeFormObject) {
    if (properties !== undefined) {
      cleaned.properties = properties;
      cleaned.required = propertyNames;
    }
    // 保留 JSON Schema 的开放对象语义；显式 schema 仍需递归清洗。
    cleaned.additionalProperties =
      additionalProperties === true
        ? true
        : additionalProperties === undefined
          ? true
          : cleanNode(additionalProperties as Json, `${path}.additionalProperties`);
    return cleaned;
  }
  if (isObjectType) {
    cleaned.properties = properties ?? {};
    cleaned.required = propertyNames;
    cleaned.additionalProperties = false;
  }
  return cleaned;
}

/**
 * 把 Zod 生成的 JSON Schema 清洗为模型 strict profile：
 * 内联 $ref、oneOf 改写为 anyOf、对象全部属性必填、删除约束与未知关键字。
 */
export function cleanJsonSchemaForModel(schema: JsonSchema): JsonSchema {
  if (!isJsonObject(schema)) {
    throw new TypeError("模型 schema 必须是 JSON 对象");
  }
  const inlined = inlineReferences(schema, schema, []);
  return cleanNode(inlined, "");
}
