/**
 * 核心职责：验证传输层令牌比较 helper 的相等、长度差异与令牌表查找行为。
 * 交互契约：直接导入 transport 内部 helper；不启动 Fastify、不创建会话或连接。
 * 约束与禁忌：不断言执行耗时，也不依赖随机源或真实网络；恒定性由实现改用 timingSafeEqual 保证。
 */
import { describe, expect, it } from "vitest";
import { findTokenEntry, timingSafeTokenEquals, tokenDigest } from "../src/timing-safe-token";

describe("timingSafeTokenEquals", () => {
  it("完全相同的令牌返回 true", () => {
    expect(timingSafeTokenEquals("player-token", "player-token")).toBe(true);
    expect(timingSafeTokenEquals("", "")).toBe(true);
  });

  it("等长但内容不同返回 false", () => {
    expect(timingSafeTokenEquals("player-token", "player-tokeN")).toBe(false);
    expect(timingSafeTokenEquals("aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaab")).toBe(false);
  });

  it("长度不同返回 false 且不抛错", () => {
    expect(() => timingSafeTokenEquals("player-token", "player-token-long")).not.toThrow();
    expect(timingSafeTokenEquals("player-token", "player-token-long")).toBe(false);
    expect(timingSafeTokenEquals("short", "longer-token")).toBe(false);
  });

  it("按 UTF-8 字节比较多字节内容", () => {
    expect(timingSafeTokenEquals("令牌-一", "令牌-一")).toBe(true);
    expect(timingSafeTokenEquals("令牌-一", "令牌-二")).toBe(false);
  });
});

describe("tokenDigest", () => {
  it("对同一令牌稳定，对不同令牌给出不同摘要", () => {
    expect(tokenDigest("player-token")).toBe(tokenDigest("player-token"));
    expect(tokenDigest("player-token")).not.toBe(tokenDigest("player-tokeN"));
    expect(tokenDigest("player-token")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("findTokenEntry", () => {
  it("返回常量时间比较命中的值，未命中返回 undefined", () => {
    const entries = new Map<string, string>([
      ["player-token", "player-1"],
      ["console-token", "console-admin"],
    ]);

    expect(findTokenEntry(entries, "console-token")).toBe("console-admin");
    expect(findTokenEntry(entries, "player-token")).toBe("player-1");
    expect(findTokenEntry(entries, "player-tokeN")).toBeUndefined();
    expect(findTokenEntry(entries, "player-token-long")).toBeUndefined();
    expect(findTokenEntry(entries, "unknown")).toBeUndefined();
  });
});
