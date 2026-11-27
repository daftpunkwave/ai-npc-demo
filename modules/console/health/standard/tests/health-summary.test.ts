/**
 * 覆盖控制台健康摘要页面的状态徽标与缺失字段文案：ready/degraded 必须与接口一致。
 * 依赖纯转换函数与契约类型；不启动浏览器或网络。
 * 禁止把未接入的队列/水位字段当作 0，也禁止降级时仍显示 ready。
 */
import { describe, expect, it } from "vitest";
import type { ConsoleHealthResponse } from "@world-prism/contracts";
import { formatDurationMs, healthSummary } from "../src/health-summary";

function health(overrides: Partial<ConsoleHealthResponse> = {}): ConsoleHealthResponse {
  return {
    status: "ready",
    ports: { client: 5173, server: 3000 },
    realms: ["server", "client", "console"],
    assemblyHash: "assembly-hash",
    modules: [{ moduleId: "game.clock.controlled", version: "1.0.0", status: "ready" }],
    clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
    queues: { turnsQueued: 2 },
    budgets: [],
    recentFailures: [],
    ...overrides,
  };
}

describe("控制台健康摘要", () => {
  it("ready 响应渲染 ready 徽标并只累加已接入队列", () => {
    const summary = healthSummary(health());
    expect(summary.statusLabel).toBe("ready");
    expect(summary.statusClass).toBe("health-chip health-chip-ready");
    expect(summary.queuedText).toBe("2");
    expect(summary.queueDetail).toContain("maintenance 未接入");
    expect(summary.laggingText).toBe("未接入");
  });

  it("degraded 响应渲染 degraded 徽标，不保留 ready", () => {
    const summary = healthSummary(
      health({
        status: "degraded",
        queues: { turnsQueued: 1, turnsRunning: 1, maintenanceQueued: 3, modelQueue: 0 },
        laggingAgents: 4,
      }),
    );
    expect(summary.statusLabel).toBe("degraded");
    expect(summary.statusClass).toBe("health-chip health-chip-degraded");
    expect(summary.queuedText).toBe("4");
    expect(summary.queueDetail).toBe("turns 1 / maintenance 3 / running 1 / model 0");
    expect(summary.laggingText).toBe("4");
  });

  it("宿主未提供热路径耗时时不生成空行，提供时按条目输出次数与延迟", () => {
    expect(healthSummary(health()).hotPaths).toBeNull();
    const summary = healthSummary(
      health({
        hotPaths: [
          { name: "player-projection.build", count: 12, errors: 0, samples: 12, lastMs: 1.5, p50Ms: 1.875, p95Ms: 2.25, maxMs: 3 },
          { name: "player-stream.publish", count: 9, errors: 1, samples: 9, lastMs: 12.5, p50Ms: 9.5, p95Ms: 12.5, maxMs: 40.25 },
        ],
      }),
    );
    expect(summary.hotPaths).toEqual([
      {
        name: "player-projection.build",
        countText: "12 次",
        latencyText: "p50 1.88 ms · p95 2.25 ms · 最大 3.00 ms（近 12 次）",
      },
      {
        name: "player-stream.publish",
        countText: "9 次 · 失败 1",
        latencyText: "p50 9.50 ms · p95 12.5 ms · 最大 40.3 ms（近 9 次）",
      },
    ]);
  });

  it("毫秒文案十毫秒以内保留两位小数，以上保留一位", () => {
    expect(formatDurationMs(0.0625)).toBe("0.06 ms");
    expect(formatDurationMs(9.999)).toBe("10.00 ms");
    expect(formatDurationMs(10)).toBe("10.0 ms");
    expect(formatDurationMs(123.456)).toBe("123.5 ms");
  });
});
