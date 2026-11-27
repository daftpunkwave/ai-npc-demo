/**
 * 核心职责：验证存储占用测量：主库与空闲页字节、artifact 正文字节、只追加表行数与保留天数的取值，
 *   测量结果在缓存期内复用、过期后重新测量，删除行后空闲页增加而主库字节不变，
 *   以及测量与清理语句的查询计划只扫描覆盖索引。
 * 交互契约：依赖真实 SQLite 临时目录、存储模块测试助手、测量与保留期实现。
 * 约束与禁忌：禁止用假存储替代真实适配器，或只断言测量值为正数而不与 SQLite 自身的统计对照。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoragePort, StorageTransaction } from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import { footprintStatements, measuredTables } from "../src/sqlite/footprint";
import { pruneBatchStatements, runRetentionPass } from "../src/sqlite/retention";
import { footprintMaxAgeMs, type SqliteStorage } from "../src/sqlite/storage";
import { createFakeHost, createTempDataDir, removeTempDataDir, startStorage, type FakeHost, type StorageHandle } from "./support";

function putSpan(tx: StorageTransaction, spanId: string, startedAt: string, attrs: string): void {
  tx.rows("trace_spans").put({
    span_id: spanId, trace_id: "trc-footprint", parent_span_id: null, run_id: null, branch_id: null, agent_id: null,
    turn_id: null, module_id: null, module_version: null, name: "http.request", status: "ok", start_ms: 0, end_ms: 1,
    started_at: startedAt, attrs_json: { padding: attrs },
  });
}

function putArtifact(tx: StorageTransaction, artifactId: string, byteSize: number, storage: "inline" | "file"): void {
  tx.rows("artifacts").put({
    artifact_id: artifactId, run_id: null, kind: "tool-raw", content_hash: `hash-${artifactId}`, mime: "application/json",
    byte_size: byteSize, storage, body: storage === "inline" ? new Uint8Array(byteSize) : null,
    file_path: storage === "file" ? `artifacts/${artifactId}` : null, redaction: "raw", redacted_from: null,
    created_at: "2026-01-01T00:00:00.000Z",
  });
}

function pageStats(storage: StoragePort): { readonly databaseBytes: number; readonly freeBytes: number } {
  return storage.transact((tx) => {
    const pageSize = Number(tx.get("PRAGMA page_size")?.["page_size"]);
    return {
      databaseBytes: Number(tx.get("PRAGMA page_count")?.["page_count"]) * pageSize,
      freeBytes: Number(tx.get("PRAGMA freelist_count")?.["freelist_count"]) * pageSize,
    };
  });
}

function queryPlan(storage: StoragePort, sql: string): readonly string[] {
  return storage.transact((tx) => tx.all(`EXPLAIN QUERY PLAN ${sql}`).map((row) => String(row["detail"])));
}

/** 可手动推进单调时钟的确定性宿主，用于跨越占用测量的缓存时长。 */
function hostWithClock(): { readonly host: FakeHost; advance(ms: number): void } {
  const host = createFakeHost();
  let monotonic = 0;
  host.monotonicMs = () => monotonic;
  return {
    host,
    advance: (ms) => {
      monotonic += ms;
    },
  };
}

