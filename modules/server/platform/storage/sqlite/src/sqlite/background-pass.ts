/**
 * 核心职责：为存储适配器的后台轮次提供统一调度：立即排入首轮，每轮结束后隔固定间隔再排下一轮，并提供批与批之间让出事件循环的等待。
 * 交互契约：轮次函数接收中止信号并返回 Promise；单轮失败交给调用方的错误回调记录，下一轮照常排入；定时器 unref，不单独让进程保持存活。
 * 约束与禁忌：轮次之间不得重叠；stop 之后不得再排入新轮次，进行中的轮次经中止信号在下一次让出之前停止。
 */

/** 已启动的后台轮次调度；stop 清除定时器并中止进行中的一轮。 */
export interface BackgroundPassSchedule {
  stop(): void;
}

/* eslint-disable no-unused-vars -- 回调类型签名中的参数名只用于表达调用契约。 */
/** 后台轮次的调度参数。 */
export interface BackgroundPassInput {
  /** 一轮结束到下一轮开始的间隔。 */
  readonly intervalMs: number;
  /** 执行一轮；应在每次让出事件循环后检查信号，已中止时尽快结束。 */
  readonly run: (signal: AbortSignal) => Promise<unknown>;
  /** 单轮失败的记录入口；不得抛出。 */
  readonly onError: (error: unknown) => void;
}
/* eslint-enable no-unused-vars */

/** 让出事件循环：排队的请求与写事务在两次同步读写之间执行。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 启动调度：首轮经 0 毫秒定时器排在当前调用之后，不阻塞调用方继续启动。 */
export function startBackgroundPass(input: BackgroundPassInput): BackgroundPassSchedule {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      timer = null;
      void input.run(controller.signal)
        .catch(input.onError)
        .finally(() => {
          if (!controller.signal.aborted) {
            schedule(input.intervalMs);
          }
        });
    }, delayMs);
    // 后台轮次不应单独让进程保持存活；服务端由监听端口保持运行。
    timer.unref();
  };
  schedule(0);
  return {
    stop: () => {
      controller.abort();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
