/**
 * 核心职责：为已鉴权的 HTTP 路由提供统一的速率限制，按调用方主体与路由分组计数。
 * 交互契约：由传输层在请求钩子里调用 `check`；键取认证主体（无主体时退化为远端地址），
 * 分组按路由的读写成本区分，写接口阈值显著低于读接口。
 * 约束与禁忌：只在内存中计数，不持久化、不跨进程共享；不记录请求正文或凭据；
 * 超限时明确返回需要等待的秒数，供调用方退避。
 */

/** 路由的成本分组：写接口比读接口更容易被滥用，阈值更低。 */
export type RateLimitGroup = "read" | "write";

/** 一个时间窗口内的允许次数与窗口长度。 */
interface GroupLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * 分组阈值。
 *
 * 读接口允许较高的查询频率；写接口会创建 run、展开实验或导出数据，
 * 单次成本远高于读，因此限制更严。数值按「单人操作节奏」设定：
 * 读接口允许每秒数次轮询，写接口限制到每 10 秒数次。
 */
const groupLimits: Readonly<Record<RateLimitGroup, GroupLimit>> = {
  read: { limit: 60, windowMs: 10_000 },
  write: { limit: 10, windowMs: 10_000 },
};

/** 单个计数桶：窗口起点与已用次数。 */
interface Bucket {
  windowStart: number;
  used: number;
}

/** 限流判定结果：允许时给出剩余次数，拒绝时给出建议等待秒数。 */
export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** 判定某个键在某分组下是否仍可放行，并在允许时消耗一次配额。 */
export interface RateLimiter {
  check(key: string, group: RateLimitGroup, nowMs: number): RateLimitDecision;
  /** 清理已过期的桶，避免长期运行后无界增长。 */
  prune(nowMs: number): void;
}

/**
 * 创建内存限流器。
 *
 * 桶以 `分组:键` 为粒度保存；窗口采用固定窗口计数——实现简单、可预测，
 * 边界处的突发可以接受（这不是计费系统，目标是挡住明显的滥用与热循环）。
 * 每次 `check` 顺带清理过期桶，因此即使调用方不显式 `prune` 也不会无界增长。
 */
export function createRateLimiter(overrides: { readonly read?: number; readonly write?: number } = {}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  // 阈值可覆盖：测试需要密集请求时放宽，生产沿用默认值。
  const limitsFor = (group: RateLimitGroup): GroupLimit => {
    const override = group === "read" ? overrides.read : overrides.write;
    const fallback = groupLimits[group];
    return override === undefined ? fallback : { limit: override, windowMs: fallback.windowMs };
  };

  const pruneExpired = (nowMs: number): void => {
    for (const [key, bucket] of buckets) {
      const group = key.startsWith("write:") ? "write" : "read";
      if (nowMs - bucket.windowStart >= limitsFor(group).windowMs) {
        buckets.delete(key);
      }
    }
  };

  return {
    check(key, group, nowMs) {
      const { limit, windowMs } = limitsFor(group);
      const bucketKey = `${group}:${key}`;
      const existing = buckets.get(bucketKey);
      if (existing === undefined || nowMs - existing.windowStart >= windowMs) {
        // 新窗口：重置计数并放行本次。
        buckets.set(bucketKey, { windowStart: nowMs, used: 1 });
        // 顺带清理，避免桶随不同调用方无限累积。
        if (buckets.size > 1024) pruneExpired(nowMs);
        return { allowed: true, remaining: limit - 1 };
      }
      if (existing.used >= limit) {
        // 窗口已满：给出到下一次可用为止的建议等待时间，向上取整到秒。
        const waitMs = windowMs - (nowMs - existing.windowStart);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
      }
      existing.used += 1;
      return { allowed: true, remaining: limit - existing.used };
    },
    prune(nowMs) {
      pruneExpired(nowMs);
    },
  };
}
