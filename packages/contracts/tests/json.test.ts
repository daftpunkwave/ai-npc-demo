/**
 * 验证 JSON 值 schema 与规范化序列化。
 * 依赖公共契约包的 json 主题导出。
 * 禁止依赖 Node/DOM 专有对象；断言只使用 JSON 原生值。
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, jsonObjectSchema, jsonValueSchema } from "../src/index";
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
