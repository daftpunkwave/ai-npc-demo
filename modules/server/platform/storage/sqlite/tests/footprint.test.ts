/**
 * 核心职责：验证存储占用测量：模块启动后在后台测量，首轮完成前 footprint() 为 null、完成后只返回内存中的结果，
 *   按间隔重测且关闭连接时取消进行中的一轮；每次读取都是按 rowid 范围的有界单块查询、读取之前让出事件循环，
 *   测得的行数与 artifact 字节与独立统计一致；删除行后空闲页增加而主库字节不变；清理批次语句只扫描覆盖索引。
 * 交互契约：依赖真实 SQLite 临时目录、存储模块测试助手、测量与保留期实现；调度用 vitest 受控定时器推进。
 * 约束与禁忌：禁止用假存储替代真实适配器，或只断言测量值为正数而不与 SQLite 自身的统计对照。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageFootprint, StoragePort, StorageTransaction, StorageValue } from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import { yieldToEventLoop } from "../src/sqlite/background-pass";
import {
  footprintIntervalMs,
  footprintStatements,
  measuredTables,
  measureFootprint,
  type FootprintMeasureInput,
} from "../src/sqlite/footprint";
import { pruneBatchStatements, runRetentionPass } from "../src/sqlite/retention";
import type { SqliteStorage } from "../src/sqlite/storage";
import { createFakeHost, createTempDataDir, removeTempDataDir, startStorage, type StorageHandle } from "./support";

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

/** 与测量实现无关的对照统计：每张被测表的 COUNT(*) 与按存放方式汇总的 artifact 字节。 */
function independentStats(storage: StoragePort): {
  readonly tables: readonly { readonly table: string; readonly rows: number }[];
  readonly artifactBytes: { readonly inline: number; readonly file: number };
} {
  return storage.transact((tx) => {
    const bytesOf = (kind: string): number =>
      Number(tx.get("SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM artifacts WHERE storage = ?", [kind])?.["bytes"]);
    return {
      tables: measuredTables.map((table) => ({ table, rows: Number(tx.get(`SELECT COUNT(*) AS count FROM ${table}`)?.["count"]) })),
      artifactBytes: { inline: bytesOf("inline"), file: bytesOf("file") },
    };
  });
}

function queryPlan(storage: StoragePort, sql: string): readonly string[] {
  return storage.transact((tx) => tx.all(`EXPLAIN QUERY PLAN ${sql}`).map((row) => String(row["detail"])));
}

function rowsOf(footprint: { readonly tables: readonly { readonly table: string; readonly rows: number }[] } | null, table: string): number | undefined {
  return footprint?.tables.find((entry) => entry.table === table)?.rows;
}

/** 经生产只读入口直接执行一轮测量；overrides 覆盖块大小、让出与中止信号。 */
function measure(storage: SqliteStorage, overrides: Partial<FootprintMeasureInput> = {}): ReturnType<typeof measureFootprint> {
  return measureFootprint({
    read: (sql, params) => storage.readOutsideTransaction(sql, params),
    nowIso: () => "2026-03-01T00:00:00.000Z",
    retentionDays: undefined,
    signal: new AbortController().signal,
    ...overrides,
  });
}

/**
 * 受控定时器下每次推进 1 毫秒，放行后台测量的让出，直到出现新的测量结果。
 * 不用“推进到下一个定时器”：测量完成后下一个定时器是间隔重测，会把时间一次推过整个间隔。
 */
