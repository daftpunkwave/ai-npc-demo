/**
 * 核心职责：验证存档实现读取分支检查点只经宿主绑定时注入的查询：世界 tick 与事件前沿都不来自 requires，
 *   两者都在调用方同一事务内读取；时钟缺失按快照不完整报告；模块描述符仍只依赖 platform.storage。
 * 交互契约：经模块定义的 create 与公开端口 bind 取得 SavePort；使用内存存储桩，分支复制同步复制桩内的 tick 与前沿，
 *   任何分支级表访问都直接失败，以此证明实现不再直读 clock 或 domain_events。
 * 约束与禁忌：不打开 SQLite；真实存储上的快照与恢复语义由集成测试覆盖，这里不重复。
 */
import { describe, expect, it } from "vitest";
import {
  DomainError,
  type ForkBranchRequest,
  type ForkBranchResult,
  type HostServices,
  type Json,
  type StorageFilter,
  type StoragePort,
  type StorageRow,
  type StorageTable,
  type StorageTransaction,
} from "@world-prism/contracts";
import type { BranchWorldTickQuery, SaveModulePort, SavePort } from "@world-prism/module-sdk";
import { saveModuleDefinition } from "../src/definition";

const SOURCE_BRANCH = "br-000000000100";
const SOURCE_RUN = "run-000000000100";
const WORLD = "wld-000000000100";

const primaryKeys: Readonly<Record<string, string>> = {
  branches: "branch_id",
  runs: "run_id",
  snapshots: "snapshot_id",
  world_aliases: "alias",
};

/** 分支级检查点事实：真实存储里分别在 clock 与 domain_events 表，桩里由注入的查询直接读取。 */
interface BranchCheckpoint {
  tick: number | null;
  frontier: number;
}

interface PortRead {
  readonly port: "tick" | "frontier";
  readonly tx: StorageTransaction;
  readonly branchId: string;
}

function matches(row: StorageRow, filter: StorageFilter | undefined): boolean {
  return Object.entries(filter ?? {}).every(([column, value]) => row[column] === value);
}

/** 部署级/运行级表的内存实现：按表主键覆盖写入，过滤只支持等值。 */
function memoryTable(name: string, rows: Map<string, StorageRow>): StorageTable {
  const keyColumn = primaryKeys[name];
  if (keyColumn === undefined) {
    throw new Error(`存档实现不应访问表 ${name}`);
  }
  return {
    table: name,
    get: (key) => [...rows.values()].find((row) => matches(row, key)) ?? null,
    list: (filter) => [...rows.values()].filter((row) => matches(row, filter)),
    put: (row) => {
      rows.set(String(row[keyColumn]), row);
      return { changes: 1 };
    },
    delete: (key) => {
      const target = [...rows.entries()].find(([, row]) => matches(row, key));
      if (target !== undefined) rows.delete(target[0]);
      return { changes: target === undefined ? 0 : 1 };
    },
    count: (filter) => [...rows.values()].filter((row) => matches(row, filter)).length,
    max: () => {
      throw new Error(`存档实现不应对表 ${name} 求最大值`);
    },
  };
}

interface MemoryWorld {
  readonly storage: StoragePort;
  readonly tables: Map<string, Map<string, StorageRow>>;
  readonly checkpoints: Map<string, BranchCheckpoint>;
}

