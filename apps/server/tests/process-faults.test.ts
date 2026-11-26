/**
 * 核心职责：验证进程级未捕获异常策略——结构化记录、标记降级退出码、走同一条优雅关闭。
 * 交互契约：注入日志、关闭与退出码写入回调，不真正监听进程事件，也不结束测试进程。
 * 约束与禁忘：禁止空实现吞掉异常，也不允许重复故障触发第二次关闭或覆盖已确定的退出码。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createProcessFaultHandlers,
  faultExitCode,
  installProcessFaultHandlers,
  type ProcessFaultReport,
} from "@ai-npc/app-server";

describe("process fault handlers", () => {
  it("记录未处理 rejection 并以非零退出码走优雅关闭", async () => {
    const faults: ProcessFaultReport[] = [];
    const shutdown = vi.fn(async () => undefined);
    const setExitCode = vi.fn();
    const handlers = createProcessFaultHandlers({
      logFault: (report) => faults.push(report),
      shutdown,
      setExitCode,
    });
    handlers.unhandledRejection(new Error("background push failed"));
    expect(faults).toEqual([{
      kind: "unhandledRejection",
      message: "background push failed",
      stack: expect.any(String),
    }]);
    // 浏览器与 WS 都会看到进程退出：退出码必须非零，且与关闭失败（1）区分。
    expect(setExitCode).toHaveBeenCalledWith(faultExitCode);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("重复故障都记录，但只触发一次关闭", () => {
    const faults: ProcessFaultReport[] = [];
    const shutdown = vi.fn(async () => undefined);
    const setExitCode = vi.fn();
    const handlers = createProcessFaultHandlers({
      logFault: (report) => faults.push(report),
      shutdown,
      setExitCode,
    });
    handlers.uncaughtException(new Error("first"));
    handlers.unhandledRejection("second");
    expect(faults.map((fault) => fault.kind)).toEqual(["uncaughtException", "unhandledRejection"]);
    expect(handlers.faults()).toBe(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("关闭自身失败时不抛出新异常，避免最后一道防线二次崩溃", async () => {
    const shutdown = vi.fn(async () => { throw new Error("close failed"); });
    const handlers = createProcessFaultHandlers({
      logFault: () => undefined,
      shutdown,
      setExitCode: () => undefined,
    });
    expect(() => handlers.uncaughtException(new Error("boom"))).not.toThrow();
    // 关闭是异步拉起的：等它的 rejection 被吞掉，不产生未处理 rejection。
    await vi.waitFor(() => { expect(shutdown).toHaveBeenCalled(); });
  });

  it("显式关闭退出策略时只记录不退出，供隔离后继续的场景使用", () => {
    const setExitCode = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    const handlers = createProcessFaultHandlers({
      logFault: () => undefined,
      shutdown,
      setExitCode,
      exitOnFault: false,
    });
    handlers.unhandledRejection(new Error("isolated"));
    expect(setExitCode).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("挂载后可从进程事件触发并可完整解除", async () => {
    const faults: ProcessFaultReport[] = [];
    const shutdown = vi.fn(async () => undefined);
    const handlers = createProcessFaultHandlers({
      logFault: (report) => faults.push(report),
      shutdown,
      setExitCode: () => undefined,
    });
    const target = {
      listeners: new Map<string, ((value: unknown) => void)[]>(),
      on(event: string, listener: (value: unknown) => void) {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
        return this;
      },
      off(event: string, listener: (value: unknown) => void) {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener));
        return this;
      },
    };
    const uninstall = installProcessFaultHandlers(target as unknown as NodeJS.Process, handlers);
    for (const listener of target.listeners.get("unhandledRejection") ?? []) listener(new Error("from process"));
    expect(faults).toHaveLength(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    uninstall();
    expect(target.listeners.get("unhandledRejection")).toEqual([]);
    expect(target.listeners.get("uncaughtException")).toEqual([]);
  });
});
