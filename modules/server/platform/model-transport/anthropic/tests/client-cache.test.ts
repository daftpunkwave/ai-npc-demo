/**
 * 验证 Anthropic 客户端缓存的有界淘汰与凭据隔离不变量。
 * 依赖 client-cache 的缓存实现与一个记录构造次数的替身构造器；不访问网络、不启动宿主。
 * 禁止让不同凭据共享客户端实例，也禁止缓存随端点或凭据轮换无界增长。
 */
import { describe, expect, it } from "vitest";
import { anthropicClientKey, createAnthropicClientCache } from "../src/client-cache";
import type Anthropic from "@anthropic-ai/sdk";

interface FakeClient {
  readonly baseURL: string;
  readonly credential: string;
}

/** 记录每次构造，用来断言「同一键只构造一次」与「不同键一定得到不同实例」。 */
function recordingFactory(): {
  readonly factory: (baseURL: string, credential: string) => Anthropic;
  readonly created: FakeClient[];
} {
  const created: FakeClient[] = [];
  return {
    created,
    factory: (baseURL, credential) => {
      const client: FakeClient = { baseURL, credential };
      created.push(client);
      return client as unknown as Anthropic;
    },
  };
}

describe("Anthropic 客户端缓存", () => {
  it("同一端点与凭据只构造一次客户端", () => {
    const { factory, created } = recordingFactory();
    const cache = createAnthropicClientCache(4, factory);
    const first = cache.clientFor("https://api.anthropic.com", "key-a");
    const second = cache.clientFor("https://api.anthropic.com", "key-a");
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(cache.size()).toBe(1);
  });

  it("凭据变化必定重建客户端，不复用旧实例", () => {
    const { factory, created } = recordingFactory();
    const cache = createAnthropicClientCache(4, factory);
    const withKeyA = cache.clientFor("https://api.anthropic.com", "key-a");
    const withKeyB = cache.clientFor("https://api.anthropic.com", "key-b");
    expect(withKeyB).not.toBe(withKeyA);
    expect(created.map((client) => client.credential)).toEqual(["key-a", "key-b"]);
    // 两个凭据各自保留条目：轮换回来仍命中原实例，且不会跨凭据串用。
    expect(cache.clientFor("https://api.anthropic.com", "key-a")).toBe(withKeyA);
    expect(cache.size()).toBe(2);
  });

  it("端点变化同样重建客户端，键同时覆盖两个维度", () => {
    const { factory, created } = recordingFactory();
    const cache = createAnthropicClientCache(4, factory);
    const primary = cache.clientFor("https://api.anthropic.com", "key-a");
    const alternate = cache.clientFor("https://proxy.example.test", "key-a");
    expect(alternate).not.toBe(primary);
    expect(created.map((client) => client.baseURL))
      .toEqual(["https://api.anthropic.com", "https://proxy.example.test"]);
    expect(anthropicClientKey("https://api.anthropic.com", "key-a"))
      .not.toBe(anthropicClientKey("https://proxy.example.test", "key-a"));
  });

  it("缓存有界：超过上限时淘汰最久未使用的条目", () => {
    const { factory } = recordingFactory();
    const cache = createAnthropicClientCache(3, factory);
    cache.clientFor("https://api.anthropic.com", "key-1");
    cache.clientFor("https://api.anthropic.com", "key-2");
    cache.clientFor("https://api.anthropic.com", "key-3");
    expect(cache.size()).toBe(3);

    // 访问 key-1 使其成为最近使用项，随后的新条目应淘汰 key-2。
    cache.clientFor("https://api.anthropic.com", "key-1");
    cache.clientFor("https://api.anthropic.com", "key-4");
    expect(cache.size()).toBe(3);

    // key-2 已被淘汰，必须重建；key-1 仍在缓存中，不应重建。
    const createdBefore = cache.size();
    const keyTwo = cache.clientFor("https://api.anthropic.com", "key-2");
    expect(cache.size()).toBe(createdBefore);
    expect(keyTwo).toBeDefined();
    expect(cache.size()).toBe(3);
  });

  it("无论轮换多少次端点与凭据，缓存都不超过上限", () => {
    const { factory, created } = recordingFactory();
    const cache = createAnthropicClientCache(2, factory);
    for (let index = 0; index < 20; index += 1) {
      cache.clientFor(`https://node-${String(index)}.example.test`, `key-${String(index)}`);
      expect(cache.size()).toBeLessThanOrEqual(2);
    }
    expect(created).toHaveLength(20);
  });

  it("拒绝非正整数的上限，避免退化成无界缓存", () => {
    const { factory } = recordingFactory();
    expect(() => createAnthropicClientCache(0, factory)).toThrow(/正整数/);
    expect(() => createAnthropicClientCache(-1, factory)).toThrow(/正整数/);
    expect(() => createAnthropicClientCache(1.5, factory)).toThrow(/正整数/);
  });
});
