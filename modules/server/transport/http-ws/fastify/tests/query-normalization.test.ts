/**
 * 核心职责：验证查询参数规范化与共享 schema 校验的边界——非法整数、未知字段、重复键与非字符串值都被拒绝，合法值保留 schema 默认值。
 * 交互契约：直接导入路由 helper 与公共查询 schema；不启动 Fastify、不访问存储。
 * 约束与禁忌：不得把「非法值被静默替换为默认值」当成通过，也不得为迁就实现放宽断言。
 */
import { describe, expect, it } from "vitest";
import { agentsQuerySchema, timelineQuerySchema } from "@ai-npc/contracts";
import { normalizeQuery, parseQuery } from "../src/routes/query";

describe("normalizeQuery", () => {
  it("把数字串转换为数字，把逗号列表转换为去空白的数组", () => {
    const normalized = normalizeQuery({ fromSeq: "12", limit: "50", types: "A, B ,C" });
    expect(normalized.invalid).toBe(false);
    expect(normalized.value).toEqual({ fromSeq: 12, limit: 50, types: ["A", "B", "C"] });
  });

  it("非整数与空串不归一为 0，而是留给 schema 拒绝", () => {
    // Number("") 与 Number(" ") 都是 0；若直接转换会把「未提供值」误当成 0。
    expect(normalizeQuery({ fromSeq: "" }).value).toEqual({ fromSeq: null });
    expect(normalizeQuery({ fromSeq: "  " }).value).toEqual({ fromSeq: null });
    expect(normalizeQuery({ limit: "abc" }).value).toEqual({ limit: null });
    expect(normalizeQuery({ limit: "1.5" }).value).toEqual({ limit: null });
  });

  it("重复查询键（Fastify 给出数组）标记为非法，而不是取其中一个", () => {
    const normalized = normalizeQuery({ branchId: ["br-a", "br-b"] });
    expect(normalized.invalid).toBe(true);
  });

  it("纯空白文本按非法值保留，交给 schema 拒绝", () => {
    expect(normalizeQuery({ branchId: "   " }).value).toEqual({ branchId: null });
    expect(normalizeQuery({ branchId: " br-1 " }).value).toEqual({ branchId: "br-1" });
  });
});

describe("parseQuery", () => {
  it("合法输入返回 schema 解析结果并补齐默认值", () => {
    const parsed = parseQuery(timelineQuerySchema, { branchId: "br-1" });
    expect(parsed).toMatchObject({ branchId: "br-1", fromSeq: 0, limit: 100 });
  });

  it("非法 fromSeq、limit 与 order 都返回 null", () => {
    expect(parseQuery(timelineQuerySchema, { fromSeq: "-1" })).toBeNull();
    expect(parseQuery(timelineQuerySchema, { limit: "0" })).toBeNull();
    expect(parseQuery(timelineQuerySchema, { limit: "201" })).toBeNull();
    expect(parseQuery(timelineQuerySchema, { order: "sideways" })).toBeNull();
  });

  it("超过契约上限的 types 返回 null，恰好达上限通过", () => {
    const atLimit = Array.from({ length: 20 }, (_, index) => `event.${index}`).join(",");
    const overLimit = Array.from({ length: 21 }, (_, index) => `event.${index}`).join(",");
    expect(parseQuery(timelineQuerySchema, { types: atLimit })).not.toBeNull();
    expect(parseQuery(timelineQuerySchema, { types: overLimit })).toBeNull();
  });

  it("超过单元素长度上限的 types 返回 null", () => {
    expect(parseQuery(timelineQuerySchema, { types: "a".repeat(65) })).toBeNull();
    expect(parseQuery(timelineQuerySchema, { types: "a".repeat(64) })).not.toBeNull();
  });

  it("未知查询键被 schema 的 strict 拒绝", () => {
    expect(parseQuery(timelineQuerySchema, { unexpected: "1" })).toBeNull();
    expect(parseQuery(agentsQuerySchema, { unexpected: "1", branchId: "br-1" })).toBeNull();
  });

  it("agents 查询缺失或空 branchId 时返回 null", () => {
    expect(parseQuery(agentsQuerySchema, {})).toBeNull();
    expect(parseQuery(agentsQuerySchema, { branchId: "" })).toBeNull();
    expect(parseQuery(agentsQuerySchema, { branchId: "   " })).toBeNull();
    expect(parseQuery(agentsQuerySchema, { branchId: "br-1" })).toEqual({ branchId: "br-1" });
  });
});
