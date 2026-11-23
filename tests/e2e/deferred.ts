/**
 * 核心职责：控制浏览器测试中被拦截请求的完成顺序。
 * 交互契约：由测试主动标记 Promise 完成，调用方等待该信号。
 * 约束与禁忌：不依赖定时器或共享测试状态。
 */
export function deferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}
