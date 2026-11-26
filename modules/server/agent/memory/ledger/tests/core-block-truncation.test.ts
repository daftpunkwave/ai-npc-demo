/**
 * 核心职责：锁定分层混合记忆核心块按 estimate-v1 token 预算裁剪的行为。
 * 交互契约：只调用导出的裁剪函数与公共契约的估值函数，不启动模块或读取存储。
 * 约束与禁忌：不得按字符数断言预算，也不得接受短于最长可容纳前缀的结果。
 */
import { describe, expect, it } from "vitest";
import { estimateTokens } from "@ai-npc/contracts";
import { truncateCoreBlock } from "../src/layered-hybrid-port";

describe("核心块按 token 预算裁剪", () => {
  it("未超预算时原样返回", () => {
    expect(truncateCoreBlock("水闸", 10)).toBe("水闸");
    expect(truncateCoreBlock("the quick brown fox", 100)).toBe("the quick brown fox");
  });

  it("中文按每字一个 token 裁剪", () => {
    const text = "水".repeat(50);
    expect(estimateTokens(truncateCoreBlock(text, 10))).toBeLessThanOrEqual(10);
    expect(truncateCoreBlock(text, 10)).toBe("水".repeat(10));
  });

  it("拉丁文本按每 4 字符一个 token 裁剪，不再按字符数切", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const truncated = truncateCoreBlock(text, 3);
    // 3 token 可容纳 12 个拉丁字符；按字符切片会只剩 3 个字符。
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(3);
    expect(truncated.length).toBe(12);
    expect(truncated).toBe(text.slice(0, 12));
  });

  it("混合语言返回放得下的最长前缀", () => {
    const text = "水闸abc水闸def水闸";
    for (const budget of [1, 2, 3, 5, 8]) {
      const truncated = truncateCoreBlock(text, budget);
      expect(estimateTokens(truncated)).toBeLessThanOrEqual(budget);
      // 再延长一个字符就会超预算，说明取到的是最长前缀而不是保守截断。
      if (truncated.length < Array.from(text).length) {
        const next = Array.from(text).slice(0, Array.from(truncated).length + 1).join("");
        expect(estimateTokens(next)).toBeGreaterThan(budget);
      }
    }
  });

  it("预算为零时返回空串", () => {
    expect(truncateCoreBlock("水闸", 0)).toBe("");
  });
});
