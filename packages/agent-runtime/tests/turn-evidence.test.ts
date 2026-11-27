/**
 * 验证 turn 阶段证据只以单条 SQL 追加到 turn_runs.effective_json：按阶段顺序累积、不读出整行、
 * 不改写其他列，effective_json 为 NULL 时从空数组起算，租约代次不符时不写入。
 * 依赖 node:sqlite 内存库支撑的最小存储端口，以真实 SQLite JSON 函数执行生产语句。
 * 禁止用记录 SQL 文本的假实现代替真实执行，或省略租约代次不符时的拒绝断言。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HostServices,
  StoragePort,
  StorageTransaction,
  StorageValue,
} from "@world-prism/contracts";
import { TurnEvidence, type TurnSpan } from "../src/turn-evidence";
import type { ClaimedTurn } from "../src/turn-lease";

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000001`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => {
    // 证据写入不等待。
  },
  rng: () => () => 0.5,
  hash: async () => "hash",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tracer: { span: (_name, _attrs, fn) => fn() },
};

interface StatementLog {
  readonly run: string[];
  readonly reads: string[];
}

/** 只开放原始语句通道的存储端口：表级接口一律抛错，用于证明证据写入不经整行读改写。 */
function sqliteStorage(database: DatabaseSync): { readonly port: StoragePort; readonly log: StatementLog } {
  const log: StatementLog = { run: [], reads: [] };
  const unused = (): never => {
    throw new Error("turn evidence must not use table access");
  };
  const transaction: StorageTransaction = {
    get: (sql) => {
      log.reads.push(sql);
      return null;
    },
    all: (sql) => {
      log.reads.push(sql);
      return [];
    },
    run: (sql: string, params: readonly StorageValue[] = []) => {
      log.run.push(sql);
      const result = database.prepare(sql).run(...(params as (string | number | null)[]));
      return { changes: Number(result.changes) };
    },
    rows: unused,
    branch: unused,
    savepoint: <T,>(_name: string, fn: () => T): T => fn(),
  };
  const port: StoragePort = {
    transact: <T,>(fn: (tx: StorageTransaction) => T): T => fn(transaction),
    forkBranch: unused,
    backup: unused,
    artifactFiles: { inlineMaxBytes: 0, write: unused, read: unused, remove: unused },
  };
  return { port, log };
}

const claimed = (turnLeaseEpoch: number): ClaimedTurn => ({
  auth: {
    principalId: "human-independent",
    principalKind: "agent",
    roles: [],
    worldId: "wld-000000000001",
    branchId: "br-000000000001",
    turnId: "turn-000000000001",
    turnLeaseEpoch,
  } as unknown as ClaimedTurn["auth"],
  runId: "run-000000000001",
  agentTurnIndex: 1,
  profileHash: "hash",
  triggers: [],
  clockVersion: 1,
  worldTick: 0,
  observationSeq: 0,
  probe: false,
  pauseExempt: false,
  deadlineMs: 1000,
});

describe("turn 阶段证据追加", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  const openTurn = (effectiveJson: string | null): void => {
    database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE turn_runs (
      turn_id TEXT PRIMARY KEY, status TEXT NOT NULL, turn_lease_epoch INTEGER NOT NULL, effective_json TEXT
    )`);
    database.prepare("INSERT INTO turn_runs VALUES (?, ?, ?, ?)").run("turn-000000000001", "deciding", 1, effectiveJson);
  };
  const storedRow = (): Record<string, unknown> | undefined =>
    database.prepare("SELECT status, turn_lease_epoch, effective_json FROM turn_runs").get();
  const stages = (): unknown => JSON.parse(String(storedRow()?.["effective_json"]));

  it("每个阶段一条 UPDATE 追加记录，按顺序累积且不读出整行、不改写其他列", () => {
    openTurn("[]");
    const { port, log } = sqliteStorage(database);
    const spans: TurnSpan[] = [];
    const evidence = new TurnEvidence(port, host, claimed(1), (span) => { spans.push(span); });
    evidence.record("turn.context", 0, { status: "applied", reason: null, effective: { blocks: 3 } });
    evidence.record("turn.decision", 0, { status: "applied", reason: null, effective: { artifactId: "art-1" } },
      { moduleId: "agent.decision.model", moduleVersion: "1.0.0", config: { temperature: 0 } });
    evidence.record("turn.speech", 0, { status: "skipped", reason: "no-speech", effective: null });

    expect(log.run).toHaveLength(3);
    expect(log.run.every((sql) => sql.trimStart().startsWith("UPDATE turn_runs"))).toBe(true);
    expect(log.reads).toEqual([]);
    expect(stages()).toEqual([
      { stage: "turn.context", spanId: "spn-000000000001", requested: null, resolved: null,
        status: "applied", reason: null, effective: { blocks: 3 } },
      { stage: "turn.decision", spanId: "spn-000000000001", requested: "agent.decision.model",
        resolved: { moduleId: "agent.decision.model", moduleVersion: "1.0.0", config: { temperature: 0 } },
        status: "applied", reason: null, effective: { artifactId: "art-1" } },
      { stage: "turn.speech", spanId: "spn-000000000001", requested: null, resolved: null,
        status: "skipped", reason: "no-speech", effective: null },
    ]);
    expect(storedRow()).toMatchObject({ status: "deciding", turn_lease_epoch: 1 });
    expect(spans.map((span) => [span.name, span.status])).toEqual([
      ["turn.context", "ok"], ["turn.decision", "ok"], ["turn.speech", "skipped"],
    ]);
  });

  it("effective_json 为 NULL 时从空数组起算", () => {
    openTurn(null);
    const { port } = sqliteStorage(database);
    new TurnEvidence(port, host, claimed(1), () => {})
      .record("turn.context", 0, { status: "applied", reason: null, effective: null });
    expect(stages()).toEqual([
      { stage: "turn.context", spanId: "spn-000000000001", requested: null, resolved: null,
        status: "applied", reason: null, effective: null },
    ]);
  });

  it("租约代次已变化时不写入", () => {
    openTurn("[]");
    const { port, log } = sqliteStorage(database);
    new TurnEvidence(port, host, claimed(2), () => {})
      .record("turn.context", 0, { status: "applied", reason: null, effective: null });
    expect(log.run).toHaveLength(1);
    expect(stages()).toEqual([]);
  });
});
