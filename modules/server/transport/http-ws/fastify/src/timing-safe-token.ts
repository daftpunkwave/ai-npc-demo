/**
 * 核心职责：为传输层提供常量时间令牌比较、摘要索引键与按令牌查找，避免普通字符串相等泄露比较进度。
 * 交互契约：只比较 UTF-8 字符串令牌；查找目标为有界令牌表（登录身份、会话、票据），未命中返回 undefined。
 * 约束与禁忌：不读写会话状态、不生成或记录令牌内容；长度不同的输入直接判定不相等。
 */
import { createHash, timingSafeEqual } from "node:crypto";

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
 * 计算令牌的 SHA-256 摘要，作为会话与票据表的 O(1) 索引键。
 * 令牌由宿主用随机数据生成，摘要不可预测；摘要只用于定位候选，是否命中仍由原始令牌的常量时间比较决定。
 */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 在令牌表中按常量时间比较查找匹配值。
 * 身份表规模由装配身份数约束，线性扫描不构成热路径；
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
