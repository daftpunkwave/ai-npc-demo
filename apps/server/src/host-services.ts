/**
 * 提供宿主时间、随机、ID、哈希、日志与 tracer 的最小实现。
 * 依赖 Node 标准库；不读取配置、不打开存储。
 * 禁止把 Math.random 用于规则随机或安全凭据。
 */
import { createHash, randomBytes } from "node:crypto";
import type { HostServices, Json } from "@ai-npc/contracts";

const idAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function runtimeIdBody(): string {
  let body = "";
  while (body.length < 12) {
    for (const byte of randomBytes(16)) {
      if (byte < 224) {
        body += idAlphabet[byte % idAlphabet.length];
      }
      if (body.length === 12) {
        break;
      }
    }
  }
  return body;
}

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
    ids: (prefix) => `${prefix}-${runtimeIdBody()}`,
    nowIso: () => new Date().toISOString(),
    monotonicMs: () => performance.now(),
    sleep: async (ms, signal) => {
      if (signal?.aborted === true) {
        throw new Error("sleep aborted");
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error("sleep aborted"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    rng: (...parts) => deterministicRng(parts.join(":")),
    hash: (value) => Promise.resolve(createHash("sha256").update(JSON.stringify(value)).digest("hex")),
    logger,
    tracer,
  };
}
