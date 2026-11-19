/**
 * 验证 SQLite 存档：冻结快照复制源分支、快照列表限定当前 campaign，
 * 以及恢复在同一事务内建立后继 run、结束旧 run、归档旧分支并切换在线别名。
 * 依赖真实 SQLite 分支持久化与游戏 harness 的种子分支。
 * 禁止直接改快照行或别名模拟恢复，也禁止用假存储替代回滚验证。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Json, StoragePort, StorageTable, StorageTransaction } from "@ai-npc/contracts";
import { SqliteSaveService } from "@ai-npc/mod-game-save-sqlite";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  setGameClock,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

async function harness(): Promise<GameHarness> {
  return createTrackedGameHarness(active);
}

const onlineRunSpec: Json = {
  schemaVersion: 1,
  id: "online-default",
  moduleAssemblyRef: "local-slg-standard-v1",
  worldPackRef: "earth-2964-v1",
  scenarioRef: "watergate-v1",
  rosterRef: "standard-20",
  modelLayoutRef: "shared-model-layout-v1",
  seed: "0123456789abcdef0123456789abcdef",
  mode: "live",
  initialState: { kind: "cold-start" },
  variant: null,
  script: null,
  clock: { kind: "realtime" },
  budget: { maxTokens: null, maxCost: null },
  failurePolicy: "online-fallback",
};

const onlineManifest: Json = {
  schemaVersion: 1,
  seed: "0123456789abcdef0123456789abcdef",
  selection: {
    runSpecId: "online-default",
    moduleAssemblyRef: "local-slg-standard-v1",
    worldPackRef: "earth-2964-v1",
    scenarioRef: "watergate-v1",
    rosterRef: "standard-20",
    modelLayoutRef: "shared-model-layout-v1",
  },
  content: { packId: "earth-2964-v1", contentVersion: "0.3.0" },
  assembly: { assemblyId: "local-slg-standard-v1", realm: "server", modules: [], catalogHash: "a".repeat(64), assemblyHash: "a".repeat(64) },
  roster: { rosterRef: "standard-20", agents: [] },
  agentSlots: null,
};

const onlineManifestHash = "b".repeat(64);

/** 给测试分支补上在线 run 与 world_aliases('online')，供恢复的在线入口使用。 */
function seedOnlineRun(value: GameHarness, runId = "run-save-online"): { readonly runId: string } {
  const createdAt = value.host.nowIso();
  value.storage.transact((tx) => {
    const branch = tx.rows("branches").get({ branch_id: value.branchId });
    if (branch === null) {
      throw new Error("缺少测试分支");
    }
    tx.rows("runs").put({
      run_id: runId,
      world_id: value.worldId,
      branch_id: value.branchId,
      mode: "live",
      status: "running",
      run_spec_json: onlineRunSpec,
      manifest_json: onlineManifest,
      manifest_hash: onlineManifestHash,
      contaminated: 0,
      evidence_complete: 1,
      created_at: createdAt,
      started_at: createdAt,
      ended_at: null,
    });
    tx.rows("branches").put({ ...branch, run_id: runId });
    tx.rows("world_aliases").put({ alias: "online", branch_id: value.branchId, updated_at: createdAt });
  });
  return { runId };
}

/** 持久化生命周期快照：分支、run、快照与在线别名，用于断言回滚后完全不变。 */
function persistenceOf(value: GameHarness): {
  readonly branches: readonly string[];
  readonly runs: readonly string[];
  readonly snapshots: readonly string[];
  readonly alias: string | null;
} {
  return value.storage.transact((tx) => {
    const alias = tx.rows("world_aliases").get({ alias: "online" });
    const aliasBranch = alias === null ? null : alias["branch_id"];
    return {
      branches: tx.rows("branches").list().map((row) => String(row["branch_id"])).sort(),
      runs: tx.rows("runs").list().map((row) => String(row["run_id"])).sort(),
      snapshots: tx.rows("snapshots").list().map((row) => String(row["snapshot_id"])).sort(),
      alias: typeof aliasBranch === "string" ? aliasBranch : null,
    };
  });
}

