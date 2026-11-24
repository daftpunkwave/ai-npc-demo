/**
 * 验证 JSON 值 schema、输入预算与规范化序列化。
 * 依赖公共契约包的 json 主题导出。
 * 禁止依赖 Node/DOM 专有对象；断言只使用 JSON 原生值。
 */
import { describe, expect, it } from "vitest";
import {
  boundedJsonObjectSchema,
  boundedJsonValueSchema,
  canonicalJson,
  checkJsonBudget,
  commandEnvelopeSchema,
  jsonInputBudget,
  jsonObjectSchema,
  jsonValueSchema,
  type Json,
} from "../src/index";
import { expectInvalid, expectValid } from "./support";

describe("jsonValueSchema", () => {
  it.each([
    null,
    true,
    false,
    0,
    -1.5,
    "",
    "文本",
    [],
    [1, "a", null, true],
    {},
    { a: 1, b: [null, { c: "d" }] },
  ])("接受合法 JSON 值 %j", (value) => {
    expectValid(jsonValueSchema, value);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    () => 1,
    new Date(0),
    { a: undefined },
    [Number.NaN],
  ])("拒绝非 JSON 值 %j", (value) => {
    expectInvalid(jsonValueSchema, value);
  });

  it("拒绝 BigInt 等非 JSON 原始类型", () => {
    expectInvalid(jsonValueSchema, 1n);
    expectInvalid(jsonValueSchema, Symbol("x"));
  });

  it("JSON 对象 schema 拒绝数组与标量", () => {
    expectValid(jsonObjectSchema, { a: [1, null] });
    expectInvalid(jsonObjectSchema, [1]);
    expectInvalid(jsonObjectSchema, "x");
  });
});

describe("canonicalJson", () => {
  it("键顺序不同的对象输出相同字符串", () => {
    const left = { b: 1, a: { d: [true, null], c: "x" } };
    const right = { a: { c: "x", d: [true, null] }, b: 1 };
    expect(canonicalJson(left)).toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("无空白、数组顺序保留、字符串按 JSON 转义", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ text: 'a"b\nc' })).toBe('{"text":"a\\"b\\nc"}');
    expect(canonicalJson(-0)).toBe("0");
  });

  it("规范化结果可被 JSON.parse 还原且与键序无关", () => {
    const value = { z: null, a: [{ y: 2, x: 1 }] };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it("拒绝非有限数字与非 JSON 值", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson((() => 1) as never)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined } as never)).toThrow(TypeError);
  });
});

