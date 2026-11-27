/**
 * 核心职责：验证存储保留策略：表分类覆盖全部迁移表且可轮转清单只含观测表，配置 schema 只接受可轮转表，
 *   清理按截止时间分批删除过期行并留下与已提交删除一致的审计记录，未配置时不调度、不删除；
 *   调度在每个间隔后真正执行下一轮，模块 dispose 之后越过间隔也不再执行。
 * 交互契约：依赖真实 SQLite 临时目录、存储模块测试助手、保留期实现与 module-sdk 的生命周期审计写入。
 * 约束与禁忌：禁止用假存储替代真实适配器，禁止让测试共享数据目录，或只断言行数减少而不核对删除了哪些行。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoragePort, StorageTransaction } from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import { retentionDaysSchema, storageConfigSchema } from "../src/definition";
import {
  retentionAuditType,
  retentionIntervalMs,
  runRetentionPass,
  startRetentionSchedule,
  type RetentionPassInput,
} from "../src/sqlite/retention";
import { createFakeHost, createTempDataDir, removeTempDataDir, startStorage, type StorageHandle } from "./support";

/**
 * 不参与保留期清理的表，分组与存储文档的保留策略一致。新增迁移表时必须在这里或 retentionDaysSchema 中登记，
 * 否则分类完整性用例失败。
 */
const retainedTables = {
  worldFacts: [
    "worlds", "branches", "world_aliases", "clock", "aggregate_state", "domain_events", "speech_commits", "jobs",
    "rule_failures", "clock_stop_requests", "consumer_offsets", "consumer_inbox", "agent_activations",
    "controller_leases", "observations", "perception_state", "triggers", "operations", "snapshots",
  ],
  memory: ["memory_records", "memory_revisions", "memory_watermarks"],
  auditAndIdempotency: [
    "command_receipts", "lifecycle_events", "operation_idempotency", "run_control_idempotency", "schema_migrations",
  ],
  experimentEvidence: [
    "runs", "turn_runs", "maintenance_runs", "model_attempts", "tool_calls", "artifacts", "budget_ledger",
    "experiment_results", "probe_results",
  ],
  controlState: ["sessions", "stream_tickets", "scenario_drafts", "run_requests", "config_drafts"],
} as const;

const rotatableTables = Object.keys(retentionDaysSchema.shape);

const now = "2026-03-01T00:00:00.000Z";
const cutoff30 = "2026-01-30T00:00:00.000Z";

function listTables(tx: StorageTransaction): readonly string[] {
  return tx.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => String(row["name"]));
}

function tableNames(storage: StoragePort): readonly string[] {
  return storage.transact(listTables);
}

function tableCounts(storage: StoragePort): Readonly<Record<string, number>> {
  return storage.transact((tx) => Object.fromEntries(listTables(tx).map((name) =>
    [name, Number(tx.get(`SELECT COUNT(*) AS count FROM "${name}"`)?.["count"])])));
}

function putSpan(tx: StorageTransaction, spanId: string, startedAt: string | null): void {
  tx.rows("trace_spans").put({
    span_id: spanId, trace_id: `trc-${spanId}`, parent_span_id: null, run_id: null, branch_id: null, agent_id: null,
    turn_id: null, module_id: null, module_version: null, name: "http.request", status: "ok", start_ms: 0, end_ms: 1,
    started_at: startedAt, attrs_json: { route: "/api/v1/health" },
  });
}

function spanIds(storage: StoragePort): readonly string[] {
  return storage.transact((tx) => tx.all("SELECT span_id FROM trace_spans ORDER BY span_id").map((row) => String(row["span_id"])));
}

function retentionAudits(storage: StoragePort): readonly Record<string, unknown>[] {
  return storage.transact((tx) => tx.all(
    "SELECT run_id, branch_id, subject_id, payload_json, created_at FROM lifecycle_events WHERE type = ? ORDER BY seq",
    [retentionAuditType],
  ).map((row) => ({ ...row, payload_json: JSON.parse(String(row["payload_json"])) as unknown })));
}

