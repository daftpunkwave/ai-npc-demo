/**
 * 验证记忆 revision 视图改由 SQL 过滤可见行后，与「读出全部行版本再在内存中筛选」的旧口径逐 revision 一致：
 * 被替换、被撤回、尚未创建与其他 Agent 的行都不可见，公共编年史按 revision 冻结的公共版本合并。
 * 依赖 node:sqlite 内存库执行生产查询，存储端口只实现 revision 视图用到的成员。
 * 禁止用记录 SQL 文本的假实现代替真实执行，或只校验单个 revision。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HostServices,
  StoragePort,
  StorageRawRow,
  StorageRow,
  StorageTransaction,
  StorageValue,
} from "@world-prism/contracts";
import type { MemoryAgentIdentity } from "@world-prism/module-sdk";
import { MemoryStore } from "../src/memory-store";
import { decodeMemoryRow, parseRecord } from "../src/memory-row-codec";
import { publicMemoryAgentId } from "../src/memory-public-records";

const branchId = "br-000000000001";
const agentId = "human-independent";
const host = {} as HostServices;
const identity = {} as MemoryAgentIdentity;

/** revision → 该 revision 冻结的公共编年史版本。 */
const publicRevisionOf: Readonly<Record<number, number>> = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 2 };

interface MemoryRowSeed {
  readonly agent: string;
  readonly memoryId: string;
  readonly rowVersion: number;
  readonly status: string;
  readonly created: number;
  readonly retired: number | null;
}

const seeds: readonly MemoryRowSeed[] = [
  // m1：revision 3 被新行版本替换。
  { agent: agentId, memoryId: "mem-m1", rowVersion: 1, status: "active", created: 1, retired: 3 },
  { agent: agentId, memoryId: "mem-m1", rowVersion: 2, status: "active", created: 3, retired: null },
  // m2：revision 4 被撤回，撤回行本身不是 active。
  { agent: agentId, memoryId: "mem-m2", rowVersion: 1, status: "active", created: 2, retired: 4 },
  { agent: agentId, memoryId: "mem-m2", rowVersion: 2, status: "retracted", created: 4, retired: null },
  // m3：revision 5 才创建。
  { agent: agentId, memoryId: "mem-m3", rowVersion: 1, status: "active", created: 5, retired: null },
  // 其他 Agent 的行始终不可见。
  { agent: "human-neutral", memoryId: "mem-x1", rowVersion: 1, status: "active", created: 1, retired: null },
  // 公共编年史：按冻结的公共版本合并。
  { agent: publicMemoryAgentId, memoryId: "mem-p1", rowVersion: 1, status: "active", created: 1, retired: null },
  { agent: publicMemoryAgentId, memoryId: "mem-p2", rowVersion: 1, status: "active", created: 2, retired: null },
];

/** revision 视图只用到原始查询与 memory_revisions 点查；其余成员抛错，防止回退到整表读取。 */
function sqliteStorage(database: DatabaseSync): StoragePort {
  const unused = (): never => {
    throw new Error("revision view must not use this storage member");
  };
  const transaction: StorageTransaction = {
    get: unused,
    all: (sql: string, params: readonly StorageValue[] = []) =>
      database.prepare(sql).all(...(params as (string | number | null)[])) as unknown as readonly StorageRawRow[],
    run: unused,
    rows: unused,
    branch: () => ({
      branchId,
      table: (name: string) => {
        if (name !== "memory_revisions") return unused();
        return {
          table: name,
          get: (key) => {
            const revision = Number(key["revision"]);
            const publicRevision = publicRevisionOf[revision];
            return publicRevision === undefined ? null : { public_revision: publicRevision, derived_through_seq: 0 };
          },
          list: unused,
          put: unused,
          delete: unused,
          count: unused,
          max: unused,
        };
      },
    }),
    savepoint: <T,>(_name: string, fn: () => T): T => fn(),
  };
  return {
    transact: <T,>(fn: (tx: StorageTransaction) => T): T => fn(transaction),
    forkBranch: unused,
    backup: unused,
    artifactFiles: { inlineMaxBytes: 0, write: unused, read: unused, remove: unused },
  };
}

