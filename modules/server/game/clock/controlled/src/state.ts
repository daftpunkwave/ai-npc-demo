/**
 * 定义时钟模块的配置类型与存储行读取助手。
 * 依赖公共契约的存储行标量类型；只做类型收窄，不访问数据库。
 * 禁止在行读取时填补缺失值或猜测模式。
 */
import { DomainError } from "@ai-npc/contracts";

/** 时钟配置；与模块描述符的 strict schema 保持同构。 */
export interface ClockConfig {
  readonly secondsPerTick: number;
  readonly maxStepTicks: number;
}

/** 读取非空字符串列。 */
export function requireClockString(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("invalid-state", `clock 列 ${column} 不是非空字符串`, { details: { column } });
  }
  return value;
}

/** 读取非负安全整数列。 */
export function requireClockNumber(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid-state", `clock 列 ${column} 不是非负安全整数`, { details: { column } });
  }
  return value;
}
