/**
 * 提供指标展示等级的统一判定：0–100 数值到危急/紧张/稳定等级的映射。
 * 依赖公共契约的展示等级类型；只做纯函数判定，不读写世界状态或事件。
 * 禁止在此复制多份阈值、引入世界模块实现或扩展指标语义。
 */
import type { MeterDisplayLevel } from "@world-prism/contracts";

/** 指标展示等级：≤20 危急、21–39 紧张、≥40 稳定。 */
export function meterLevel(value: number): MeterDisplayLevel {
  if (value <= 20) {
    return "critical";
  }
  return value <= 39 ? "strained" : "stable";
}
