/**
 * 核心职责：用 agent-runtime 的生产 SQL 对真实 SQLite 断言查询计划，确认热路径确实命中 0016 的部分索引。
 * 交互契约：依赖存储模块启动真实 SQLite、agent-runtime 导出的查询常量与迁移定义的索引。
 * 约束与禁忌：禁止另写一份字面量 SQL 副本代替生产查询——参数化会让部分索引失效，
 *   副本的查询计划说明不了生产行为；也不得把索引条件退化成全表扫描后仍判为通过。
 */
import { describe, expect, it } from "vitest";
import {
  cancelActiveTurnsSql,
  latestDayPassedSql,
  pendingTriggersSql,
  recoverExpiredTurnsSql,
} from "@world-prism/agent-runtime";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import type { StoragePort, StorageTransaction } from "@world-prism/contracts";
import { createFakeHost } from "./authority-support";

const resources: { readonly dispose: () => Promise<void> }[] = [];

async function openStorage(): Promise<StoragePort> {
  const host = createFakeHost();
  const dataDir = `./data-agent-hot-path-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    host,
    signal: new AbortController().signal,
    ports: {},
    logger: host.logger,
  } as never);
  resources.push(instance);
  await instance.start(new AbortController().signal);
  return instance.port as StoragePort;
}

function planOf(storage: StoragePort, sql: string, params: readonly unknown[]): string {
  return storage
    .transact((tx: StorageTransaction) =>
      tx.all(`EXPLAIN QUERY PLAN ${sql}`, params as never),
    )
    .map((row) => String(row["detail"]))
    .join("\n");
}

describe("Agent 热路径查询计划", () => {
  it("生产 SQL 命中部分索引，不退回全表扫描", async () => {
    const storage = await openStorage();
    const branchId = "br-000000000001";

    // 参数化 SQL 保留占位符；状态词内联为字面量才能让 SQLite 采信部分索引的谓词。
    const triggers = planOf(storage, pendingTriggersSql, [branchId]);
    expect(triggers).toContain("triggers_pending");
    expect(triggers).not.toContain("SCAN triggers");

    const cancel = planOf(storage, cancelActiveTurnsSql, [branchId]);
    expect(cancel).toContain("turn_runs_active");
    expect(cancel).not.toContain("SCAN turn_runs");

    const expired = planOf(storage, recoverExpiredTurnsSql, [branchId, "2026-01-01T00:00:00.000Z"]);
    expect(expired).toContain("turn_runs_active");
    expect(expired).not.toContain("SCAN turn_runs");
  });

  it("按活跃集取 turn 的结果只含非终态行", async () => {
    const storage = await openStorage();
    const branchId = "br-000000000001";
    storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      const base = {
        run_id: "run-000000000001",
        branch_id: branchId,
        agent_id: "human-independent",
        input_frontier_json: null,
        memory_revision: null,
        profile_hash: "profile",
        controller_epoch: 1,
        turn_lease_epoch: 0,
        lease_expires_at: null,
        terminal_reason: null,
        effective_json: [],
        created_at: "2026-01-01T00:00:00.000Z",
        created_tick: 1,
        started_at: null,
        ended_at: null,
      };
      turns.put({ ...base, turn_id: "turn-000000000001", agent_turn_index: 1, status: "waiting", trigger_ids_json: [] });
      turns.put({ ...base, turn_id: "turn-000000000002", agent_turn_index: 2, status: "completed", trigger_ids_json: [] });
    });

    const rows = storage.transact((tx) => tx.all(cancelActiveTurnsSql, [branchId]));
    expect(rows.map((row) => row["turn_id"])).toEqual(["turn-000000000001"]);
  });
});

describe("最近 DayPassed 查询计划", () => {
  it("生产查询命中表达式部分索引", async () => {
    const storage = await openStorage();
    const plan = planOf(storage, latestDayPassedSql, ["br-000000000001", "human-independent"]);
    expect(plan).toContain("observations_day_passed");
    expect(plan).not.toContain("SCAN observations");
    expect(plan).not.toContain("USE TEMP B-TREE");
  });
});
