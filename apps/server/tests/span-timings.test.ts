/**
 * 核心职责：验证宿主 tracer 的进程内耗时汇总，以及传输应用把投影构建与投影发布接到同一 tracer 的接线。
 * 交互契约：用可控单调时钟驱动 createSpanTimings；以最小输入图驱动 createTransportApp，捕获其传给传输工厂的选项。
 * 约束与禁忌：不监听端口、不连存储；断言只依赖注入时钟，不依赖真实耗时。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consoleHotPathTimingSchema, type HostTracer } from "@world-prism/contracts";
import type { GameContent } from "@world-prism/module-sdk";
import type { ServerApp } from "../src/host/module-catalog";
import { createHostServices } from "../src/host-services";
import { createSpanTimings } from "../src/host/span-timings";
import { createTransportApp, playerProjectionSpan, type TransportAppInput } from "../src/host/transport-app";

/** 可控单调时钟：每次读取后由用例显式推进。 */
function manualClock(): { readonly now: () => number; advance(ms: number): void } {
  let current = 1_000;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("进程内耗时汇总", () => {
  it("按名称记录次数与延迟，百分位取最近秩样本，返回回调结果", () => {
    const clock = manualClock();
    const timings = createSpanTimings({ now: clock.now });
    for (const elapsed of [5, 1, 3, 2, 4]) {
      expect(timings.span("b.span", {}, () => {
        clock.advance(elapsed);
        return elapsed * 10;
      })).toBe(elapsed * 10);
    }
    timings.span("a.span", { ignored: true }, () => clock.advance(0.25));
    const summaries = timings.summaries();
    expect(summaries.map((entry) => entry.name)).toEqual(["a.span", "b.span"]);
    expect(summaries[1]).toEqual({
      name: "b.span",
      count: 5,
      errors: 0,
      samples: 5,
      lastMs: 4,
      p50Ms: 3,
      p95Ms: 5,
      maxMs: 5,
    });
    expect(summaries[0]).toMatchObject({ count: 1, lastMs: 0.25, p50Ms: 0.25, maxMs: 0.25 });
    for (const entry of summaries) {
      expect(consoleHotPathTimingSchema.parse(entry)).toEqual(entry);
    }
  });

  it("回调抛错时记录耗时与失败次数并原样抛出", () => {
    const clock = manualClock();
    const timings = createSpanTimings({ now: clock.now });
    const failure = new Error("注入的失败");
    expect(() => timings.span("failing", {}, () => {
      clock.advance(7);
      throw failure;
    })).toThrow(failure);
    expect(timings.summaries()).toEqual([
      { name: "failing", count: 1, errors: 1, samples: 1, lastMs: 7, p50Ms: 7, p95Ms: 7, maxMs: 7 },
    ]);
  });

  it("每个名称只保留最近窗口内的样本，累计次数不受窗口限制", () => {
    const clock = manualClock();
    const timings = createSpanTimings({ now: clock.now, windowSize: 3 });
    for (const elapsed of [100, 1, 2, 3]) {
      timings.span("windowed", {}, () => clock.advance(elapsed));
    }
    // 第一个 100 ms 样本已被覆盖，最大值只反映最近 3 次。
    expect(timings.summaries()).toEqual([
      { name: "windowed", count: 4, errors: 0, samples: 3, lastMs: 3, p50Ms: 2, p95Ms: 3, maxMs: 3 },
    ]);
  });

  it("名称数量达到上限后新名称只执行回调不登记，时钟回拨按 0 记", () => {
    let current = 50;
    const timings = createSpanTimings({ now: () => current, maxNames: 1 });
    timings.span("kept", {}, () => {
      current -= 10;
    });
    expect(timings.span("dropped", {}, () => "still-runs")).toBe("still-runs");
    expect(timings.summaries()).toEqual([
      { name: "kept", count: 1, errors: 0, samples: 1, lastMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    ]);
  });

  it("时钟读取失败只放弃本次计时，不改变回调结果，也不掩盖回调错误", () => {
    let reads = 0;
    // 第 2 次读取（第一次 span 结束时）与第 3 次读取（第二次 span 开始时）抛错。
    const timings = createSpanTimings({
      now: () => {
        reads += 1;
        if (reads === 2 || reads === 3) {
          throw new Error("时钟故障");
        }
        return reads;
      },
    });
    const failure = new Error("回调错误");
    expect(() => timings.span("first", {}, () => {
      throw failure;
    })).toThrow(failure);
    expect(timings.span("second", {}, () => "ok")).toBe("ok");
    expect(timings.summaries()).toEqual([]);
  });

  it("窗口与名称上限必须是正整数", () => {
    expect(() => createSpanTimings({ now: () => 0, windowSize: 0 })).toThrow(RangeError);
    expect(() => createSpanTimings({ now: () => 0, maxNames: 1.5 })).toThrow(RangeError);
  });
});

describe("宿主服务的 tracer 注入", () => {
  it("未注入 tracer 时 span 只执行回调并原样返回结果与错误", () => {
    const services = createHostServices();
    expect(services.tracer.span("any", {}, () => 42)).toBe(42);
    const failure = new Error("回调错误");
    expect(() => services.tracer.span("any", {}, () => {
      throw failure;
    })).toThrow(failure);
  });

  it("注入的 tracer 原样成为宿主服务的 tracer", () => {
    const timings = createSpanTimings({ now: () => 0 });
    expect(createHostServices({ tracer: timings }).tracer).toBe(timings);
  });
});

describe("传输应用的热路径计时接线", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("投影构建经 host.tracer 计时，同一 tracer 交给传输层为发布计时", async () => {
    const clock = manualClock();
    const timings = createSpanTimings({ now: clock.now });
    let captured: { readonly projection?: () => unknown; readonly tracer?: HostTracer } = {};
    const stubApp = {} as ServerApp;
    const directory = mkdtempSync(join(tmpdir(), "world-prism-transport-timing-"));
    dirs.push(directory);
    const projection = { marker: "projection" };
    const input = {
      host: { logger: { info: () => {}, warn: () => {}, error: () => {} }, tracer: timings },
      options: { playerToken: "player-token", consoleToken: "console-token" },
      runtime: {
        transport: {
          createApp: async (options: unknown) => {
            captured = options as typeof captured;
            return stubApp;
          },
        },
      },
      active: { worldId: "world-1", branchId: "branch-1" },
      reads: {
        projection: () => {
          clock.advance(6);
          return projection;
        },
      },
      gameContent: { secrets: new Map() } as unknown as GameContent,
      consoleStaticDir: directory,
    } as unknown as TransportAppInput;

    await createTransportApp(input);
    expect(captured.tracer).toBe(timings);
    expect(captured.projection?.()).toBe(projection);
    expect(timings.summaries()).toEqual([
      { name: playerProjectionSpan, count: 1, errors: 0, samples: 1, lastMs: 6, p50Ms: 6, p95Ms: 6, maxMs: 6 },
    ]);
  });
});