/**
 * 写入五条早于 30 天截止时间的跨度、一条恰在截止时间、两条更新的跨度与一条没有墙上时钟的早期跨度，
 * 并在其他表放入同样陈旧的事实与审计行。
 */
function seedAgedRows(storage: StoragePort): void {
  storage.transact((tx) => {
    for (const [index, day] of ["01", "05", "10", "20", "29"].entries()) {
      putSpan(tx, `spn-old-${index}`, `2026-01-${day}T12:00:00.000Z`);
    }
    putSpan(tx, "spn-at-cutoff", cutoff30);
    putSpan(tx, "spn-new-0", "2026-02-15T00:00:00.000Z");
    putSpan(tx, "spn-new-1", "2026-02-28T23:59:59.000Z");
    putSpan(tx, "spn-legacy", null);
    insertLifecycleAuditEvent(tx, {
      runId: null, branchId: null, type: "ClockAutoPaused", subjectId: "system:offline-timeout",
      payload: { reason: "陈旧的控制事件" }, createdAt: "2025-01-01T00:00:00.000Z",
    });
    tx.rows("artifacts").put({
      artifact_id: "art-old", run_id: null, kind: "tool-raw", content_hash: "hash", mime: "application/json",
      byte_size: 2, storage: "inline", body: new TextEncoder().encode("{}"), file_path: null, redaction: "raw",
      redacted_from: null, created_at: "2025-01-01T00:00:00.000Z",
    });
  });
}