/** 用真实 SQLite 事务与分支复制，只在写入 world_aliases 时抛错，验证恢复事务整体回滚。 */
function storageFailingAliasWrite(storage: StoragePort): StoragePort {
  return {
    transact: <T,>(fn: (tx: StorageTransaction) => T): T =>
      storage.transact((tx) => {
        const originalRows = tx.rows.bind(tx);
        const mutable = tx as unknown as { rows(table: string): StorageTable };
        mutable.rows = (table: string) => {
          const access = originalRows(table);
          if (table !== "world_aliases") {
            return access;
          }
          return {
            table: access.table,
            get: access.get.bind(access),
            list: access.list.bind(access),
            put: () => {
              throw new Error("注入的别名写入失败");
            },
            delete: access.delete.bind(access),
            count: access.count.bind(access),
            max: access.max.bind(access),
          };
        };
        return fn(tx);
      }),
    forkBranch: (tx, request) => storage.forkBranch(tx, request),
    backup: (options) => storage.backup(options),
  };
}

describe("SQLite 存档", () => {
  it("创建冻结快照、保留源分支并只列出当前 campaign 的存档", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    const save = new SqliteSaveService(value.storage, value.host);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "测试存档", createdBy: "player-1" });
    expect(snapshot).toMatchObject({ sourceBranchId: value.branchId, worldTick: 5, label: "测试存档" });
    // 没有在线别名时不属于任何 campaign，列表为空。
    expect(save.listSnapshots()).toEqual([]);
    seedOnlineRun(value);
    expect(save.listSnapshots().map((item) => item.snapshotId)).toEqual([snapshot.snapshotId]);
    const frozen = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: snapshot.frozenBranchId }));
    expect(frozen).toMatchObject({ kind: "snapshot", status: "frozen", parent_branch_id: value.branchId });
    const source = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: value.branchId }));
    expect(source).toMatchObject({ kind: "online" });
  });

  it("缺少时钟或空标签时拒绝创建快照", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const save = new SqliteSaveService(value.storage, value.host);
    expect(() => save.createSnapshot({ sourceBranchId: value.branchId, label: " ", createdBy: "player-1" })).toThrow();
    value.storage.transact((tx) => {
      tx.run("DELETE FROM clock WHERE branch_id = ?", [value.branchId]);
    });
    expect(() => save.createSnapshot({ sourceBranchId: value.branchId, label: "无时钟", createdBy: "player-1" })).toThrow();
  });

  it("恢复在同一事务内切换别名：后继 run 沿用源 RunSpec 与 manifest，旧 run 结束、旧分支归档", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    const online = seedOnlineRun(value);
    const save = new SqliteSaveService(value.storage, value.host);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "恢复点", createdBy: "operator-1" });
    const sourceJobs = value.storage.transact((tx) => tx.branch(value.branchId).table("jobs").list());
    expect(sourceJobs.filter((job) => job["status"] === "scheduled").length).toBeGreaterThan(0);

    const restored = save.restoreSnapshot({ snapshotId: snapshot.snapshotId, createdBy: "operator-1" });
    expect(restored.branchId).not.toBe(value.branchId);
    expect(restored.runId).not.toBe(online.runId);
    expect(restored.previousBranchId).toBe(value.branchId);
    expect(restored.sourceRunId).toBe(online.runId);

    const alias = value.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
    expect(alias).toMatchObject({ branch_id: restored.branchId });

    const branch = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: restored.branchId }));
    expect(branch).toMatchObject({
      kind: "online",
      status: "active",
      run_id: restored.runId,
      parent_branch_id: snapshot.frozenBranchId,
    });
    const successorRun = value.storage.transact((tx) => tx.rows("runs").get({ run_id: restored.runId }));
    expect(successorRun).toMatchObject({
      branch_id: restored.branchId,
      mode: "live",
      status: "running",
    });
    expect(successorRun?.["run_spec_json"]).toEqual(onlineRunSpec);
    expect((successorRun?.["run_spec_json"] as { readonly seed: string }).seed).toBe(onlineRunSpec["seed"]);
    expect(successorRun?.["manifest_json"]).toEqual(onlineManifest);
    expect(successorRun?.["manifest_hash"]).toBe(onlineManifestHash);

    const previousRun = value.storage.transact((tx) => tx.rows("runs").get({ run_id: online.runId }));
    expect(previousRun).toMatchObject({ branch_id: value.branchId, status: "completed" });
    expect(previousRun?.["ended_at"]).not.toBeNull();
    const previousBranch = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: value.branchId }));
    expect(previousBranch).toMatchObject({ kind: "online", status: "archived", run_id: online.runId });

    const successorClock = value.storage.transact((tx) => tx.branch(restored.branchId).table("clock").get({}));
    expect(successorClock).toMatchObject({ world_tick: 5, mode: "paused" });

    const successorJobs = value.storage.transact((tx) => tx.branch(restored.branchId).table("jobs").list());
    expect(successorJobs.map((job) => job["job_id"]).sort()).toEqual(sourceJobs.map((job) => job["job_id"]).sort());
    expect(successorJobs.filter((job) => job["status"] === "scheduled")).toHaveLength(
      sourceJobs.filter((job) => job["status"] === "scheduled").length,
    );

    // 历史分支与恢复所用快照仍可查询，且仍在当前 campaign 的快照列表内。
    expect(save.listSnapshots().map((item) => item.snapshotId)).toEqual([snapshot.snapshotId]);
  });

  it("快照不完整时恢复 dry-run 失败且不产生任何写入", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 3, mode: "paused" });
    seedOnlineRun(value);
    const save = new SqliteSaveService(value.storage, value.host);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "待破坏", createdBy: "operator-1" });
    const before = persistenceOf(value);
    value.storage.transact((tx) => {
      tx.branch(snapshot.frozenBranchId).table("clock").delete({});
    });
    expect(() => save.restoreSnapshot({ snapshotId: snapshot.snapshotId, createdBy: "operator-1" })).toThrow(
      /缺少时钟记录/,
    );
    expect(persistenceOf(value)).toEqual(before);
  });

  it("事务内创建快照随调用方回滚，不留下冻结分支或快照行", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    const save = new SqliteSaveService(value.storage, value.host);
    const before = persistenceOf(value);

    expect(() =>
      value.storage.transact((tx) => {
        const snapshot = save.createSnapshotInTransaction(tx, {
          sourceBranchId: value.branchId,
          label: "事务内存档",
          createdBy: "player-1",
        });
        expect(snapshot.worldTick).toBe(5);
        throw new Error("调用方回滚");
      }),
    ).toThrow(/调用方回滚/);
    expect(persistenceOf(value)).toEqual(before);
  });

  it("切换中途写入失败时整体回滚，别名、分支、run 与快照保持原状", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 4, mode: "paused" });
    seedOnlineRun(value);
    const save = new SqliteSaveService(value.storage, value.host);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "回滚点", createdBy: "operator-1" });
    const before = persistenceOf(value);

    const failing = new SqliteSaveService(storageFailingAliasWrite(value.storage), value.host);
    expect(() => failing.restoreSnapshot({ snapshotId: snapshot.snapshotId, createdBy: "operator-1" })).toThrow(
      /注入的别名写入失败/,
    );
    expect(persistenceOf(value)).toEqual(before);
    const alias = value.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
    expect(alias).toMatchObject({ branch_id: value.branchId });
  });

  it("其他分支创建的快照不出现在当前 campaign 的列表中", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 6, mode: "paused" });
    seedOnlineRun(value);
    const save = new SqliteSaveService(value.storage, value.host);
    const onlineSnapshot = save.createSnapshot({
      sourceBranchId: value.branchId,
      label: "在线存档",
      createdBy: "operator-1",
    });
    const experimentBranchId = value.host.ids("br");
    value.storage.transact((tx) => {
      value.storage.forkBranch(tx, {
        srcBranchId: value.branchId,
        dstBranchId: experimentBranchId,
        kind: "experiment",
        runId: value.host.ids("run"),
      });
    });
    const experimentSnapshot = save.createSnapshot({
      sourceBranchId: experimentBranchId,
      label: "实验存档",
      createdBy: "operator-1",
    });
    expect(save.listSnapshots().map((item) => item.snapshotId)).toEqual([onlineSnapshot.snapshotId]);
    save.restoreSnapshot({ snapshotId: onlineSnapshot.snapshotId, createdBy: "operator-1" });
    expect(save.listSnapshots().map((item) => item.snapshotId)).toEqual([onlineSnapshot.snapshotId]);
    expect(experimentSnapshot.snapshotId).not.toBe(onlineSnapshot.snapshotId);
  });
});
