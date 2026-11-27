/**
 * 核心职责：验证只读轮询调度：结束后再排、失败退避、页面不可见时暂停、停止时中止、补读请求合并。
 * 交互契约：注入可控的读取函数与可见性替身，用假计时器推进间隔。
 * 约束与禁忌：不访问网络与真实 document；每个用例结束都恢复真实计时器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPageVisible,
  pollingDelay,
  startPolling,
  type PageVisibilitySource,
  type PageVisibilityState,
} from "../src/polling";

interface PendingRead {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

/** 每次读取都挂起，直到用例显式结束它。 */
function controlledReads(): { readonly read: (signal: AbortSignal) => Promise<void>; readonly calls: PendingRead[] } {
  const calls: PendingRead[] = [];
  return {
    calls,
    read: (signal) => new Promise<void>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    }),
  };
}

function fakeVisibility(initial: PageVisibilityState): {
  readonly source: PageVisibilitySource;
  readonly set: (next: PageVisibilityState) => void;
  readonly listenerCount: () => number;
} {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      current: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("页面可见性判定", () => {
  it("可见与未知状态读取，后台与预渲染暂停", () => {
    expect(isPageVisible("visible")).toBe(true);
    expect(isPageVisible(undefined)).toBe(true);
    expect(isPageVisible("hidden")).toBe(false);
    expect(isPageVisible("prerender")).toBe(false);
  });
});

describe("退避间隔", () => {
  it("成功用基础间隔，连续失败翻倍并封顶", () => {
    expect([0, 1, 2, 3, 4, 5, 60].map((failures) => pollingDelay(2_000, 30_000, failures)))
      .toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe("只读轮询调度", () => {
  it("上一次读取未结束时不发起下一次，结束后按间隔再读", async () => {
    const { read, calls } = controlledReads();
    const polling = startPolling({ read, intervalMs: 2_000, maxBackoffMs: 30_000, visibility: fakeVisibility("visible").source });
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);

    calls[0]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    polling.stop();
  });

  it("失败时回调并指数退避，成功后回到基础间隔", async () => {
    const { read, calls } = controlledReads();
    const onError = vi.fn();
    const polling = startPolling({
      read, intervalMs: 1_000, maxBackoffMs: 3_000, onError, visibility: fakeVisibility("visible").source,
    });
    const failure = new Error("服务不可用");

    calls[0]?.reject(failure);
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    calls[1]?.reject(failure);
    await flush();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    calls[2]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(4);
    expect(onError).toHaveBeenCalledTimes(2);
    polling.stop();
  });

  it("读取函数同步抛错同样按失败退避", async () => {
    const failure = new Error("同步失败");
    const read = vi.fn<(signal: AbortSignal) => Promise<void>>(() => {
      throw failure;
    });
    const onError = vi.fn();
    const polling = startPolling({ read, intervalMs: 1_000, maxBackoffMs: 8_000, onError, visibility: fakeVisibility("visible").source });
    expect(read).toHaveBeenCalledTimes(1);

    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    // 第一次失败后按 2 倍基础间隔退避，而不是按成功间隔或立即重读。
    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await flush();
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    polling.stop();
  });

  it("页面不可见时不读取，恢复可见立即补读", async () => {
    const { read, calls } = controlledReads();
    const visibility = fakeVisibility("hidden");
    const polling = startPolling({ read, intervalMs: 2_000, maxBackoffMs: 30_000, visibility: visibility.source });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);

    visibility.set("visible");
    expect(calls).toHaveLength(1);
    calls[0]?.resolve();
    await flush();

    visibility.set("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    visibility.set("visible");
    expect(calls).toHaveLength(2);
    polling.stop();
  });

  it("等待间隔中恢复可见时立即补读并取消原计时器，不重复读取", async () => {
    const { read, calls } = controlledReads();
    const visibility = fakeVisibility("visible");
    const polling = startPolling({ read, intervalMs: 2_000, maxBackoffMs: 30_000, visibility: visibility.source });
    calls[0]?.resolve();
    await flush();

    visibility.set("hidden");
    visibility.set("visible");
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    polling.stop();
  });

  it("恢复可见时隐藏前发出的读取仍在途，结束后立即补读一次，此后回到正常间隔", async () => {
    const { read, calls } = controlledReads();
    const visibility = fakeVisibility("visible");
    const polling = startPolling({ read, intervalMs: 2_000, maxBackoffMs: 30_000, visibility: visibility.source });

    visibility.set("hidden");
    visibility.set("visible");
    expect(calls).toHaveLength(1);
    calls[0]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);

    calls[1]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    polling.stop();
  });

  it("在途时多次恢复可见与补读请求合并为结束后的一次读取", async () => {
    const { read, calls } = controlledReads();
    const visibility = fakeVisibility("visible");
    const polling = startPolling({ read, intervalMs: 5_000, maxBackoffMs: 30_000, visibility: visibility.source });

    visibility.set("hidden");
    visibility.set("visible");
    visibility.set("hidden");
    visibility.set("visible");
    polling.refresh();
    calls[0]?.reject(new Error("隐藏前的读取失败"));
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);
    polling.stop();
  });

  it("排队的补读在页面再次隐藏时推迟到恢复可见，不重复读取", async () => {
    const { read, calls } = controlledReads();
    const visibility = fakeVisibility("visible");
    const polling = startPolling({ read, intervalMs: 2_000, maxBackoffMs: 30_000, visibility: visibility.source });

    visibility.set("hidden");
    visibility.set("visible");
    visibility.set("hidden");
    calls[0]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);

    visibility.set("visible");
    expect(calls).toHaveLength(2);
    calls[1]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);
    polling.stop();
  });

  it("停止时中止在途读取，此后不再回调、不再读取，并清理计时器与订阅", async () => {
    const { read, calls } = controlledReads();
    const onError = vi.fn();
    const visibility = fakeVisibility("visible");
    const polling = startPolling({ read, intervalMs: 2_000, maxBackoffMs: 30_000, onError, visibility: visibility.source });
    const signal = calls[0]?.signal;
    expect(signal?.aborted).toBe(false);

    polling.stop();
    expect(signal?.aborted).toBe(true);
    calls[0]?.reject(signal?.reason);
    await vi.advanceTimersByTimeAsync(60_000);
    visibility.set("visible");
    polling.refresh();

    expect(onError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(visibility.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("空闲时补读请求立即读取并取消等待中的计时器", async () => {
    const { read, calls } = controlledReads();
    const polling = startPolling({ read, intervalMs: 5_000, maxBackoffMs: 30_000, visibility: fakeVisibility("visible").source });
    calls[0]?.resolve();
    await flush();

    polling.refresh();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    polling.stop();
  });

  it("在途时的多次补读请求合并为结束后的一次读取", async () => {
    const { read, calls } = controlledReads();
    const polling = startPolling({ read, intervalMs: 5_000, maxBackoffMs: 30_000, visibility: fakeVisibility("visible").source });

    polling.refresh();
    polling.refresh();
    expect(calls).toHaveLength(1);
    calls[0]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);
    polling.stop();
  });

  it("成功一次即停止的读取在失败时退避重试，成功后不再读取", async () => {
    const { read, calls } = controlledReads();
    const visibility = fakeVisibility("visible");
    startPolling({
      read, intervalMs: 3_000, maxBackoffMs: 30_000, stopAfterSuccess: true, visibility: visibility.source,
    });
    calls[0]?.reject(new Error("内容暂不可读"));
    await flush();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toHaveLength(2);

    calls[1]?.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    visibility.set("visible");
    expect(calls).toHaveLength(2);
    expect(visibility.listenerCount()).toBe(0);
  });
});
