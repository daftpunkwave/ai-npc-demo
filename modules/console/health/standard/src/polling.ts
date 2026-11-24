/**
 * 健康页轮询节流判定：页面不可见时暂停定时读取，恢复可见时立即补一次。
 * 依赖浏览器注入的可见性状态字符串；不直接读取全局 document，也不发起请求。
 * 禁止在页面不可见时仍按固定间隔持续请求，那只会产生无人接收的流量。
 */

/** 页面可见性状态；取浏览器 `document.visibilityState` 的子集，便于测试直接传入。 */
export type PageVisibility = "visible" | "hidden" | "prerender" | string | undefined;

/**
 * 是否应当执行一次健康读取。
 * 只有明确的 `hidden` 与 `prerender` 才停止读取：未知状态出现在非浏览器环境或旧实现上，
 * 此时保持原有固定间隔行为，避免因为拿不到状态就永久停摆。
 */
export function shouldPollHealth(visibility: PageVisibility): boolean {
  return visibility !== "hidden" && visibility !== "prerender";
}

/**
 * 读取当前页面可见性。
 * 通过 `globalThis` 取 `document` 而不是直接引用：该模块同时被服务端类型检查覆盖，
 * 那里没有 DOM 库，直接引用 `document` 会编译失败。
 */
export function currentVisibility(): PageVisibility {
  const scope = globalThis as { readonly document?: { readonly visibilityState?: string } };
  return scope.document?.visibilityState;
}

/** 订阅可见性变化；非浏览器环境返回空操作，调用方无需自行判空。 */
export function onVisibilityChange(listener: () => void): () => void {
  const scope = globalThis as {
    readonly document?: {
      addEventListener(type: "visibilitychange", handler: () => void): void;
      removeEventListener(type: "visibilitychange", handler: () => void): void;
    };
  };
  const target = scope.document;
  if (target === undefined) {
    return () => undefined;
  }
  target.addEventListener("visibilitychange", listener);
  return () => {
    target.removeEventListener("visibilitychange", listener);
  };
}
