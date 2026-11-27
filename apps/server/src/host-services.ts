/**
 * 提供宿主时间、随机、ID、哈希、日志与 tracer 的最小实现，供 kernel 与模块在注入边界内使用。
 * 依赖 Node 标准库、公共契约的规范 JSON 与规则随机源；不读取配置、不打开存储、不启动监听。
 * 禁止把 Math.random 用于规则随机或安全凭据，也禁止用原始 JSON.stringify 计算摘要。
 */
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, type HostServices, type Json } from "@world-prism/contracts";
import { rngFromHostParts } from "./host/random";

const idAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";

/** ID 主体：丢弃 ≥224 的字节以消除取模偏差，其余按模 32 映射到 32 元字符集，够 12 位即停止。 */
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

/**
 * kernel 摘要端口：输入已是规范 JSON 文本，只在这里执行具体哈希算法。
 * 装配、目录、模块配置与 manifest 摘要都经同一入口，保证键顺序无关且算法一致。
 */
export function canonicalHasher(canonicalJsonText: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(canonicalJsonText).digest("hex"));
}

const logger = {
  info: (message: string, data?: Json): void => { console.info(message, data ?? ""); },
  warn: (message: string, data?: Json): void => { console.warn(message, data ?? ""); },
  error: (message: string, data?: Json): void => { console.error(message, data ?? ""); },
};

const tracer = {
  span: <T>(_name: string, _attrs: Json, fn: () => T): T => fn(),
};

/** 创建生产宿主服务；ID 主体为 12 位小写 base32，哈希统一走规范 JSON。 */
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
    rng: (...parts) => rngFromHostParts(parts),
    hash: (value) => canonicalHasher(canonicalJson(value)),
    hashText: canonicalHasher,
    logger,
    tracer,
  };
}
