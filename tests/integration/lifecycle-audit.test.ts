/**
 * 验证生命周期审计统一契约的写入与控制台时间线按事件类型的读取。
 * 使用真实 SQLite 与观测模块，观测模块按宿主同样的组合绑定数据源查询；存量记录按旧写入格式预置，新记录经统一契约写入。
 * 禁止用假存储替代真实适配器，或把领域事件写入 lifecycle_events。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObservabilitySources, serverModuleDefinitions } from "@world-prism/app-server";
import type { Json, StoragePort } from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import type { ObservabilityPort } from "@world-prism/mod-platform-observability-sqlite";
import { createFakeHost } from "./authority-support";

const branchId = "br-000000000042";

/** 用真实存储与观测模块装配审计契约的最小验证环境。 */
async function auditHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), "world-prism-lifecycle-audit-"));
  const host = createFakeHost();
  const signal = new AbortController().signal;
  const create = (
    moduleId: string,
    ports: Readonly<Record<string, unknown>> = {},
    config: Json = {},
  ) => {
    const module = serverModuleDefinitions.find(({ id }) => id === moduleId);
    if (module === undefined) throw new Error(`Test provider missing: ${moduleId}`);
    return module.create({ host, signal, moduleId, ports, config, realm: "server", scope: {} });
  };
  const storageInstance = await create("platform.storage.sqlite", {}, { dataDir });
  await storageInstance.start(signal);
  const storage = storageInstance.port as StoragePort;
  const observabilityInstance = await create("platform.observability.sqlite", { "platform.storage": storage }, { timelineLimit: 200 });
  await observabilityInstance.start(signal);
  const observability = observabilityInstance.port as ObservabilityPort;
  // 时间线只读事件与审计，不读取时钟或角色位置。
  observability.bind(createObservabilitySources({
    storage,
    host,
    worldTick: () => {
      throw new Error("审计用例不读取时钟");
    },
    worldIn: () => {
      throw new Error("审计用例不读取角色位置");
    },
  }));
  return {
    storage,
    observability,
    async dispose() {
      await observabilityInstance.dispose();
      await storageInstance.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 以统一契约前的旧写入格式（手工 SQL 加 JSON.stringify）预置一条存量生命周期事件。 */
function seedLegacyEvent(storage: StoragePort, type: string, payload: Json): void {
  storage.transact((tx) => {
    tx.run(
      "INSERT INTO lifecycle_events (run_id, branch_id, type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["run-000000000001", branchId, type, "npc-fixture-agent", JSON.stringify(payload), "2026-01-01T00:00:00.000Z"],
    );
  });
}

describe("生命周期审计统一契约", () => {
  it("时间线按事件类型读出存量记录与统一契约新写入的记录", async () => {
    const harness = await auditHarness();
    try {
      seedLegacyEvent(harness.storage, "ClockAutoPaused", { reason: "players-disconnected", afterMs: 600 });
      harness.storage.transact((tx) => {
        insertLifecycleAuditEvent(tx, {
          runId: "run-000000000001", branchId, type: "ClockAutoPaused", subjectId: "npc-fixture-agent",
          payload: { reason: "players-disconnected", afterMs: 900 }, createdAt: "2026-01-01T00:01:00.000Z",
        });
        insertLifecycleAuditEvent(tx, {
          runId: "run-000000000001", branchId, type: "WorkerFailed", subjectId: "system:tick-worker",
          payload: { message: "tick boom", worldTick: 7 }, createdAt: "2026-01-01T00:02:00.000Z",
        });
      });
      const byType = harness.observability.timeline({ branchId, fromSeq: 0, limit: 50, types: ["ClockAutoPaused"] });
      expect(byType.events.map((event) => [event.kind, event.payload])).toEqual([
        ["lifecycle", { reason: "players-disconnected", afterMs: 600 }],
        ["lifecycle", { reason: "players-disconnected", afterMs: 900 }],
      ]);
      expect(byType.events[0]?.principalId).toBe("npc-fixture-agent");
      const all = harness.observability.timeline({ branchId, fromSeq: 0, limit: 50 });
      expect(all.events).toHaveLength(3);
    } finally {
      await harness.dispose();
    }
  });

  it("统一契约按字段契约写列并将 payload 序列化为规范 JSON", async () => {
    const harness = await auditHarness();
    try {
      harness.storage.transact((tx) => {
        insertLifecycleAuditEvent(tx, {
          runId: null, branchId, type: "ClockAutoPaused", subjectId: null,
          payload: { worldTick: 3, reason: "players-disconnected" }, createdAt: "2026-01-01T00:00:00.000Z",
        });
      });
      const rows = harness.storage.transact((tx) =>
        tx.all("SELECT run_id, branch_id, type, subject_id, payload_json, created_at FROM lifecycle_events"),
      );
      expect(rows).toEqual([
        {
          run_id: null, branch_id: branchId, type: "ClockAutoPaused", subject_id: null,
          payload_json: '{"reason":"players-disconnected","worldTick":3}', created_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("契约插入与调用方事务内的其他写入保持原子", async () => {
    const harness = await auditHarness();
    try {
      expect(() =>
        harness.storage.transact((tx) => {
          insertLifecycleAuditEvent(tx, {
            runId: "run-000000000001", branchId, type: "ModelCredentialRedacted",
            subjectId: "npc-fixture-agent", payload: { attemptId: "att-000000000001" },
            createdAt: "2026-01-01T00:00:00.000Z",
          });
          throw new Error("调用方写入失败");
        }),
      ).toThrow("调用方写入失败");
      expect(harness.storage.transact((tx) => tx.all("SELECT seq FROM lifecycle_events"))).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });
});
