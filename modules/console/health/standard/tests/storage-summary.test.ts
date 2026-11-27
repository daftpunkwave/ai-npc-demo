/**
 * 核心职责：覆盖运行总览存储占用面板的文案转换：字节进位、表行数、保留策略、缺失测量与首轮测量未完成。
 * 交互契约：依赖纯转换函数与契约类型；不启动浏览器或网络。
 * 约束与禁忌：禁止把缺失的测量渲染成 0，也禁止在没有保留天数时省略“永久保留”的说明。
 */
import { describe, expect, it } from "vitest";
import type { ConsoleHealthResponse } from "@world-prism/contracts";
import { formatBytes, storageSummary } from "../src/storage-summary";

const baseHealth: ConsoleHealthResponse = {
  status: "ready",
  ports: { client: 5173, server: 3000 },
  realms: ["server", "client", "console"],
  assemblyHash: "assembly-hash",
  modules: [],
  clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
  queues: { turnsQueued: 0 },
  budgets: [],
  recentFailures: [],
};

const storage: NonNullable<ConsoleHealthResponse["storage"]> = {
  measuredAt: "2026-11-27T08:00:00.000Z",
  databaseBytes: 3 * 1024 * 1024,
  freeBytes: 512,
  artifactBytes: { inline: 1536, file: 5 * 1024 * 1024 * 1024 },
  tables: [{ table: "domain_events", rows: 1234567 }, { table: "trace_spans", rows: 0 }],
  retention: [],
};

describe("存储占用面板", () => {
  it("按 1024 进位格式化字节数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TiB");
  });

  it("响应不含存储测量时返回 null，不渲染 0", () => {
    expect(storageSummary(baseHealth)).toBeNull();
  });

  it("首轮测量未完成时返回待测量状态，不渲染 0", () => {
    expect(storageSummary({ ...baseHealth, storage: null })).toEqual({ status: "pending" });
  });

  it("渲染字节、表行数与永久保留说明", () => {
    expect(storageSummary({ ...baseHealth, storage })).toEqual({
      status: "measured",
      measuredAt: "2026-11-27T08:00:00.000Z",
      databaseText: "3.0 MiB",
      freeText: "512 B",
      artifactText: "内联 1.5 KiB / 文件 5.0 GiB",
      retentionText: "全部永久保留",
      tables: [{ table: "domain_events", rowsText: "1,234,567" }, { table: "trace_spans", rowsText: "0" }],
    });
  });

  it("列出生效的保留天数", () => {
    const summary = storageSummary({ ...baseHealth, storage: { ...storage, retention: [{ table: "trace_spans", days: 30 }] } });
    expect(summary).toMatchObject({ status: "measured", retentionText: "trace_spans 30 天" });
  });
});
