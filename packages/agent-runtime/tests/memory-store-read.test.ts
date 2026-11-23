/**
 * 验证记忆读取路径用单次范围查询取回待摄入观察，不再逐行回表。
 * 依赖记录调用的存储端口假实现与内联观察行夹具。
 * 禁止启动 SQLite、计时器或网络资源。
 */
import { describe, expect, it } from "vitest";
import type {
  HostServices,
  StoragePort,
  StorageRawRow,
  StorageRow,
  StorageTransaction,
  StorageValue,
} from "@ai-npc/contracts";
import { MemoryStore } from "../src/memory-store";

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000001`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => {
    // 读取路径不等待。
  },
  rng: () => () => 0.5,
  hash: async () => "hash",
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  tracer: {
    span: (_name, _attrs, fn) => fn(),
  },
};

interface CallLog {
  readonly rawQueries: string[];
  observationTableReads: number;
}

function observationRow(sequence: number): StorageRawRow {
  return {
    observation_id: `obs-${String(sequence).padStart(12, "0")}`,
    observation_seq: sequence,
    source_event_ids_json: JSON.stringify([`evt-${String(sequence).padStart(12, "0")}`]),
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

/** 记录读取调用的存储端口：只实现读取路径用到的成员，其余一律抛错暴露误用。 */
function recordingStorage(rows: readonly StorageRawRow[]): { readonly port: StoragePort; readonly log: CallLog } {
  const log: CallLog = { rawQueries: [], observationTableReads: 0 };
  const unused = (): never => {
    throw new Error("read path must not use table access");
  };
  const unusedTable = {
    table: "unused",
    get: (): StorageRow | null => {
      log.observationTableReads += 1;
      throw new Error("read path must not look observations up row by row");
    },
    list: unused,
    put: unused,
    delete: unused,
    count: unused,
    max: unused,
  };
  const transaction: StorageTransaction = {
    get: unused,
    all: (sql: string, _params?: readonly StorageValue[]): readonly StorageRawRow[] => {
      log.rawQueries.push(sql);
      return rows;
    },
    run: unused,
    rows: unused,
    branch: () => ({
      branchId: "br-000000000001",
      table: () => unusedTable,
    }),
    savepoint: <T,>(_name: string, fn: () => T): T => fn(),
  };
  const port: StoragePort = {
    transact: <T,>(fn: (tx: StorageTransaction) => T): T => fn(transaction),
    forkBranch: unused,
    backup: unused,
  };
  return { port, log };
}

describe("memory store observation read", () => {
  it("reads pending observations with a single range query and no per-row lookup", () => {
    const rows = [observationRow(2), observationRow(3), observationRow(4)];
    const { port, log } = recordingStorage(rows);
    const store = new MemoryStore(
      port,
      host,
      "wld-000000000001",
      "br-000000000001",
      "run-000000000001",
    );

    const observations = store.readObservations("human-independent", 1);

    expect(observations.map((observation) => observation.observationSeq)).toEqual([2, 3, 4]);
    expect(observations.map((observation) => observation.content)).toEqual([
      { eventType: "MetersChanged", summaryZh: "观察 2" },
      { eventType: "MetersChanged", summaryZh: "观察 3" },
      { eventType: "MetersChanged", summaryZh: "观察 4" },
    ]);
    // 一次游标扫描独立于行数：查询条数恒为 1，且不出现逐行点查。
    expect(log.rawQueries).toHaveLength(1);
    expect(log.rawQueries[0]).toContain("FROM observations");
    expect(log.observationTableReads).toBe(0);
  });

  it("returns an empty list without allocating rows when the cursor is current", () => {
    const { port, log } = recordingStorage([]);
    const store = new MemoryStore(
      port,
      host,
      "wld-000000000001",
      "br-000000000001",
      "run-000000000001",
    );

    expect(store.readObservations("human-independent", 7)).toEqual([]);
    expect(log.rawQueries).toHaveLength(1);
    expect(log.observationTableReads).toBe(0);
  });
});