function passInput(handle: StorageHandle, overrides: Partial<RetentionPassInput> = {}): RetentionPassInput {
  return {
    storage: handle.port,
    host: { ...handle.host, nowIso: () => now },
    retentionDays: { trace_spans: 30 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("存储保留策略", () => {
  let handle: StorageHandle | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (handle !== undefined) {
      await handle.dispose();
      removeTempDataDir(handle.dataDir);
      handle = undefined;
    }
  });

  /** 启动存储并等后台首轮占用测量完成，避免它的让出在用例切换到受控定时器后混入定时器计数。 */
  const open = async (extraConfig: Parameters<typeof startStorage>[2] = {}): Promise<StorageHandle> => {
    const opened = await startStorage(createTempDataDir(), createFakeHost(), extraConfig);
    handle = opened;
    await vi.waitFor(() => {
      expect(opened.port.footprint?.()).not.toBeNull();
    });
    return opened;
  };

  it("每张迁移表恰好归入一类，可轮转清单只含观测跨度", async () => {
    const { port } = await open();
    const retained = Object.values(retainedTables).flat();
    expect(rotatableTables).toEqual(["trace_spans"]);
    expect(retained.filter((table) => rotatableTables.includes(table))).toEqual([]);
    expect(new Set(retained).size).toBe(retained.length);
    expect([...retained, ...rotatableTables].sort()).toEqual(tableNames(port));
    // 事实、审计与证据表即使被误加进可轮转清单，也会被上面的互斥断言拦下；这里逐表再核对一次关键表。
    for (const table of ["domain_events", "command_receipts", "memory_records", "artifacts", "tool_calls",
      "model_attempts", "lifecycle_events", "consumer_inbox", "probe_results", "experiment_results", "snapshots",
      "branches", "runs"]) {
      expect(rotatableTables).not.toContain(table);
    }
  });

  it("保留天数缺省时解析结果不含该键，只接受可轮转表与 1–36500 的整数天", () => {
    const base = { dataDir: "./data", inlineArtifactMaxBytes: 65536 };
    expect(storageConfigSchema.parse(base)).toEqual(base);
    expect(storageConfigSchema.parse({ ...base, retentionDays: { trace_spans: 30 } }))
      .toEqual({ ...base, retentionDays: { trace_spans: 30 } });
    expect(storageConfigSchema.parse({ ...base, retentionDays: {} })).toEqual({ ...base, retentionDays: {} });
    for (const retentionDays of [
      { domain_events: 30 }, { lifecycle_events: 30 }, { artifacts: 30 }, { trace_spans: 0 }, { trace_spans: -1 },
      { trace_spans: 1.5 }, { trace_spans: 36_501 }, { trace_spans: null },
    ]) {
      expect(storageConfigSchema.safeParse({ ...base, retentionDays }).success).toBe(false);
    }
  });

  it("未配置保留天数时不创建定时器，清理轮次也不删除任何行", async () => {
    const opened = await open();
    seedAgedRows(opened.port);
    const before = tableCounts(opened.port);
    vi.useFakeTimers();
    for (const retentionDays of [undefined, {}]) {
      expect(startRetentionSchedule({ storage: opened.port, host: opened.host, retentionDays })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await expect(runRetentionPass(passInput(opened, { retentionDays }))).resolves.toEqual([]);
    }
    expect(tableCounts(opened.port)).toEqual(before);
  });

  it("按截止时间分批删除过期跨度，其他表与未过期、无墙上时钟的跨度保持不变", async () => {
    const opened = await open();
    seedAgedRows(opened.port);
    const before = tableCounts(opened.port);
    const transact = vi.spyOn(opened.port, "transact");
    const results = await runRetentionPass(passInput(opened, { batchRows: 2 }));
    // 5 条过期行按每批 2 条分三批删除，最后一批不足一批即结束。
    expect(transact).toHaveBeenCalledTimes(3);
    transact.mockRestore();
    expect(results).toEqual([{ table: "trace_spans", retentionDays: 30, cutoff: cutoff30, deletedRows: 5 }]);
    expect(spanIds(opened.port)).toEqual(["spn-at-cutoff", "spn-legacy", "spn-new-0", "spn-new-1"]);
    const after = tableCounts(opened.port);
    expect(after).toEqual({ ...before, trace_spans: 4, lifecycle_events: Number(before["lifecycle_events"]) + 1 });
    expect(retentionAudits(opened.port)).toEqual([{
      run_id: null, branch_id: null, subject_id: "trace_spans", created_at: now,
      payload_json: { retentionDays: 30, cutoff: cutoff30, deletedRows: 5 },
    }]);
    expect(opened.host.logs).toContainEqual({
      level: "info",
      message: "存储保留期清理完成",
      data: { table: "trace_spans", retentionDays: 30, cutoff: cutoff30, deletedRows: 5 },
    });
  });

  it("没有过期行的轮次不写审计；再次清理不会重复计数", async () => {
    const opened = await open();
    seedAgedRows(opened.port);
    await runRetentionPass(passInput(opened));
    const results = await runRetentionPass(passInput(opened));
    expect(results).toEqual([{ table: "trace_spans", retentionDays: 30, cutoff: cutoff30, deletedRows: 0 }]);
    expect(retentionAudits(opened.port)).toHaveLength(1);
  });

  it("中途停止时审计行数与已提交的删除一致", async () => {
    const opened = await open();
    seedAgedRows(opened.port);
    const controller = new AbortController();
    const storage: RetentionPassInput["storage"] = {
      transact: (fn) => {
        const result = opened.port.transact(fn);
        // 第一批提交后立即停止，模拟模块在两批之间被 dispose。
        controller.abort();
        return result;
      },
    };
    const results = await runRetentionPass(passInput(opened, { storage, batchRows: 2, signal: controller.signal }));
    expect(results).toEqual([{ table: "trace_spans", retentionDays: 30, cutoff: cutoff30, deletedRows: 2 }]);
    expect(spanIds(opened.port)).toEqual([
      "spn-at-cutoff", "spn-legacy", "spn-new-0", "spn-new-1", "spn-old-2", "spn-old-3", "spn-old-4",
    ]);
    expect(retentionAudits(opened.port).map((row) => row["payload_json"]))
      .toEqual([{ retentionDays: 30, cutoff: cutoff30, deletedRows: 2 }]);
  });

  it("批次事务失败时回滚本批删除与审计，不留下无记录的删除", async () => {
    const opened = await open();
    seedAgedRows(opened.port);
    let calls = 0;
    const storage: RetentionPassInput["storage"] = {
      transact: (fn) => opened.port.transact((tx) => {
        const result = fn(tx);
        calls += 1;
        if (calls === 2) {
          throw new Error("第二批提交前失败");
        }
        return result;
      }),
    };
    await expect(runRetentionPass(passInput(opened, { storage, batchRows: 2 }))).rejects.toThrow("第二批提交前失败");
    expect(spanIds(opened.port)).toHaveLength(7);
    expect(retentionAudits(opened.port).map((row) => row["payload_json"]))
      .toEqual([{ retentionDays: 30, cutoff: cutoff30, deletedRows: 2 }]);
  });

  it("调度立即排入首轮，到间隔后第二轮删除首轮之后过期的跨度，stop 清除定时器", async () => {
    const opened = await open();
    seedAgedRows(opened.port);
    vi.useFakeTimers();
    const schedule = startRetentionSchedule({
      storage: opened.port, host: { ...opened.host, nowIso: () => now }, retentionDays: { trace_spans: 30 },
    });
    expect(schedule).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(spanIds(opened.port)).toEqual(["spn-at-cutoff", "spn-legacy", "spn-new-0", "spn-new-1"]);
    expect(retentionAudits(opened.port)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    // 首轮之后写入新的过期跨度：间隔未到时保持不动，到点后由第二轮删除并留下第二条清理记录。
    opened.port.transact((tx) => {
      putSpan(tx, "spn-late-0", "2026-01-15T00:00:00.000Z");
      putSpan(tx, "spn-late-1", "2026-01-20T00:00:00.000Z");
    });
    await vi.advanceTimersByTimeAsync(retentionIntervalMs - 1);
    expect(spanIds(opened.port)).toEqual([
      "spn-at-cutoff", "spn-late-0", "spn-late-1", "spn-legacy", "spn-new-0", "spn-new-1",
    ]);
    expect(retentionAudits(opened.port)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spanIds(opened.port)).toEqual(["spn-at-cutoff", "spn-legacy", "spn-new-0", "spn-new-1"]);
    expect(retentionAudits(opened.port).map((row) => row["payload_json"])).toEqual([
      { retentionDays: 30, cutoff: cutoff30, deletedRows: 5 },
      { retentionDays: 30, cutoff: cutoff30, deletedRows: 2 },
    ]);
    expect(vi.getTimerCount()).toBe(1);
    schedule?.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("模块启动后按配置执行首轮清理；dispose 之后越过间隔也不再执行清理", async () => {
    const dataDir = createTempDataDir();
    const seeded = await startStorage(dataDir);
    seedAgedRows(seeded.port);
    await seeded.dispose();
    vi.useFakeTimers();
    const host = { ...createFakeHost(), nowIso: () => now };
    const started = await startStorage(dataDir, host, { retentionDays: { trace_spans: 30 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(spanIds(started.port)).toEqual(["spn-at-cutoff", "spn-legacy", "spn-new-0", "spn-new-1"]);
    expect(retentionAudits(started.port)).toHaveLength(1);
    started.port.transact((tx) => {
      putSpan(tx, "spn-late-0", "2026-01-15T00:00:00.000Z");
    });
    // dispose 之后若仍有一轮被排上，它会经 transact 访问已关闭的连接并记录清理失败。
    const transact = vi.spyOn(started.port, "transact");
    await started.dispose();
    await vi.advanceTimersByTimeAsync(retentionIntervalMs * 2);
    expect(transact).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.logs.filter((log) => log.level === "error")).toEqual([]);
    vi.useRealTimers();
    // 重新打开核对落库状态：首轮之后过期的跨度仍在，清理记录仍只有首轮那一条。
    handle = await startStorage(dataDir);
    expect(spanIds(handle.port)).toContain("spn-late-0");
    expect(retentionAudits(handle.port)).toHaveLength(1);
  });
});
