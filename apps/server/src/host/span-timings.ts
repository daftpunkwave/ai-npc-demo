/**
 * 核心职责：作为宿主 tracer 的生产实现，按 span 名称在进程内汇总同步回调的耗时，供控制台健康页读取热路径耗时。
 * 交互契约：span 用注入的单调时钟计时；回调抛错时照样记录耗时、计入失败次数，再把原错误抛出。每个名称只保留
 *   最近 windowSize 个样本；summaries 按名称排序，给出自进程启动以来的次数与失败次数，以及窗口内的最近值、
 *   中位数、p95 与最大值（毫秒）。
 * 约束与禁忌：只在内存中保存，不写存储、不做 I/O，进程重启即清零；不保存 attrs。名称数量有上限，超出上限的新名称
 *   只执行回调、不再登记，防止调用方拼接动态名称让内存无界增长。
 */
import type { ConsoleHotPathTiming, HostTracer, Json } from "@world-prism/contracts";

export interface SpanTimingsOptions {
  /** 单调毫秒时钟；生产使用 performance.now，测试注入可控时钟。 */
  readonly now: () => number;
  /** 每个名称保留的最近样本数。 */
  readonly windowSize?: number;
  /** 可登记的名称上限。 */
  readonly maxNames?: number;
}

export interface SpanTimings extends HostTracer {
  summaries(): readonly ConsoleHotPathTiming[];
}

const defaultWindowSize = 256;
const defaultMaxNames = 32;

/** 单个名称的样本环：容量固定，写满后覆盖最旧样本。 */
interface SpanSeries {
  readonly samples: Float64Array;
  filled: number;
  next: number;
  count: number;
  errors: number;
  lastMs: number;
}

/** 输出保留到微秒，既足够分辨热路径变化，也不把浮点噪声带进响应。 */
function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 最近秩百分位：取排序后第 ceil(q·n) 个样本，不插值，结果一定是真实出现过的耗时。 */
function percentile(sorted: Float64Array, quantile: number): number {
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1] ?? 0;
}

export function createSpanTimings(options: SpanTimingsOptions): SpanTimings {
  const windowSize = options.windowSize ?? defaultWindowSize;
  const maxNames = options.maxNames ?? defaultMaxNames;
  if (!Number.isSafeInteger(windowSize) || windowSize < 1) {
    throw new RangeError("耗时窗口必须是正整数");
  }
  if (!Number.isSafeInteger(maxNames) || maxNames < 1) {
    throw new RangeError("耗时名称上限必须是正整数");
  }
  const series = new Map<string, SpanSeries>();

  const seriesFor = (name: string): SpanSeries | undefined => {
    const existing = series.get(name);
    if (existing !== undefined || series.size >= maxNames) {
      return existing;
    }
    const created: SpanSeries = {
      samples: new Float64Array(windowSize),
      filled: 0,
      next: 0,
      count: 0,
      errors: 0,
      lastMs: 0,
    };
    series.set(name, created);
    return created;
  };

  const record = (name: string, elapsedMs: number, failed: boolean): void => {
    const target = seriesFor(name);
    if (target === undefined) {
      return;
    }
    // 时钟回拨或注入时钟异常时按 0 记，不让负耗时污染百分位。
    const value = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    target.samples[target.next] = value;
    target.next = (target.next + 1) % windowSize;
    target.filled = Math.min(target.filled + 1, windowSize);
    target.count += 1;
    target.lastMs = value;
    if (failed) {
      target.errors += 1;
    }
  };

  return {
    span<T>(name: string, _attrs: Json, fn: () => T): T {
      const startedAt = options.now();
      let failed = true;
      try {
        const result = fn();
        failed = false;
        return result;
      } finally {
        record(name, options.now() - startedAt, failed);
      }
    },
    summaries(): readonly ConsoleHotPathTiming[] {
      return [...series.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, entry]) => {
          const window = entry.samples.slice(0, entry.filled).sort();
          return {
            name,
            count: entry.count,
            errors: entry.errors,
            samples: entry.filled,
            lastMs: roundMs(entry.lastMs),
            p50Ms: roundMs(percentile(window, 0.5)),
            p95Ms: roundMs(percentile(window, 0.95)),
            maxMs: roundMs(window[window.length - 1] ?? 0),
          };
        });
    },
  };
}