describe("存储占用测量", () => {
  let handle: StorageHandle | undefined;

  afterEach(async () => {
    if (handle !== undefined) {
      await handle.dispose();
      removeTempDataDir(handle.dataDir);
      handle = undefined;
    }
  });

  it("测量主库与空闲页字节、按存放方式汇总的 artifact 正文字节与只追加表行数", async () => {
    handle = await startStorage(createTempDataDir(), createFakeHost(), { retentionDays: { trace_spans: 30 } });
    const { port } = handle;
    port.transact((tx) => {
      putSpan(tx, "spn-1", "2026-01-01T00:00:00.000Z", "a");
      putSpan(tx, "spn-2", "2026-01-02T00:00:00.000Z", "b");
      putSpan(tx, "spn-3", "2026-01-03T00:00:00.000Z", "c");
      putArtifact(tx, "art-1", 100, "inline");
      putArtifact(tx, "art-2", 200, "inline");
      putArtifact(tx, "art-3", 70_000, "file");
      insertLifecycleAuditEvent(tx, {
        runId: null, branchId: null, type: "ClockAutoPaused", subjectId: null, payload: {}, createdAt: "2026-01-01T00:00:00.000Z",
      });
    });
    const footprint = port.footprint?.();
    const seededRows: Readonly<Record<string, number>> = { trace_spans: 3, artifacts: 3, lifecycle_events: 1 };
    expect(footprint).toEqual({
      measuredAt: expect.stringMatching(/^2026-01-01T/),
      ...pageStats(port),
      artifactBytes: { inline: 300, file: 70_000 },
      tables: measuredTables.map((table) => ({ table, rows: seededRows[table] ?? 0 })),
      retention: [{ table: "trace_spans", days: 30 }],
    });
    expect(footprint?.databaseBytes).toBeGreaterThan(0);
  });

  it("未配置保留天数时保留策略为空数组", async () => {
    handle = await startStorage(createTempDataDir());
    expect(handle.port.footprint?.().retention).toEqual([]);
  });

  it("缓存期内复用同一测量，过期后在新事务里重新测量", async () => {
    const clock = hostWithClock();
    handle = await startStorage(createTempDataDir(), clock.host);
    const { port } = handle;
    const transact = vi.spyOn(port as SqliteStorage, "transact");
    const first = port.footprint?.();
    port.transact((tx) => {
      putSpan(tx, "spn-1", "2026-01-01T00:00:00.000Z", "a");
    });
    clock.advance(footprintMaxAgeMs - 1);
    expect(port.footprint?.()).toBe(first);
    expect(transact).toHaveBeenCalledTimes(2);
    clock.advance(1);
    const refreshed = port.footprint?.();
    expect(transact).toHaveBeenCalledTimes(3);
    transact.mockRestore();
    expect(refreshed?.tables.find((entry) => entry.table === "trace_spans")?.rows).toBe(1);
    expect(first?.tables.find((entry) => entry.table === "trace_spans")?.rows).toBe(0);
  });

  it("清理删除行后空闲页增加，主库页面字节不缩小", async () => {
    const clock = hostWithClock();
    handle = await startStorage(createTempDataDir(), clock.host);
    const { port } = handle;
    const padding = "x".repeat(2_000);
    port.transact((tx) => {
      for (let index = 0; index < 400; index += 1) {
        putSpan(tx, `spn-${String(index).padStart(4, "0")}`, "2026-01-01T00:00:00.000Z", padding);
      }
    });
    const before = port.footprint?.();
    await runRetentionPass({
      storage: port,
      host: { ...clock.host, nowIso: () => "2026-03-01T00:00:00.000Z" },
      retentionDays: { trace_spans: 30 },
      signal: new AbortController().signal,
    });
    clock.advance(footprintMaxAgeMs);
    const after = port.footprint?.();
    expect(after?.tables.find((entry) => entry.table === "trace_spans")?.rows).toBe(0);
    expect(after?.databaseBytes).toBe(before?.databaseBytes);
    expect((after?.freeBytes ?? 0) - (before?.freeBytes ?? 0)).toBeGreaterThan(400 * 2_000 * 0.9);
  });

  it("测量与清理语句只扫描覆盖索引，不读取行正文", async () => {
    handle = await startStorage(createTempDataDir());
    const { port } = handle;
    const tableRowsPlan = queryPlan(port, footprintStatements.tableRows).filter((detail) => detail.startsWith("SCAN"));
    expect(tableRowsPlan).toHaveLength(measuredTables.length);
    for (const detail of tableRowsPlan) {
      expect(detail).toContain("USING COVERING INDEX");
    }
    expect(queryPlan(port, footprintStatements.artifactBytes))
      .toEqual(["SCAN artifacts USING COVERING INDEX artifacts_storage_bytes"]);
    expect(queryPlan(port, pruneBatchStatements.trace_spans))
      .toContain("SEARCH trace_spans USING COVERING INDEX trace_spans_started_at (started_at<?)");
  });
});
