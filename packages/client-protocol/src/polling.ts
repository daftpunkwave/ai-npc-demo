/**
 * 核心职责：调度浏览器只读轮询：上一次读取结束后才排下一次，连续失败按指数退避，页面不可见时暂停、恢复可见时立即补读（有在途读取时在它结束后补读）。
 * 交互契约：调用方提供接收 AbortSignal 的读取函数、成功间隔与退避上限；页面可见性默认取浏览器 document，可注入替身；计时使用全局 setTimeout。
 * 约束与禁忌：同一轮询任何时刻最多一个在途读取；停止后中止在途读取且不再回调；只用于可重复的读取，不得用来重放写请求。
 */

/** 页面可见性状态：浏览器 `document.visibilityState` 的取值；非浏览器环境为 undefined。 */
export type PageVisibilityState = string | undefined;

/** 页面可见性来源；生产取 document，测试注入替身。 */
export interface PageVisibilitySource {
  current(): PageVisibilityState;
  /** 订阅可见性变化；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
}

export interface PollingOptions {
  /** 执行一次读取：成功时自行消费结果，失败时抛出；signal 在停止轮询时中止。 */
  readonly read: (signal: AbortSignal) => Promise<void>;
  /** 成功后到下一次读取的间隔（毫秒），也是失败退避的基数。 */
  readonly intervalMs: number;
  /** 连续失败时等待间隔的上限（毫秒）。 */
  readonly maxBackoffMs: number;
  /** 成功一次后不再排下一次；用于失败重试直到读到为止的静态数据。 */
  readonly stopAfterSuccess?: boolean;
  /** 读取失败时回调；停止轮询造成的中止不回调。 */
  readonly onError?: (error: unknown) => void;
  readonly visibility?: PageVisibilitySource;
}

export interface PollingHandle {
  /** 尽快再读一次：空闲时立即读取，有在途读取时在它结束后立即补读。页面不可见时推迟到恢复可见。 */
  refresh(): void;
  /** 停止轮询：清除计时器、取消可见性订阅并中止在途读取。 */
  stop(): void;
}

/**
 * 是否允许读取。
 * 只有明确的 `hidden` 与 `prerender` 才暂停：未知状态出现在非浏览器环境或旧实现上，
 * 此时照常读取，避免因为拿不到状态就永久停摆。
 */
export function isPageVisible(state: PageVisibilityState): boolean {
  return state !== "hidden" && state !== "prerender";
}

/** 第 failures 次连续失败后的等待：intervalMs × 2^failures，不超过 maxBackoffMs；成功后回到 intervalMs。 */
export function pollingDelay(intervalMs: number, maxBackoffMs: number, failures: number): number {
  return failures === 0 ? intervalMs : Math.min(maxBackoffMs, intervalMs * 2 ** failures);
}

/**
 * 浏览器 document 的可见性来源。
 * 经 `globalThis` 取 `document` 而不直接引用：本包同时被没有 DOM 库的服务端类型检查覆盖。
 * 非浏览器环境返回恒为未知状态、订阅为空操作的来源。
 */
export function documentVisibility(): PageVisibilitySource {
  const scope = globalThis as {
    readonly document?: {
      readonly visibilityState?: string;
      addEventListener(type: "visibilitychange", handler: () => void): void;
      removeEventListener(type: "visibilitychange", handler: () => void): void;
    };
  };
  const target = scope.document;
  return {
    current: () => target?.visibilityState,
    subscribe(listener) {
      if (target === undefined) return () => undefined;
      target.addEventListener("visibilitychange", listener);
      return () => {
        target.removeEventListener("visibilitychange", listener);
      };
    },
  };
}

/** 立即开始轮询（页面不可见时等到恢复可见再读），返回控制句柄。 */
export function startPolling(options: PollingOptions): PollingHandle {
  const visibility = options.visibility ?? documentVisibility();
  let stopped = false;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let rereadQueued = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const settle = (succeeded: boolean): void => {
    inFlight = null;
    if (stopped) return;
    if (succeeded && options.stopAfterSuccess === true) {
      stop();
      return;
    }
    if (rereadQueued) {
      rereadQueued = false;
      readNow();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      readNow();
    }, pollingDelay(options.intervalMs, options.maxBackoffMs, failures));
  };

  function readNow(): void {
    clearTimer();
    if (stopped || inFlight !== null) return;
    // 不可见时既不读也不排下一次：可见性恢复的回调会立即补读，后台标签页不产生无人接收的流量。
    if (!isPageVisible(visibility.current())) return;
    const controller = new AbortController();
    inFlight = controller;
    // 执行器同步运行，读取仍在本次调用内发出；读取函数同步抛错时执行器把它转成拒绝，与异步失败同样计数退避。
    new Promise<void>((resolve, reject) => {
      options.read(controller.signal).then(resolve, reject);
    }).then(
      () => {
        failures = 0;
        settle(true);
      },
      (error: unknown) => {
        if (!stopped) {
          failures += 1;
          options.onError?.(error);
        }
        settle(false);
      },
    );
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimer();
    unsubscribeVisibility();
    inFlight?.abort();
    inFlight = null;
  }

  /** 尽快再读一次：空闲时立即读取，有在途读取时排一次补读，多次请求合并。 */
  function requestRead(): void {
    if (stopped) return;
    if (inFlight !== null) {
      rereadQueued = true;
      return;
    }
    readNow();
  }

  // 恢复可见时在途的读取发出于隐藏之前，结束后也要立即补读，而不是等到下一个间隔或退避结束。
  const unsubscribeVisibility = visibility.subscribe(() => {
    if (isPageVisible(visibility.current())) requestRead();
  });
  readNow();

  return {
    refresh: requestRead,
    stop,
  };
}
