/**
 * 验证 turn 就绪取观察的查询形状与结果合并：范围下推、上界恒定、去重升序。
 * 依赖记录 SQL 与参数的事务假实现，以及内联原始观察行夹具。
 * 禁止启动 SQLite、计时器或网络资源。
 */
import { describe, expect, it } from "vitest";
import type {
  MemoryScope,
  StorageRawRow,
  StorageTransaction,
  StorageValue,
} from "@ai-npc/contracts";
import { readTurnObservations } from "../src/turn-observations";

const scope: MemoryScope = {
  worldId: "wld-000000000001",
  branchId: "br-000000000001",
  agentId: "human-independent",
};

interface QueryRecord {
  readonly sql: string;
  readonly params: readonly StorageValue[];
}

function observationRow(sequence: number, eventIds: readonly string[] = [`evt-${String(sequence).padStart(12, "0")}`]): StorageRawRow {
  return {
    observation_id: `obs-${String(sequence).padStart(12, "0")}`,
    observation_seq: sequence,
    source_event_ids_json: JSON.stringify(eventIds),
    source_observation_ids_json: "[]",
    occurred_at_tick: sequence,
    sensed_at_tick: sequence,
    known_at_tick: sequence,
    channel: "party",
    epistemic: "witnessed",
    confidence: 1,
    release_policy_id: "parties:human-independent,player-1",
    content_json: JSON.stringify({ eventType: "MetersChanged", summaryZh: `观察 ${sequence}` }),
  };
}

/**
 * 记录查询并按 SQL 形状应答的事务假实现：
 * 主区间查询与 json_each 补充查询走不同的固定结果，表级接口一律记一次误用并抛错。
 */
function recordingTransaction(rows: {
  readonly range: readonly StorageRawRow[];
  readonly source: readonly StorageRawRow[];
}): { readonly tx: StorageTransaction; readonly queries: QueryRecord[]; readonly tableReads: () => number } {
  const queries: QueryRecord[] = [];
  let tableReads = 0;
  const unused = (): never => {
    throw new Error("turn observation read must not use table access");
  };
  const table = {
    table: "unused",
    get: (): never => {
      tableReads += 1;
      throw new Error("turn observation read must not look observations up row by row");
    },
    list: unused,
    put: unused,
    delete: unused,
    count: unused,
    max: unused,
  };
  const tx: StorageTransaction = {
    get: unused,
    all: (sql: string, params: readonly StorageValue[] = []): readonly StorageRawRow[] => {
      queries.push({ sql, params });
      return sql.includes("json_each") ? rows.source : rows.range;
    },
    run: unused,
    rows: unused,
    branch: () => ({ branchId: scope.branchId, table: () => table }),
    savepoint: <T,>(_name: string, fn: () => T): T => fn(),
  };
  return { tx, queries, tableReads: () => tableReads };
}

const branchId = scope.branchId;
const agentId = scope.agentId;

describe("readTurnObservations", () => {
  it("pushes the seq range and source refs into SQL without table-level reads", () => {
    const { tx, queries, tableReads } = recordingTransaction({
      range: [observationRow(3), observationRow(4)],
      source: [],
    });

    const observations = readTurnObservations(tx, {
      branchId,
      agentId,
      scope,
      previousSeq: 2,
      throughSeq: 4,
      sourceRefs: ["evt-000000000001"],
    });

    expect(observations.map((observation) => observation.observationSeq)).toEqual([3, 4]);
    expect(tableReads()).toBe(0);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain("FROM observations");
    expect(queries[0]?.sql).toContain("observation_seq > ?");
    expect(queries[0]?.sql).toContain("ORDER BY observation_seq ASC");
    expect(queries[1]?.sql).toContain("json_each(observations.source_event_ids_json)");
  });

  it("bounds every query by the memory watermark seq", () => {
    const { tx, queries } = recordingTransaction({
      range: [observationRow(3)],
      source: [observationRow(1)],
    });

    readTurnObservations(tx, {
      branchId,
      agentId,
      scope,
      previousSeq: 2,
      throughSeq: 4,
      sourceRefs: ["evt-000000000001", "evt-000000000005"],
    });

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).toContain("observation_seq <= ?");
      expect(query.params).toContain(4);
    }
    // 主区间参数顺序固定为 (branch, agent, previous, through)，补充集把上界放在 IN 之前。
    expect(queries[0]?.params).toEqual([branchId, agentId, 2, 4]);
    expect(queries[1]?.params.slice(0, 3)).toEqual([branchId, agentId, 4]);
    expect(queries[1]?.params.slice(3)).toHaveLength(2);
  });

  it("merges both queries into one ascending list without duplicates", () => {
    const { tx } = recordingTransaction({
      // 故意乱序返回，确认合并后再排序，而不是依赖两段各自的顺序。
      range: [observationRow(4), observationRow(3)],
      source: [observationRow(3), observationRow(1)],
    });

    const observations = readTurnObservations(tx, {
      branchId,
      agentId,
      scope,
      previousSeq: 2,
      throughSeq: 4,
      sourceRefs: ["evt-000000000001"],
    });

    expect(observations.map((observation) => observation.observationSeq)).toEqual([1, 3, 4]);
    expect(observations.map((observation) => observation.observationId)).toEqual([
      "obs-000000000001",
      "obs-000000000003",
      "obs-000000000004",
    ]);
  });

  it("issues no supplementary query when the turn has no source refs", () => {
    const { tx, queries } = recordingTransaction({ range: [observationRow(3)], source: [] });

    const observations = readTurnObservations(tx, {
      branchId,
      agentId,
      scope,
      previousSeq: 2,
      throughSeq: 4,
      sourceRefs: [],
    });

    expect(observations.map((observation) => observation.observationSeq)).toEqual([3]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).not.toContain("json_each");
  });

  it("splits oversized source ref sets into bounded batches instead of truncating", () => {
    const sourceRefs = Array.from({ length: 501 }, (_value, index) => `evt-${String(index + 1).padStart(12, "0")}`);
    const { tx, queries } = recordingTransaction({ range: [], source: [] });

    readTurnObservations(tx, {
      branchId,
      agentId,
      scope,
      previousSeq: 0,
      throughSeq: 9,
      sourceRefs,
    });

    // 主区间一条 + 两批补充查询；每批的 IN 参数都不超过 500，且仍带 seq 上界。
    const supplementary = queries.filter((query) => query.sql.includes("json_each"));
    expect(supplementary).toHaveLength(2);
    expect(supplementary[0]?.params.slice(3)).toHaveLength(500);
    expect(supplementary[1]?.params.slice(3)).toHaveLength(1);
    for (const query of supplementary) {
      expect(query.params[2]).toBe(9);
    }
  });
});
