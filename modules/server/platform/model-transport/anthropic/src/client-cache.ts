/**
 * Anthropic SDK 客户端的有界缓存：按端点与凭据隔离并复用客户端。
 * 依赖 Anthropic SDK 构造器与已校验的端点 URL；不发起请求、不读取配置或密钥。
 * 禁止无界缓存，也禁止只按端点或只按凭据做键——任一维度变化都必须重建客户端。
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface CachedAnthropicClient {
  readonly credential: string;
  readonly client: Anthropic;
}

/** 缓存条目的逻辑键：端点与凭据任一变化即视为不同客户端。 */
export function anthropicClientKey(baseURL: string, credential: string): string {
  return `${baseURL}\u0000${credential}`;
}

/**
 * 创建有界客户端缓存。
 * 命中时刷新插入序（Map 保持插入顺序），淘汰最久未使用的条目，
 * 因此缓存大小始终不超过 `maxEntries`，不随端点或凭据轮换无限堆积连接池。
 */
export function createAnthropicClientCache(
  maxEntries: number,
  create: (baseURL: string, credential: string) => Anthropic,
): {
  clientFor(baseURL: string, credential: string): Anthropic;
  size(): number;
} {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`Anthropic 客户端缓存上限必须是正整数，收到 ${String(maxEntries)}`);
  }
  const entries = new Map<string, CachedAnthropicClient>();
  return {
    clientFor(baseURL: string, credential: string): Anthropic {
      const key = anthropicClientKey(baseURL, credential);
      const existing = entries.get(key);
      if (existing !== undefined) {
        entries.delete(key);
        entries.set(key, existing);
        return existing.client;
      }
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      const client = create(baseURL, credential);
      entries.set(key, { credential, client });
      return client;
    },
    size: () => entries.size,
  };
}
