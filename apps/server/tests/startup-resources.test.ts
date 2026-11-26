/**
 * 核心职责：验证启动期资源登记表的逆序释放语义与失败汇总行为。
 * 交互契约：只使用本模块的公开入口，不启动宿主、不打开存储。
 * 约束与禁忌：不断言日志文本，也不依赖具体资源的释放实现。
 */
import { describe, expect, it } from "vitest";
import { StartupResources } from "../src/host/startup-resources";

describe("启动期资源登记", () => {
  it("按登记顺序的逆序释放，后取得的资源先释放", async () => {
    const released: string[] = [];
    const resources = new StartupResources();
    resources.track("storage", async () => { released.push("storage"); });
    resources.track("started modules", async () => { released.push("started modules"); });
    resources.track("run Agent modules", async () => { released.push("run Agent modules"); });

    expect(resources.labels()).toEqual(["storage", "started modules", "run Agent modules"]);
    await resources.releaseAll();
    expect(released).toEqual(["run Agent modules", "started modules", "storage"]);
  });

  it("单步释放失败不中断其余步骤，并把全部失败汇总抛出", async () => {
    const released: string[] = [];
    const resources = new StartupResources();
    resources.track("storage", async () => { released.push("storage"); });
    resources.track("started modules", async () => { throw new Error("模块释放失败"); });
    resources.track("run Agent modules", async () => { released.push("run Agent modules"); });

    await expect(resources.releaseAll()).rejects.toThrow(/宿主清理未全部完成/);
    // 失败步骤之后的资源仍被释放；失败的步骤自身不计入已释放。
    expect(released).toEqual(["run Agent modules", "storage"]);
  });

  it("未登记任何资源时释放是空操作", async () => {
    const resources = new StartupResources();
    expect(resources.labels()).toEqual([]);
    await expect(resources.releaseAll()).resolves.toBeUndefined();
  });
});