/** 内存存储桩：分支级表一律拒绝访问；分支复制写 branches 行并复制桩内检查点，模拟整表复制。 */
function memoryWorld(): MemoryWorld {
  const tables = new Map<string, Map<string, StorageRow>>();
  const checkpoints = new Map<string, BranchCheckpoint>();
  const rowsOf = (name: string): Map<string, StorageRow> => {
    const existing = tables.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, StorageRow>();
    tables.set(name, created);
    return created;
  };
  const unsupported = (): never => {
    throw new Error("存档实现不应使用原始 SQL 或保存点");
  };
  const tx: StorageTransaction = {
    get: unsupported,
    all: unsupported,
    run: unsupported,
    savepoint: unsupported,
    rows: (name) => memoryTable(name, rowsOf(name)),
    branch: (branchId) => ({
      branchId,
      table: (name) => {
        throw new Error(`存档实现不应直接访问分支 ${branchId} 的分支级表 ${name}`);
      },
    }),
  };
  const forkBranch = (_tx: StorageTransaction, request: ForkBranchRequest): ForkBranchResult => {
    const source = rowsOf("branches").get(request.srcBranchId);
    const checkpoint = checkpoints.get(request.srcBranchId);
    if (source === undefined || checkpoint === undefined) {
      throw new Error(`桩内缺少源分支 ${request.srcBranchId}`);
    }
    const status = request.kind === "snapshot" ? "frozen" : "active";
    rowsOf("branches").set(request.dstBranchId, {
      branch_id: request.dstBranchId,
      world_id: source["world_id"] ?? null,
      kind: request.kind,
      status,
      parent_branch_id: request.srcBranchId,
      forked_at_world_seq: checkpoint.frontier,
      run_id: request.runId ?? null,
      profile_hash: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    checkpoints.set(request.dstBranchId, { ...checkpoint });
    return {
      branchId: request.dstBranchId,
      parentBranchId: request.srcBranchId,
      kind: request.kind,
      status,
      runId: request.runId ?? null,
      profileHash: null,
      forkedAtWorldSeq: checkpoint.frontier,
      copiedRows: {},
    };
  };
  const storage: StoragePort = {
    transact: (fn) => fn(tx),
    forkBranch,
    backup: () => {
      throw new Error("存档实现不应触发备份");
    },
    artifactFiles: {
      inlineMaxBytes: 0,
      write: () => {
        throw new Error("存档实现不应写 artifact 正文文件");
      },
      read: () => {
        throw new Error("存档实现不应读 artifact 正文文件");
      },
      remove: () => {
        throw new Error("存档实现不应删除 artifact 正文文件");
      },
    },
  };
  return { storage, tables, checkpoints };
}

function testHost(): HostServices {
  let sequence = 0;
  return {
    ids: (prefix) => {
      sequence += 1;
      return `${prefix}-${String(sequence).padStart(12, "0")}`;
    },
    nowIso: () => "2026-01-01T00:00:00.000Z",
    monotonicMs: () => 0,
    sleep: async () => {
      // 存档实现没有异步等待。
    },
    rng: () => () => 0.5,
    hash: async (value) => String(JSON.stringify(value).length).padStart(64, "0"),
    hashText: async (text) => String(text.length).padStart(64, "0"),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tracer: { span: (_name, _attrs, fn) => fn() },
  };
}

/** 世界 tick 查询桩：按分支读桩内 tick，缺少时钟行时与宿主以时钟端口提供的查询一样抛 not-found。 */
function worldTickQueryOf(world: MemoryWorld, reads: PortRead[]): BranchWorldTickQuery {
  return (tx, branchId) => {
    reads.push({ port: "tick", tx, branchId });
    const tick = world.checkpoints.get(branchId)?.tick ?? null;
    if (tick === null) {
      throw new DomainError("not-found", `分支 ${branchId} 没有时钟行`, { details: { branchId } });
    }
    return tick;
  };
}

/** 播种在线源分支、绑定的 run 与在线别名，以及源分支的检查点事实。 */
function seedOnline(world: MemoryWorld, checkpoint: BranchCheckpoint): void {
  const runSpec: Json = { schemaVersion: 1, id: "online-default", seed: "seed-1" };
  const manifest: Json = { schemaVersion: 1, seed: "seed-1" };
  world.storage.transact((tx) => {
    tx.rows("branches").put({
      branch_id: SOURCE_BRANCH,
      world_id: WORLD,
      kind: "online",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: null,
      run_id: SOURCE_RUN,
      profile_hash: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.rows("runs").put({
      run_id: SOURCE_RUN,
      world_id: WORLD,
      branch_id: SOURCE_BRANCH,
      mode: "live",
      status: "running",
      run_spec_json: runSpec,
      manifest_json: manifest,
      manifest_hash: "a".repeat(64),
      contaminated: 0,
      evidence_complete: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: null,
    });
    tx.rows("world_aliases").put({ alias: "online", branch_id: SOURCE_BRANCH, updated_at: "2026-01-01T00:00:00.000Z" });
  });
  world.checkpoints.set(SOURCE_BRANCH, { ...checkpoint });
}

interface BoundSave {
  readonly save: SavePort;
  readonly reads: PortRead[];
}

/**
 * 与宿主一样：经模块定义 create 只注入 requires 声明的存储端口，再在公开端口 bind 时注入世界 tick 与事件前沿查询。
 * worldTick 缺省为读桩内 tick 的查询，传入替身可模拟时钟端口的其他错误。
 */
async function bindSave(world: MemoryWorld, worldTick?: BranchWorldTickQuery): Promise<BoundSave> {
  const reads: PortRead[] = [];
  const instance = await saveModuleDefinition.create({
    moduleId: saveModuleDefinition.id,
    realm: "server",
    config: {},
    scope: { worldId: WORLD, branchId: SOURCE_BRANCH },
    ports: { "platform.storage": world.storage },
    host: testHost(),
    signal: new AbortController().signal,
  });
  const port = instance.port as SaveModulePort;
  const save = port.bind({
    worldTick: worldTick ?? worldTickQueryOf(world, reads),
    eventFrontier: (tx, branchId) => {
      reads.push({ port: "frontier", tx, branchId });
      const checkpoint = world.checkpoints.get(branchId);
      if (checkpoint === undefined) {
        throw new Error(`桩内缺少分支 ${branchId} 的事件前沿`);
      }
      return checkpoint.frontier;
    },
  });
  return { save, reads };
}

function caughtDomainError(fn: () => unknown): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  return caught as DomainError;
}

describe("存档检查点读取端口", () => {
  it("快照的 worldTick 与 worldSeq 取自绑定时注入的查询，二者与快照写入共用同一事务", async () => {
    const world = memoryWorld();
    seedOnline(world, { tick: 12, frontier: 34 });
    const { save, reads } = await bindSave(world);

    const snapshot = save.createSnapshot({ sourceBranchId: SOURCE_BRANCH, label: "检查点", createdBy: "player-1" });

    expect(snapshot).toMatchObject({ sourceBranchId: SOURCE_BRANCH, worldTick: 12, worldSeq: 34 });
    expect(reads.map(({ port, branchId }) => ({ port, branchId }))).toEqual([
      { port: "tick", branchId: SOURCE_BRANCH },
      { port: "frontier", branchId: SOURCE_BRANCH },
    ]);
    expect(reads[0]?.tx).toBe(reads[1]?.tx);
    expect(world.tables.get("snapshots")?.get(snapshot.snapshotId)).toMatchObject({
      frozen_branch_id: snapshot.frozenBranchId,
      world_tick: 12,
      world_seq: 34,
    });
  });

  it("恢复预检经两项注入查询核对冻结分支，tick 或前沿与快照记录不一致即 invalid-state", async () => {
    const world = memoryWorld();
    seedOnline(world, { tick: 12, frontier: 34 });
    const { save, reads } = await bindSave(world);
    const snapshot = save.createSnapshot({ sourceBranchId: SOURCE_BRANCH, label: "检查点", createdBy: "player-1" });
    reads.length = 0;

    const inspection = save.inspectRestore(snapshot.snapshotId);
    expect(inspection).toMatchObject({ frozenBranchId: snapshot.frozenBranchId, worldTick: 12, worldSeq: 34 });
    expect(reads.map(({ port, branchId }) => ({ port, branchId }))).toEqual([
      { port: "tick", branchId: snapshot.frozenBranchId },
      { port: "frontier", branchId: snapshot.frozenBranchId },
    ]);

    const frozen = world.checkpoints.get(snapshot.frozenBranchId);
    if (frozen === undefined) throw new Error("桩内缺少冻结分支检查点");
    frozen.tick = 13;
    expect(caughtDomainError(() => save.inspectRestore(snapshot.snapshotId))).toMatchObject({
      code: "invalid-state",
      safeMessage: expect.stringContaining("worldTick"),
    });
    frozen.tick = 12;
    frozen.frontier = 35;
    expect(caughtDomainError(() => save.inspectRestore(snapshot.snapshotId))).toMatchObject({
      code: "invalid-state",
      safeMessage: expect.stringContaining("worldSeq"),
    });
  });

  it("事务内恢复沿用同一组注入查询核对冻结分支，并从冻结分支复制后继在线分支", async () => {
    const world = memoryWorld();
    seedOnline(world, { tick: 12, frontier: 34 });
    const { save } = await bindSave(world);
    const snapshot = save.createSnapshot({ sourceBranchId: SOURCE_BRANCH, label: "检查点", createdBy: "player-1" });

    const restored = world.storage.transact((tx) =>
      save.restoreSnapshotInTransaction(tx, { snapshotId: snapshot.snapshotId, createdBy: "operator-1" }));

    expect(restored).toMatchObject({ previousBranchId: SOURCE_BRANCH, sourceRunId: SOURCE_RUN, worldTick: 12, worldSeq: 34 });
    expect(world.tables.get("branches")?.get(restored.branchId)).toMatchObject({
      kind: "online",
      parent_branch_id: snapshot.frozenBranchId,
      run_id: restored.runId,
    });
    expect(world.tables.get("world_aliases")?.get("online")).toMatchObject({ branch_id: restored.branchId });
  });

  it("世界 tick 查询报告分支没有时钟行时按快照不完整处理，其余时钟错误原样抛出", async () => {
    const world = memoryWorld();
    seedOnline(world, { tick: 12, frontier: 34 });
    const { save } = await bindSave(world);
    const snapshot = save.createSnapshot({ sourceBranchId: SOURCE_BRANCH, label: "检查点", createdBy: "player-1" });

    const frozen = world.checkpoints.get(snapshot.frozenBranchId);
    if (frozen === undefined) throw new Error("桩内缺少冻结分支检查点");
    frozen.tick = null;
    const frozenMissing = caughtDomainError(() => save.inspectRestore(snapshot.snapshotId));
    expect(frozenMissing).toMatchObject({ code: "invalid-state", safeMessage: expect.stringContaining("缺少时钟记录") });
    expect(frozenMissing.details).toEqual({ snapshotId: snapshot.snapshotId, frozenBranchId: snapshot.frozenBranchId });
    expect((frozenMissing.cause as DomainError).code).toBe("not-found");

    const source = world.checkpoints.get(SOURCE_BRANCH);
    if (source === undefined) throw new Error("桩内缺少源分支检查点");
    source.tick = null;
    const sourceMissing = caughtDomainError(() =>
      save.createSnapshot({ sourceBranchId: SOURCE_BRANCH, label: "无时钟", createdBy: "player-1" }));
    expect(sourceMissing).toMatchObject({ code: "invalid-state", safeMessage: `源分支 ${SOURCE_BRANCH} 缺少时钟记录` });

    const corrupt = new DomainError("invalid-state", "clock 列 world_tick 不是非负安全整数");
    const { save: failingSave } = await bindSave(world, () => {
      throw corrupt;
    });
    source.tick = 12;
    let thrown: unknown;
    try {
      failingSave.createSnapshot({ sourceBranchId: SOURCE_BRANCH, label: "损坏时钟", createdBy: "player-1" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(corrupt);
  });

  it("模块描述符只依赖 platform.storage：检查点查询经 bind 注入，不进入 requires，模块目录摘要不因此变化", () => {
    expect(saveModuleDefinition.requires).toEqual([
      { capability: "platform.storage", cardinality: "exactly-one", instanceScope: "deployment" },
    ]);
    expect(saveModuleDefinition.requiresRemote).toEqual([]);
  });
});
