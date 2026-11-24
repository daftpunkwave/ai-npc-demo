/**
 * 核心职责：提供 PixiJS 应用的按需渲染初始化选项，并把初始化成功、失败与销毁统一成可断言的会话。
 * 交互契约：应用实例通过构造注入；失败原因被转换为可直接展示的文本，销毁只在初始化成功后发生。
 * 约束与禁忌：不启动 Ticker、不吞掉初始化 rejection，也不在未初始化的应用上调用 destroy。
 */
import type { ApplicationOptions } from "pixi.js";

export interface SceneApplicationLike {
  init(options: Partial<ApplicationOptions>): Promise<void>;
  destroy(removeView?: boolean): void;
  readonly renderer?: { destroy?(...args: unknown[]): void } | null;
}

export type SceneStartResult =
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "cancelled" };

export interface SceneResizeTarget {
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

/** 把画布尺寸变化绑定到一次重绘；返回的函数注销同一个监听。 */
export function bindSceneResize(target: SceneResizeTarget, onResize: () => void): () => void {
  target.on("resize", onResize);
  return () => target.off("resize", onResize);
}

/**
 * 场景只在投影、相机或画布尺寸变化时重绘，因此显式关闭 Ticker 的自动渲染。
 * `resizeTo` 由宿主元素驱动，仍交给 Pixi 的 ResizePlugin 计算画布尺寸。
 */
export function sceneApplicationOptions(
  host: unknown,
  devicePixelRatio: number | undefined,
): Partial<ApplicationOptions> {
  return {
    resizeTo: host as never,
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(2, devicePixelRatio ?? 1),
    autoDensity: true,
    autoStart: false,
  };
}

/** 把初始化失败转换成玩家可见的原因；没有可读文本时给出通用文案。 */
export function sceneFailureReason(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : "";
  return message === "" ? "渲染器初始化失败" : message;
}

/**
 * 渲染器生命周期会话：初始化失败不再产生未处理的 rejection；
 * 组件在初始化完成前卸载时，等初始化落定后再销毁，避免在未初始化对象上 destroy。
 */
export class SceneApplicationSession {
  private ready = false;
  private disposed = false;

  constructor(private readonly application: SceneApplicationLike) {}

  async start(options: Partial<ApplicationOptions>): Promise<SceneStartResult> {
    try {
      await this.application.init(options);
    } catch (error) {
      const reason = sceneFailureReason(error);
      this.releaseFailedInitialization();
      return { status: "failed", reason };
    }
    if (this.disposed) {
      this.application.destroy(true);
      return { status: "cancelled" };
    }
    this.ready = true;
    return { status: "ready" };
  }

  dispose(): void {
    this.disposed = true;
    if (!this.ready) {
      return;
    }
    this.ready = false;
    this.application.destroy(true);
  }

  /**
   * Pixi 的 init 在渲染器创建后、插件初始化中途失败时会留下已分配的渲染器；
   * 只有渲染器存在时才调用 destroy，避免在完全未初始化的应用上做破坏性清理。
   * 清理异常不覆盖原始失败原因，初始化失败时没有别的上报通道。
   */
  private releaseFailedInitialization(): void {
    const renderer = this.application.renderer;
    if (renderer === undefined || renderer === null) {
      return;
    }
    try {
      this.application.destroy(true);
    } catch {
      // 初始化已经失败，保留原始原因优先于清理异常。
    }
  }
}
