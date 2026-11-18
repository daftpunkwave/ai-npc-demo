/**
 * 验证存储验收中的记忆 revision 重建：按 created/retired revision 查询历史视图，并与 plan_hash 链一致。
 * 依赖存储模块测试助手与存储端口的分支级表读写接口。
 * 禁止原地 UPDATE 记忆内容列；历史视图必须由追加的行版本重建。
 */
import { describe, expect, it } from "vitest";
import type { StoragePort, StorageRow } from "@ai-npc/contracts";
import { openStorageHarness } from "./support";

const BRANCH_ID = "brn-memory";
const AGENT_ID = "agt-cenyan";

/** 存储文档中的可见性查询：在 revision R 生效且状态为 active 的记忆行版本。 */
const VISIBLE_AT_REVISION_SQL = `SELECT memory_id, row_version, content_json FROM memory_records
  WHERE branch_id = ? AND agent_id = ?
    AND created_revision <= ?
    AND (retired_revision IS NULL OR retired_revision > ?)
    AND status = 'active'
  ORDER BY memory_id, row_version`;

function memoryRow(rowVersion: number, createdRevision: number, retiredRevision: number | null, text: string): StorageRow {
  return {
    agent_id: AGENT_ID,
    memory_id: "mem-1",
    row_version: rowVersion,
    module_id: "agent.memory.ledger",
    kind: "episodic",
    tier: "long",
    status: "active",
    epistemic: "verified-event",
    release_policy_id: "policy-1",
    valid_from_tick: 0,
    valid_until_tick: null,
    created_revision: createdRevision,
    retired_revision: retiredRevision,
    strength: 1,
    salience: 0,
    recall_count: 0,
    tags_json: [],
    source_observation_ids_json: [],
    content_json: { text },
  };
}

function revisionRow(revision: number, baseRevision: number, planHash: string, changeKind: string): StorageRow {
  return {
    agent_id: AGENT_ID,
    revision,
    base_revision: baseRevision,
    observation_seq_through: revision,
    world_seq_through: revision * 2,
    change_kind: changeKind,
    plan_hash: planHash,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function seedMemory(port: StoragePort): void {
  port.transact((tx) => {
    const records = tx.branch(BRANCH_ID).table("memory_records");
    records.put(memoryRow(1, 5, 9, "v5"));
    records.put(memoryRow(2, 9, null, "v9"));
    records.put({ ...memoryRow(1, 3, null, "kept"), memory_id: "mem-2" });
    const revisions = tx.branch(BRANCH_ID).table("memory_revisions");
    revisions.put(revisionRow(0, 0, "plan-0", "init"));
    revisions.put(revisionRow(5, 0, "plan-5", "ingest"));
    revisions.put(revisionRow(9, 5, "plan-9", "maintenance"));
  });
}

function visibleAt(
  port: StoragePort,
  revision: number,
): readonly { memoryId: unknown; rowVersion: unknown; text: string }[] {
  return port.transact((tx) =>
    tx.all(VISIBLE_AT_REVISION_SQL, [BRANCH_ID, AGENT_ID, revision, revision]).map((row) => {
      const content = JSON.parse(String(row["content_json"])) as { readonly text: string };
      return { memoryId: row["memory_id"], rowVersion: row["row_version"], text: content.text };
    }),
  );
}

describe("按 revision 重建记忆", () => {
  it("revision 5 与 9 看到不同的行版本，且与 plan_hash 链一致", async () => {
    const harness = await openStorageHarness();
    try {
      seedMemory(harness.port);
      expect(visibleAt(harness.port, 5)).toEqual([
        { memoryId: "mem-1", rowVersion: 1, text: "v5" },
        { memoryId: "mem-2", rowVersion: 1, text: "kept" },
      ]);
      expect(visibleAt(harness.port, 9)).toEqual([
        { memoryId: "mem-1", rowVersion: 2, text: "v9" },
        { memoryId: "mem-2", rowVersion: 1, text: "kept" },
      ]);
      const chain = harness.port.transact((tx) =>
        tx
          .branch(BRANCH_ID)
          .table("memory_revisions")
          .list(undefined, { orderBy: [{ column: "revision" }] })
          .map((row) => ({ revision: row["revision"], base: row["base_revision"], plan: row["plan_hash"] })),
      );
      expect(chain).toEqual([
        { revision: 0, base: 0, plan: "plan-0" },
        { revision: 5, base: 0, plan: "plan-5" },
        { revision: 9, base: 5, plan: "plan-9" },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("新 revision 通过退役旧行版本而不是原地更新来发布", async () => {
    const harness = await openStorageHarness();
    try {
      seedMemory(harness.port);
      harness.port.transact((tx) => {
        const records = tx.branch(BRANCH_ID).table("memory_records");
        records.put(memoryRow(2, 9, 12, "v9"));
        records.put(memoryRow(3, 12, null, "v12"));
      });
      expect(visibleAt(harness.port, 9)).toEqual([
        { memoryId: "mem-1", rowVersion: 2, text: "v9" },
        { memoryId: "mem-2", rowVersion: 1, text: "kept" },
      ]);
      expect(visibleAt(harness.port, 12)).toEqual([
        { memoryId: "mem-1", rowVersion: 3, text: "v12" },
        { memoryId: "mem-2", rowVersion: 1, text: "kept" },
      ]);
    } finally {
      await harness.dispose();
    }
  });
});
