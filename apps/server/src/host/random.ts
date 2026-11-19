/**
 * 规则随机源与在线 run 种子的唯一实现：按规则第 11 节由 runSeed 与语义字段派生 sha256 前 8 位，
 * 再生成 mulberry32 序列；在线世界首次启动时生成随机 seed 写入 RunSpec 与 manifest。
 * 依赖 Node crypto；不读全局可变量、不使用 Math.random。
 * 禁止把 taskId、turnId 等随机生成的 ID 放进随机输入，也禁止在规则模块里自行播种。
 */
import { createHash, randomBytes } from "node:crypto";

/** 把任意语义字段序列折叠为 mulberry32 的 uint32 初值：sha256 前 8 个十六进制字符。 */
function seedWord(parts: readonly string[]): number {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

/** 用给定输入序列创建确定性随机序列；相同输入得到相同向量。 */
function rngFromParts(parts: readonly string[]): () => number {
  let state = seedWord(parts);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 规则第 11 节的 rngFor：runSeed 后接语义字段，字段之间以冒号连接。 */
export function rngFor(runSeed: string, ...parts: string[]): () => number {
  return rngFromParts([runSeed, ...parts]);
}

/** 宿主随机端口：调用方必须把 runSeed 放在第一个参数。 */
export function rngFromHostParts(parts: readonly string[]): () => number {
  return rngFromParts(parts);
}

/** 生成在线 run 的随机 seed；16 字节随机数足以区分不同世界，且不含任何业务 ID。 */
export function generateRunSeed(): string {
  return randomBytes(16).toString("hex");
}
