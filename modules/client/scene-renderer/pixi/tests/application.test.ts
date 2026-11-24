/**
 * 校验渲染器初始化选项关闭自动渲染，并覆盖初始化失败、卸载竞态与销毁时机。
 * 依赖注入的假应用实例；不创建 WebGL 上下文或真实画布。
 * 禁止让初始化 rejection 变成未处理异常，也禁止在未初始化成功的应用上销毁。
 */
import { describe, expect, it, vi } from "vitest";
import type { ApplicationOptions } from "pixi.js";
import {
  SceneApplicationSession,
  sceneApplicationOptions,
  sceneFailureReason,
} from "../src/application";

function createApplication(init: () => Promise<void>) {
  return {
    init: vi.fn(() => init()),
    destroy: vi.fn((_removeView?: boolean) => undefined),
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

describe("sceneApplicationOptions", () => {
  it("关闭 Ticker 自动渲染并保留背景透明与高清适配", () => {
    const options = sceneApplicationOptions({}, 3);

    expect(options.autoStart).toBe(false);
    expect(options.backgroundAlpha).toBe(0);
    expect(options.antialias).toBe(true);
    expect(options.autoDensity).toBe(true);
    expect(options.resolution).toBe(2);
  });

  it("低分屏不放大分辨率，缺省像素比按 1 处理", () => {
    expect(sceneApplicationOptions({}, 0.5).resolution).toBe(0.5);
    expect(sceneApplicationOptions({}, undefined).resolution).toBe(1);
  });
});

describe("sceneFailureReason", () => {
  it("优先使用错误原文，没有可读文本时给出兜底", () => {
    expect(sceneFailureReason(new Error("WebGL 上下文创建失败"))).toBe("WebGL 上下文创建失败");
    expect(sceneFailureReason("canvas 不可用")).toBe("canvas 不可用");
    expect(sceneFailureReason(new Error("  "))).toBe("渲染器初始化失败");
    expect(sceneFailureReason(undefined)).toBe("渲染器初始化失败");
  });
});

describe("SceneApplicationSession", () => {
  it("初始化失败时返回可见原因，且不在未初始化的应用上销毁", async () => {
    const application = createApplication(() => Promise.reject(new Error("显存不足")));
    const session = new SceneApplicationSession(application);

    const result = await session.start({});

    expect(result).toEqual({ status: "failed", reason: "显存不足" });
    session.dispose();
    expect(application.destroy).not.toHaveBeenCalled();
  });

  it("初始化成功后只在释放时销毁一次", async () => {
    const application = createApplication(() => Promise.resolve());
    const session = new SceneApplicationSession(application);

    await expect(session.start({})).resolves.toEqual({ status: "ready" });
    session.dispose();
    session.dispose();

    expect(application.destroy).toHaveBeenCalledTimes(1);
    expect(application.destroy).toHaveBeenCalledWith(true);
  });

  it("初始化完成前卸载时，等初始化落定后再销毁", async () => {
    const pending = deferred();
    const application = createApplication(() => pending.promise);
    const session = new SceneApplicationSession(application);
    const started = session.start({});

    session.dispose();
    pending.resolve();

    await expect(started).resolves.toEqual({ status: "cancelled" });
    expect(application.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("ApplicationOptions 类型约束", () => {
  it("选项对象可直接传给 Pixi 的 init", () => {
    const options: Partial<ApplicationOptions> = sceneApplicationOptions({}, 1);
    expect(options.autoStart).toBe(false);
  });
});