/** 旧口径：读出某主体全部行版本后在内存中按 revision 可见性筛选。 */
function visibleInMemory(rows: readonly StorageRow[], agent: string, revision: number): readonly StorageRow[] {
  return rows.filter((row) =>
    row["agent_id"] === agent &&
    Number(row["created_revision"]) <= revision &&
    (row["retired_revision"] === null || Number(row["retired_revision"]) > revision) &&
    row["status"] === "active");
}

describe("记忆 revision 视图的可见性查询", () => {
  let database: DatabaseSync;
  let allRows: readonly StorageRow[];

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE memory_records (
      branch_id TEXT NOT NULL, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL, row_version INTEGER NOT NULL,
      module_id TEXT NOT NULL, kind TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL, epistemic TEXT NOT NULL,
      release_policy_id TEXT NOT NULL, valid_from_tick INTEGER NOT NULL, valid_until_tick INTEGER,
      created_revision INTEGER NOT NULL, retired_revision INTEGER, strength REAL NOT NULL DEFAULT 1,
      salience REAL NOT NULL DEFAULT 0, recall_count INTEGER NOT NULL DEFAULT 0, tags_json TEXT NOT NULL,
      source_observation_ids_json TEXT NOT NULL, content_json TEXT NOT NULL,
      PRIMARY KEY (branch_id, agent_id, memory_id, row_version)
    )`);
    const insert = database.prepare(`INSERT INTO memory_records VALUES
      (?, ?, ?, ?, 'agent.memory.ledger', 'episodic', 'short', ?, 'verified-event', 'public', 0, NULL, ?, ?, 0.5, 0.25, 0,
       ?, '["obs-000000000001"]', ?)`);
    for (const seed of seeds) {
      insert.run(branchId, seed.agent, seed.memoryId, seed.rowVersion, seed.status, seed.created, seed.retired,
        JSON.stringify(["tag"]), JSON.stringify({ summaryZh: `${seed.memoryId}@${String(seed.rowVersion)}`, counterpartIds: [] }));
    }
    allRows = (database.prepare("SELECT * FROM memory_records").all() as unknown as StorageRawRow[])
      .map((row) => decodeMemoryRow(row));
  });

  afterEach(() => {
    database.close();
  });

  it("每个 revision 的可见集合与内存筛选口径一致", () => {
    const store = new MemoryStore(sqliteStorage(database), host, "wld-000000000001", branchId, "run-000000000001");
    for (const revision of [0, 1, 2, 3, 4, 5, 6]) {
      const publicRevision = publicRevisionOf[revision] ?? 0;
      const expected = [
        ...visibleInMemory(allRows, agentId, revision),
        ...visibleInMemory(allRows, publicMemoryAgentId, publicRevision),
      ]
        .map((row) => parseRecord(row))
        .sort((left, right) => left.memoryId.localeCompare(right.memoryId) || left.rowVersion - right.rowVersion);
      expect(store.readRevisionView(agentId, identity, revision).records).toEqual(expected);
    }
  });

  it("按 revision 取到的是对应的行版本", () => {
    const store = new MemoryStore(sqliteStorage(database), host, "wld-000000000001", branchId, "run-000000000001");
    const summaries = (revision: number): string[] =>
      store.readRevisionView(agentId, identity, revision).records.map((record) => record.content.summaryZh);
    expect(summaries(2)).toEqual(["mem-m1@1", "mem-m2@1", "mem-p1@1"]);
    expect(summaries(4)).toEqual(["mem-m1@2", "mem-p1@1", "mem-p2@1"]);
    expect(summaries(5)).toEqual(["mem-m1@2", "mem-m3@1", "mem-p1@1", "mem-p2@1"]);
  });

  it("原始行解码还原三个 JSON 列，其余列原样保留", () => {
    const row = allRows.find((entry) => entry["memory_id"] === "mem-m1" && entry["row_version"] === 2);
    expect(row).toMatchObject({
      branch_id: branchId,
      agent_id: agentId,
      created_revision: 3,
      retired_revision: null,
      strength: 0.5,
      tags_json: ["tag"],
      source_observation_ids_json: ["obs-000000000001"],
      content_json: { summaryZh: "mem-m1@2", counterpartIds: [] },
    });
  });
});
