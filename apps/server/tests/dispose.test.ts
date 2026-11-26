/**
 * 核心职责：验证关闭编排的两级语义——先按截止时间排空，再逆序释放，且排空失败不阻断释放。
 * 交互契约：只依赖 `drainBeforeClose` 与 `disposeInReverse` 的公开签名与注入的日志回调。
 * 约束与禁忌：禁止启动真实监听端口，也不用真实计时器等待；排空预算通过参数直接给出。
 */
import { describe, expect, it, vi } from "vitest";
import { disposeInReverse, drainBeforeClose, type DisposalStep } from "@ai-npc/app-server";

describe("drainBeforeClose", () => {
  it("按声明顺序排空并把同一预算传给每一级", async () => {
    const calls: string[] = [];
    const report = vi.fn();
    await drainBeforeClose([
      { label: "online Agents", drain: async (ms) => { calls.push(`agents:${ms}`); } },
      { label: "started modules", drain: async (ms) => { calls.push(`modules:${ms}`); } },
      { label: "storage", drain: async (ms) => { calls.push(`storage:${ms}`); } },
    ], 5_000, report);
    expect(calls).toEqual(["agents:5000", "modules:5000", "storage:5000"]);
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
});
