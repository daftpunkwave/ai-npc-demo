/**
 * 核心职责：锁定 estimate-v1 是公共契约里的唯一 token 估算口径。
 * 交互契约：只调用公共契约导出的估值函数，不启动模块、模型或读取存储。
 * 约束与禁忌：不得在这里重新实现字符分类，也不得把估值当作供应商实报 usage。
 */
import { describe, expect, it } from "vitest";
import { estimateModelInputTokens, estimateSystemAndUserTokens, estimateTokens } from "../src/index";

describe("estimate-v1 口径", () => {
  it("中文逐字计 1 token，其余字符每 4 个计 1 token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("水闸")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    // 空格计入非 CJK 字符：5 个非 CJK 字符向上取整为 2 token。
    expect(estimateTokens("水闸 abcd")).toBe(4);
  });

  it("全角标点与 CJK 同口径，不按拉丁字符折算", () => {
    expect(estimateTokens("，。！")).toBe(3);
    expect(estimateTokens("\u3000")).toBe(1);
  });

  it("与把字符数当 token 数的口径不同", () => {
    // 记忆账本曾用 Array.from(text).length：中文恰好一致，拉丁文本则差约 4 倍。
    const latin = "the quick brown fox jumps over the lazy dog";
    expect(estimateTokens(latin)).toBeLessThan(Array.from(latin).length);
    expect(estimateTokens(latin)).toBe(Math.ceil(latin.length / 4));
  });

  it("system 与 user 文本的请求估值包含固定消息开销", () => {
    expect(estimateSystemAndUserTokens("系统", "用户")).toBe(2 + 2 + 4);
  });

  it("工具 schema 与输出协议计入模型输入估值", () => {
    const request = {
      system: "系统",
      messages: [{ role: "user" as const, content: "用户", toolCalls: [] }],
      tools: [],
      output: { kind: "text" as const },
    };
    expect(estimateModelInputTokens(request)).toBe(estimateSystemAndUserTokens("系统", "用户"));
  });
});
