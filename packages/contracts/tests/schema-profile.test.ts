/**
 * 验证面向模型的 JSON Schema 清洗规则与工具名映射。
 * 依赖公共契约包的 schema-profile 导出与 zod 的 toJSONSchema 输出。
 * 禁止发起模型请求；清洗结果只做结构断言。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cleanJsonSchemaForModel,
  createToolNameRegistry,
  isModelToolName,
  toModelToolName,
} from "../src/index";

describe("工具名映射", () => {
  it("点号替换为下划线", () => {
    expect(toModelToolName("world.inspect")).toBe("world_inspect");
    expect(toModelToolName("decision.submit")).toBe("decision_submit");
    expect(toModelToolName("a.b.c")).toBe("a_b_c");
  });

  it("校验工具名形态与长度上限", () => {
    expect(isModelToolName("world_inspect")).toBe(true);
    expect(isModelToolName("A-z_09")).toBe(true);
    expect(isModelToolName("")).toBe(false);
    expect(isModelToolName("a".repeat(64))).toBe(true);
    expect(isModelToolName("a".repeat(65))).toBe(false);
    expect(isModelToolName("has.dot")).toBe(false);
    expect(isModelToolName("with space")).toBe(false);
  });

  it("注册表支持双向映射与未知名字", () => {
    const registry = createToolNameRegistry(["world.inspect", "decision.submit"]);
    expect(registry.wireNames).toEqual(["world_inspect", "decision_submit"]);
    expect(registry.toWireName("world.inspect")).toBe("world_inspect");
    expect(registry.toToolId("decision_submit")).toBe("decision.submit");
    expect(registry.toToolId("unknown_tool")).toBeUndefined();
    expect(() => registry.toWireName("unknown.tool")).toThrow();
  });

  it("拒绝重名、重复注册与非法工具名", () => {
    expect(() => createToolNameRegistry(["a.b", "a_b"])).toThrow();
    expect(() => createToolNameRegistry(["world.inspect", "world.inspect"])).toThrow();
    expect(() => createToolNameRegistry(["bad name"])).toThrow();
    expect(() => createToolNameRegistry([`${"a".repeat(65)}`])).toThrow();
  });
});

describe("JSON Schema 清洗", () => {
  it("对象全部属性必填、禁止额外属性，嵌套对象同样处理", () => {
    const cleaned = cleanJsonSchemaForModel({
      type: "object",
      properties: {
        name: { type: "string" },
        nested: {
          type: "object",
          properties: { flag: { type: "boolean" } },
          additionalProperties: false,
        },
      },
      required: ["name"],
    });
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nested: {
          type: "object",
          properties: { flag: { type: "boolean" } },
          required: ["flag"],
          additionalProperties: false,
        },
      },
      required: ["name", "nested"],
      additionalProperties: false,
    });
  });

  it("删除模型协议不支持的约束关键字", () => {
    const cleaned = cleanJsonSchemaForModel({
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 10,
          pattern: "^a",
          format: "email",
          default: "x",
          description: "名字",
        },
        age: { type: "integer", minimum: 0, maximum: 120, exclusiveMinimum: -1, exclusiveMaximum: 121, multipleOf: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
      },
    });
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "名字" },
        age: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name", "age", "tags"],
      additionalProperties: false,
    });
  });

  it("内联 $ref 并删除 $defs 与 definitions", () => {
    const cleaned = cleanJsonSchemaForModel({
      $defs: {
        Name: { type: "string", minLength: 1 },
      },
      definitions: {
        Count: { type: "integer" },
      },
      type: "object",
      properties: {
        name: { $ref: "#/$defs/Name" },
        count: { $ref: "#/definitions/Count", description: "计数" },
      },
    });
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer", description: "计数" },
      },
      required: ["name", "count"],
      additionalProperties: false,
    });
  });

  it("拒绝递归与未知引用", () => {
    expect(() =>
      cleanJsonSchemaForModel({
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
        $ref: "#/$defs/Node",
      }),
    ).toThrow();
    expect(() => cleanJsonSchemaForModel({ $ref: "#/$defs/Missing" })).toThrow();
    expect(() => cleanJsonSchemaForModel({ $ref: "external-schema.json#/Name" })).toThrow();
  });

  it("oneOf 改写为 anyOf，未知关键字全部删除", () => {
    const cleaned = cleanJsonSchemaForModel({
      type: "object",
      title: "对象",
      examples: [{ name: "x" }],
      properties: {
        choice: { oneOf: [{ type: "string" }, { type: "null" }] },
        union: { anyOf: [{ const: "a" }, { enum: ["b", "c"] }] },
      },
      propertyNames: { pattern: "^a" },
    });
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        choice: { anyOf: [{ type: "string" }, { type: "null" }] },
        union: { anyOf: [{ const: "a" }, { enum: ["b", "c"] }] },
      },
      required: ["choice", "union"],
      additionalProperties: false,
    });
  });

  it("保留可空类型联合与数组元素清洗", () => {
    const cleaned = cleanJsonSchemaForModel({
      type: "object",
      properties: {
        maybe: { type: ["string", "null"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    });
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        maybe: { type: ["string", "null"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["maybe", "items"],
      additionalProperties: false,
    });
  });

  it("清洗 zod 生成的 schema：可选字段进入 required 且不再带 $schema", () => {
    const generated = z.toJSONSchema(
      z
        .object({
          name: z.string().min(1),
          note: z.string().nullable(),
        })
        .strict(),
    );
    const cleaned = cleanJsonSchemaForModel(generated);
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        note: { type: ["string", "null"] },
      },
      required: ["name", "note"],
      additionalProperties: false,
    });
  });

  it("preserves free-form additional properties for record schemas", () => {
    const generated = z.toJSONSchema(z.record(z.string(), z.string()));
    expect(cleanJsonSchemaForModel(generated)).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    });

    expect(
      cleanJsonSchemaForModel({
        type: "object",
        additionalProperties: true,
        description: "Free-form settings",
      }),
    ).toEqual({
      type: "object",
      description: "Free-form settings",
      additionalProperties: true,
    });
  });

  it("preserves implicit free-form object semantics and keeps ordinary objects closed", () => {
    expect(cleanJsonSchemaForModel({ type: "object" })).toEqual({
      type: "object",
      additionalProperties: true,
    });
    expect(cleanJsonSchemaForModel(z.toJSONSchema(z.object({}).passthrough()))).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: {},
    });
    expect(
      () =>
        cleanJsonSchemaForModel({
          type: "object",
          properties: { id: { type: "string" } },
          additionalProperties: { type: "number" },
        }),
    ).toThrow(TypeError);
    expect(cleanJsonSchemaForModel({ additionalProperties: false })).toEqual({
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(cleanJsonSchemaForModel(z.toJSONSchema(z.object({}).strict()))).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("rejects malformed additional properties declarations", () => {
    expect(() =>
      cleanJsonSchemaForModel({
        type: "object",
        additionalProperties: ["not", "a", "schema"],
      }),
    ).toThrow(TypeError);
  });

  it("拒绝非对象根 schema", () => {
    expect(() => cleanJsonSchemaForModel("not-a-schema" as never)).toThrow(TypeError);
    expect(() => cleanJsonSchemaForModel([1] as never)).toThrow(TypeError);
  });
});