async function settleMeasurement(storage: SqliteStorage): Promise<StorageFootprint | null> {
  const before = storage.footprint();
  for (let step = 0; step < 100 && storage.footprint() === before; step += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
  return storage.footprint();
}

describe("存储占用测量", () => {
  let handle: StorageHandle | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle !== undefined) {
      await handle.dispose();
      removeTempDataDir(handle.dataDir);
      handle = undefined;
    }
  });

  it("模块启动后在后台测量：首轮完成前为 null，完成后只返回内存中的结果", async () => {
    const dataDir = createTempDataDir();
    const seeded = await startStorage(dataDir);
    seeded.port.transact((tx) => {
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
    await seeded.dispose();
    handle = await startStorage(dataDir, createFakeHost(), { retentionDays: { trace_spans: 30 } });
    const storage = handle.port as SqliteStorage;
    // 首轮排在启动之后的定时器里，start 返回时尚未读取任何一块。
    expect(storage.footprint()).toBeNull();
    await vi.waitFor(() => {
      expect(storage.footprint()).not.toBeNull();
    });
    const read = vi.spyOn(storage, "readOutsideTransaction");
    const footprint = storage.footprint();
    const seededRows: Readonly<Record<string, number>> = { trace_spans: 3, artifacts: 3, lifecycle_events: 1 };
    expect(footprint).toEqual({
      measuredAt: expect.stringMatching(/^2026-01-01T/),
      ...pageStats(storage),
      artifactBytes: { inline: 300, file: 70_000 },
      tables: measuredTables.map((table) => ({ table, rows: seededRows[table] ?? 0 })),
      retention: [{ table: "trace_spans", days: 30 }],
    });
    expect(storage.footprint()).toBe(footprint);
    expect(read).not.toHaveBeenCalled();
  });

  it("每次读取都是按 rowid 范围的有界单块查询，读取之前让出事件循环，结果与独立统计一致", async () => {
    handle = await startStorage(createTempDataDir());
    const storage = handle.port as SqliteStorage;
    const spans = 2_345;
    storage.transact((tx) => {
      for (let index = 0; index < spans; index += 1) {
        putSpan(tx, `spn-${String(index).padStart(5, "0")}`, "2026-01-01T00:00:00.000Z", "x");
      }
      for (let index = 0; index < 250; index += 1) {
        putArtifact(tx, `art-${String(index).padStart(4, "0")}`, 10 + index, index % 3 === 0 ? "file" : "inline");
      }
    });
    const events: string[] = [];
    const reads: { readonly sql: string; readonly params: readonly StorageValue[]; readonly rowCount: number }[] = [];
    const footprint = await measure(storage, {
      chunkRows: 100,
      pause: async () => {
        events.push("pause");
        await yieldToEventLoop();
      },
      read: (sql, params) => {
        events.push("read");
        const row = storage.readOutsideTransaction(sql, params);
        reads.push({ sql, params, rowCount: Number(row?.["row_count"]) });
        return row;
      },
    });
    // 任意两次读取之间都让出过事件循环：一轮测量不会在一次同步执行里连续读取。
    expect(events.filter((event, index) => event === "read" && events[index - 1] !== "pause")).toEqual([]);
    const chunkReads = reads.filter((entry) => entry.sql !== footprintStatements.pageBytes);
    expect(chunkReads.length).toBe(reads.length - 1);
    for (const entry of chunkReads) {
      expect(entry.params[1]).toBe(100);
      expect(entry.rowCount).toBeLessThanOrEqual(100);
    }
    expect(chunkReads.filter((entry) => entry.sql === footprintStatements.chunks.trace_spans).map((entry) => entry.rowCount))
      .toEqual([...Array.from({ length: 23 }, () => 100), 45]);
    expect(chunkReads.filter((entry) => entry.sql === footprintStatements.chunks.artifacts).map((entry) => entry.rowCount))
      .toEqual([100, 100, 50]);
    expect(footprint).toEqual({
      measuredAt: "2026-03-01T00:00:00.000Z",
      ...pageStats(storage),
      ...independentStats(storage),
      retention: [],
    });
    expect(rowsOf(footprint, "trace_spans")).toBe(spans);
  });

  it("分块语句只按 rowid 范围读取，被测表都是 rowid 表；清理批次语句只扫描覆盖索引", async () => {
    handle = await startStorage(createTempDataDir());
    const { port } = handle;
    for (const table of measuredTables) {
      // eslint-disable-next-line security/detect-object-injection -- table 来自固定的被测表清单。
      const plan = queryPlan(port, footprintStatements.chunks[table]);
      expect(plan).toContain(`SEARCH ${table} USING INTEGER PRIMARY KEY (rowid>?)`);
      expect(plan.filter((detail) => detail.startsWith(`SCAN ${table}`))).toEqual([]);
    }
    const withoutRowid = port.transact((tx) => tx.all("SELECT name FROM pragma_table_list WHERE schema = 'main' AND wr = 1"))
      .map((row) => String(row["name"]));
    expect(measuredTables.filter((table) => withoutRowid.includes(table))).toEqual([]);
    expect(queryPlan(port, pruneBatchStatements.trace_spans))
      .toContain("SEARCH trace_spans USING COVERING INDEX trace_spans_started_at (started_at<?)");
  });

  it("中止后不再读取，也不产出只覆盖部分表的结果", async () => {
    handle = await startStorage(createTempDataDir());
    const storage = handle.port as SqliteStorage;
    const controller = new AbortController();
    let reads = 0;
    const result = await measure(storage, {
      signal: controller.signal,
      read: (sql, params) => {
        reads += 1;
        if (reads === 3) {
          controller.abort();
        }
        return storage.readOutsideTransaction(sql, params);
      },
    });
    expect(result).toBeNull();
    expect(reads).toBe(3);
  });

  it("按间隔重测，健康读取之间不重新统计；关闭连接取消进行中的一轮", async () => {
    vi.useFakeTimers();
    const dataDir = createTempDataDir();
    handle = await startStorage(dataDir);
    const storage = handle.port as SqliteStorage;
    expect(storage.footprint()).toBeNull();
    const first = await settleMeasurement(storage);
    expect(rowsOf(first, "trace_spans")).toBe(0);
    storage.transact((tx) => {
      putSpan(tx, "spn-1", "2026-01-01T00:00:00.000Z", "a");
    });
    await vi.advanceTimersByTimeAsync(footprintIntervalMs - 1);
    expect(storage.footprint()).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    const second = await settleMeasurement(storage);
    expect(rowsOf(second, "trace_spans")).toBe(1);

    // 推进到下一轮开始，只放行前几块读取，然后在两块之间关闭。
    const read = vi.spyOn(storage, "readOutsideTransaction");
    await vi.advanceTimersByTimeAsync(footprintIntervalMs);
    await vi.advanceTimersByTimeAsync(1);
    const readsBeforeClose = read.mock.calls.length;
    expect(readsBeforeClose).toBeGreaterThan(0);
    expect(readsBeforeClose).toBeLessThan(measuredTables.length + 1);
    expect(storage.footprint()).toBe(second);
    const closing = handle;
    handle = undefined;
    await closing.dispose();
    expect(storage.footprint()).toBeNull();
    await vi.advanceTimersByTimeAsync(footprintIntervalMs * 2);
    expect(read).toHaveBeenCalledTimes(readsBeforeClose);
    expect(vi.getTimerCount()).toBe(0);
    expect(closing.host.logs.filter((log) => log.level === "error")).toEqual([]);
    removeTempDataDir(dataDir);
  });

  it("清理删除行后空闲页增加，主库页面字节不缩小", async () => {
    handle = await startStorage(createTempDataDir());
    const storage = handle.port as SqliteStorage;
    const padding = "x".repeat(2_000);
    storage.transact((tx) => {
      for (let index = 0; index < 400; index += 1) {
        putSpan(tx, `spn-${String(index).padStart(4, "0")}`, "2026-01-01T00:00:00.000Z", padding);
      }
    });
    const before = await measure(storage);
    await runRetentionPass({
      storage,
      host: { ...handle.host, nowIso: () => "2026-03-01T00:00:00.000Z" },
      retentionDays: { trace_spans: 30 },
      signal: new AbortController().signal,
    });
    const after = await measure(storage);
    expect(rowsOf(after, "trace_spans")).toBe(0);
    expect(after?.databaseBytes).toBe(before?.databaseBytes);
    expect((after?.freeBytes ?? 0) - (before?.freeBytes ?? 0)).toBeGreaterThan(400 * 2_000 * 0.9);
  });
});
