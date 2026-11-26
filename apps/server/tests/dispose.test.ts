/**
 * 核心职责：验证关闭编排的两级语义——先按截止时间排空，再逆序释放，且排空失败不阻断释放。
 * 交互契约：只依赖 `drainBeforeClose` 与 `disposeInReverse` 的公开签名与注入的日志回调。
 * 约束与禁忌：禁止启动真实监听端口，也不用真实计时器等待；排空预算通过参数直接给出。
 */
import { describe, expect, it, vi } from "vitest";
import { disposeInReverse, disposeWithin, drainBeforeClose, type DisposalStep } from "@world-prism/app-server";

describe("drainBeforeClose", () => {
  it("按声明顺序排空，并让后续层级只拿到剩余预算", async () => {
    const calls: number[] = [];
    const report = vi.fn();
    await drainBeforeClose([
      {
        label: "online Agents",
        // 第一级故意用掉大部分预算，后续层级必须拿到更少的剩余时间。
        drain: async (ms) => { calls.push(ms); await new Promise((resolve) => { setTimeout(resolve, 40); }); },
      },
      { label: "started modules", drain: async (ms) => { calls.push(ms); } },
      { label: "storage", drain: async (ms) => { calls.push(ms); } },
    ], 5_000, report);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeLessThanOrEqual(5_000);
    // 共享一次预算：第二级与第三级都不会再拿到完整的 5000 毫秒。
    expect(calls[1]).toBeLessThan(calls[0] as number);
    expect(calls[2]).toBeLessThanOrEqual(calls[1] as number);
    expect(report).not.toHaveBeenCalled();
  });

  it("某一级排空失败或超时后仍继续排空其余级，并逐级记录", async () => {
    const calls: string[] = [];
    const reports: { readonly label: string; readonly deadlineMs: number; readonly message: string }[] = [];
    await drainBeforeClose([
      { label: "online Agents", drain: async () => { throw new Error("turn still running"); } },
      { label: "started modules", drain: async () => { calls.push("modules"); } },
    ], 1_000, (_message, data) => { reports.push(data); });
    expect(calls).toEqual(["modules"]);
    expect(reports).toEqual([{ label: "online Agents", deadlineMs: 1_000, message: "turn still running" }]);
  });

  it("排空之后再逆序释放，释放失败仍汇总抛出", async () => {
    const steps: string[] = [];
    const disposeSteps: readonly DisposalStep[] = [
      { label: "storage", dispose: async () => { steps.push("dispose:storage"); } },
      { label: "online Agents", dispose: async () => { throw new Error("close failed"); } },
    ];
    await drainBeforeClose([
      { label: "online Agents", drain: async () => { steps.push("drain:agents"); } },
    ], 2_000, () => undefined);
    await expect(disposeInReverse(disposeSteps)).rejects.toThrow(AggregateError);
    expect(steps).toEqual(["drain:agents", "dispose:storage"]);
  });

  it("释放超时只记录并放行，不把关闭阻塞在卡住的释放上", async () => {
    const reports: { readonly label: string }[] = [];
    let finished = false;
    await disposeWithin(
      async () => { await new Promise((resolve) => { setTimeout(resolve, 5_000); }); finished = true; },
      50,
      "host resources",
      (_message, data) => { reports.push(data); },
    );
    // 已按时返回：释放本身仍在后台，但调用方不再等待。
    expect(finished).toBe(false);
    expect(reports).toEqual([{ label: "host resources", deadlineMs: 50, message: "release did not finish in time" }]);
  });
});
