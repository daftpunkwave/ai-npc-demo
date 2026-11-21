/**
 * 核心职责：为传输层提供常量时间令牌比较与按令牌查找，避免普通字符串相等泄露比较进度。
 * 交互契约：只比较 UTF-8 字符串令牌；查找目标为有界令牌表（登录身份、会话、票据），未命中返回 undefined。
 * 约束与禁忌：不读写会话状态、不生成或记录令牌内容；长度不同的输入直接判定不相等。
 */
import { timingSafeEqual } from "node:crypto";

/** 常量时间比较两个令牌；长度不同直接返回 false，避免 timingSafeEqual 抛错。 */
export function timingSafeTokenEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * 在令牌表中按常量时间比较查找匹配值。
 * 表规模由身份、会话与票据容量上限约束，线性扫描不构成热路径；
 * 逐项比较使用 timingSafeTokenEquals，不依赖 Map 键或字符串的普通相等。
 */
export function findTokenEntry<T>(entries: ReadonlyMap<string, T>, token: string): T | undefined {
  for (const [candidate, value] of entries) {
    if (timingSafeTokenEquals(candidate, token)) {
      return value;
    }
  }
  return undefined;
}
