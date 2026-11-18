/**
 * 提供宿主时间、随机、ID、哈希、日志与 tracer 的最小实现。
 * 依赖 Node 标准库；不读取配置、不打开存储。
 * 禁止把 Math.random 用于规则随机或安全凭据。
 */
import { createHash, randomUUID } from "node:crypto";
import type { HostServices, Json } from "@ai-npc/contracts";

function deterministicRng(seed: string): () => number {
  let state = 0x811c9dc5;
  for (const char of seed) {
    state ^= char.codePointAt(0) ?? 0;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const logger = {
  info: (message: string, data?: Json): void => { console.info(message, data ?? ""); },
  warn: (message: string, data?: Json): void => { console.warn(message, data ?? ""); },
  error: (message: string, data?: Json): void => { console.error(message, data ?? ""); },
};

const tracer = {
  span: <T>(_name: string, _attrs: Json, fn: () => T): T => fn(),
};

/** 创建生产宿主服务；ID 使用随机 UUID 后缀。 */
export function createHostServices(): HostServices {
  return {
    ids: (prefix) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    nowIso: () => new Date().toISOString(),
    monotonicMs: () => performance.now(),
    sleep: async (ms, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("sleep aborted"));
        }, { once: true });
      });
    },
    rng: (...parts) => deterministicRng(parts.join(":")),
    hash: (value) => Promise.resolve(createHash("sha256").update(JSON.stringify(value)).digest("hex")),
    logger,
    tracer,
  };
}