/** 按层数构造嵌套数组：每层包一个单元素数组，叶子为 null。 */
function nestedArray(depth: number): Json {
  let value: Json = null;
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

/** 按层数构造嵌套对象：每层一个 `nested` 键，叶子为 null。 */
function nestedObject(depth: number): Json {
  let value: Json = null;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

describe("JSON 输入预算", () => {
  it("不带预算的 jsonValueSchema 与带预算的 boundedJsonValueSchema 结构判定一致", () => {
    // 结构判定必须完全等价：预算只是前置守卫，不能改变合法值的判定结果。
    for (const value of [null, true, 0, "文本", [], [1, "a"], {}, { a: [1, null] }]) {
      expect(jsonValueSchema.safeParse(value).success).toBe(boundedJsonValueSchema.safeParse(value).success);
      expectValid(boundedJsonValueSchema, value);
    }
    for (const value of [undefined, Number.NaN, { a: undefined }, () => 1, new Date(0)]) {
      expectInvalid(jsonValueSchema, value);
      expectInvalid(boundedJsonValueSchema, value);
    }
  });

  it("带预算的 JSON 对象 schema 同时拒绝非对象与超深对象", () => {
    expectValid(boundedJsonObjectSchema, { a: [1, null] });
    expectInvalid(boundedJsonObjectSchema, [1]);
    expectInvalid(boundedJsonObjectSchema, "x");
    expect(boundedJsonObjectSchema.safeParse(nestedObject(jsonInputBudget.maxDepth + 1)).success).toBe(false);
    expect(jsonObjectSchema.safeParse(nestedObject(jsonInputBudget.maxDepth + 1)).success).toBe(true);
  });

  it("深度上限内的嵌套值通过校验并可按规范序列化", () => {
    for (const value of [
      nestedArray(jsonInputBudget.maxDepth),
      nestedObject(jsonInputBudget.maxDepth),
    ]) {
      expectValid(boundedJsonValueSchema, value);
      expect(() => canonicalJson(value)).not.toThrow();
    }
  });

  it("超出深度上限的输入返回校验失败而不是 RangeError", () => {
    const tooDeep = nestedArray(jsonInputBudget.maxDepth + 1);
    const result = boundedJsonValueSchema.safeParse(tooDeep);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("嵌套深度上限");

    // 远超旧实现栈溢出阈值的深度也必须是确定的校验失败。
    expect(boundedJsonValueSchema.safeParse(nestedArray(5_000)).success).toBe(false);
    expect(boundedJsonValueSchema.safeParse(nestedObject(5_000)).success).toBe(false);
  });

  it("超出深度上限时 canonicalJson 抛 TypeError 并指明预算与路径", () => {
    expect(() => canonicalJson(nestedArray(jsonInputBudget.maxDepth + 1))).toThrow(TypeError);
    expect(() => canonicalJson(nestedArray(jsonInputBudget.maxDepth + 1))).toThrow(/嵌套深度上限/);
    expect(() => canonicalJson(nestedArray(5_000))).toThrow(TypeError);
    expect(() => canonicalJson(nestedObject(5_000))).toThrow(TypeError);
  });

  it("命令信封对深层 payload 给出校验失败而不是 500 级的栈溢出", () => {
    const result = commandEnvelopeSchema.safeParse({
      commandId: "cmd-000000000000",
      type: "probe.ask",
      schemaVersion: 1,
      payload: nestedArray(5_000),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("嵌套深度上限");
  });

  it("节点数超限时报告节点预算而不是深度预算", () => {
    // 单层超宽数组：深度只有 1，必须由节点数预算拦下。
    const wide = Array.from({ length: jsonInputBudget.maxNodes + 1 }, () => null as Json);
    const result = boundedJsonValueSchema.safeParse(wide);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("节点数上限");
    expect(() => canonicalJson(wide)).toThrow(/节点数上限/);
  });

  it("预算检查本身不因超深输入抛 RangeError", () => {
    expect(() => checkJsonBudget(nestedArray(100_000))).not.toThrow();
    expect(checkJsonBudget(nestedArray(100_000))?.kind).toBe("depth");
    expect(checkJsonBudget(nestedArray(jsonInputBudget.maxDepth))).toBeNull();
  });

  it("循环引用由深度预算拦下，不会无限展开", () => {
    const cyclic: Record<string, unknown> = { label: "self" };
    cyclic["self"] = cyclic;
    const budget = checkJsonBudget(cyclic);
    expect(budget?.kind).toBe("depth");
    // 带预算的边界 schema 必然拒绝；不带预算的 jsonValueSchema 只做结构判定，不承担循环检测。
    expect(boundedJsonValueSchema.safeParse(cyclic).success).toBe(false);
    expect(() => canonicalJson(cyclic as unknown as Json)).toThrow(TypeError);
    expect(() => canonicalJson(cyclic as unknown as Json)).toThrow(/嵌套深度上限/);
  });

  it("预算检查与规范化序列化对非 JSON 对象给出一致判定", () => {
    for (const value of [new Date(0), new Map(), new Set(), () => 1]) {
      const budget = checkJsonBudget(value);
      if (value instanceof Function) {
        // 函数不是对象分支：结构判定拒绝，预算不拦。
        expect(budget).toBeNull();
        expect(jsonValueSchema.safeParse(value).success).toBe(false);
        expect(() => canonicalJson(value as unknown as Json)).toThrow(TypeError);
        continue;
      }
      expect(budget).not.toBeNull();
      expect(boundedJsonValueSchema.safeParse(value).success).toBe(false);
      expect(() => canonicalJson(value as unknown as Json)).toThrow(TypeError);
      expect(() => canonicalJson(value as unknown as Json)).toThrow(/非 JSON 对象/);
    }
    // 嵌套位置的非 JSON 对象同样被拒绝，不会在序列化时被悄悄写成 {}。
    expect(checkJsonBudget({ when: new Date(0) })?.kind).toBe("type");
    expect(() => canonicalJson({ when: new Date(0) } as unknown as Json)).toThrow(/非 JSON 对象/);
  });

  it("节点预算预留计入已入队但未处理的帧", () => {
    // 单层超宽数组：子节点在展开时一次性入队，必须按「已入队 + 新增」提前拒绝，
    // 否则会先分配远超上限的帧再逐层拒绝。
    const wide = Array.from({ length: jsonInputBudget.maxNodes + 1 }, () => null as Json);
    const budget = checkJsonBudget(wide);
    expect(budget?.kind).toBe("nodes");
    // 每层都挂一个接近上限的宽数组时，第二层展开就应被总量拦下。
    const nested = [wide.slice(0, 1_000), Array.from({ length: 1_000 }, () => null as Json)];
    expect(checkJsonBudget(nested)).toBeNull();
  });
});
