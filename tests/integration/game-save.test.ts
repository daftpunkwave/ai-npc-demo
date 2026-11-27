/**
 * 验证 SQLite 存档实现：创建快照时复制源分支为冻结分支、快照列表只含当前 campaign，
 * 恢复在同一事务内沿用源 run 的 RunSpec 与 manifest、结束旧 run、归档旧分支并切换在线别名；
 * 另覆盖快照不完整时的 dry-run 拒绝、坏快照按稳定领域错误码失败、调用方事务回滚与别名写入失败注入后零残留。
 * 依赖真实 SQLite 分支存储、宿主 ID/时间服务与游戏 harness 的种子分支和时钟；存档只经模块公开的 SavePort 取用。
 * 禁止用改写快照行或别名的方式伪造恢复成功，也禁止用假存储替代回滚验证。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, type ErrorCode, type Json, type StoragePort, type StorageTable, type StorageTransaction } from "@world-prism/contracts";
import type { RestoreResult, RestoreSnapshotInput, SavePort } from "@world-prism/module-sdk";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  setGameClock,
  startNeutralCampaign,
  withGamePorts,
  type GameHarness,
} from "./game-support";
import { createSqliteSavePort } from "./save-support";

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
  rosterRef: "standard-15",
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
    rosterRef: "standard-15",
    modelLayoutRef: "shared-model-layout-v1",
  },
  content: { packId: "earth-2964-v1", contentVersion: "0.3.0" },
  assembly: { assemblyId: "local-slg-standard-v1", realm: "server", modules: [], catalogHash: "a".repeat(64), assemblyHash: "a".repeat(64) },
  roster: { rosterRef: "standard-15", agents: [] },
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

/** 捕获一次同步抛错并断言它是稳定领域错误码；返回错误供安全文案断言。 */
function expectDomainError(fn: () => unknown, code: ErrorCode): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  return caught as DomainError;
}

/** 在给定存储的一次事务内提交恢复；存档端口只提供事务内恢复，事务边界由调用方决定。 */
function restoreIn(storage: StoragePort, save: SavePort, input: RestoreSnapshotInput): RestoreResult {
  return storage.transact((tx) => save.restoreSnapshotInTransaction(tx, input));
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
    artifactFiles: storage.artifactFiles,
  };
}

describe("SQLite 存档", () => {
  it("创建冻结快照、保留源分支并只列出当前 campaign 的存档", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    const save = await createSqliteSavePort(value);
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
    const save = await createSqliteSavePort(value);
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
    const save = await createSqliteSavePort(value);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "恢复点", createdBy: "operator-1" });
    const sourceJobs = value.storage.transact((tx) => tx.branch(value.branchId).table("jobs").list());
    expect(sourceJobs.filter((job) => job["status"] === "scheduled").length).toBeGreaterThan(0);

    const restored = restoreIn(value.storage, save, { snapshotId: snapshot.snapshotId, createdBy: "operator-1" });
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

  it("旧 campaign 状态缺少 cityResources 时快照恢复后读作 null", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    seedOnlineRun(value);
    // 模拟旧版本写入的 campaign 聚合：没有 cityResources 键。
    value.storage.transact((tx) => {
      const table = tx.branch(value.branchId).table("aggregate_state");
      const row = table.get({ aggregate_type: "campaign", aggregate_id: "campaign" });
      if (row === null) {
        throw new Error("测试缺少 campaign 聚合");
      }
      const state = row["state_json"] as Record<string, Json>;
      delete state["cityResources"];
      table.put({ ...row, state_json: state, version: Number(row["version"]) + 1 });
    });
    const save = await createSqliteSavePort(value);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "旧状态恢复点", createdBy: "operator-1" });
    const restored = restoreIn(value.storage, save, { snapshotId: snapshot.snapshotId, createdBy: "operator-1" });
    const campaign = withGamePorts(value, (ports) => ports["game.world"].campaign(), restored.branchId);
    expect(campaign).toMatchObject({
      status: "running",
      outcome: null,
      cityResources: null,
    });
  });

  it("快照不完整时恢复 dry-run 失败且不产生任何写入", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 3, mode: "paused" });
    seedOnlineRun(value);
    const save = await createSqliteSavePort(value);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "待破坏", createdBy: "operator-1" });
    const before = persistenceOf(value);
    value.storage.transact((tx) => {
      tx.branch(snapshot.frozenBranchId).table("clock").delete({});
    });
    const error = expectDomainError(
      () => restoreIn(value.storage, save, { snapshotId: snapshot.snapshotId, createdBy: "operator-1" }),
      "invalid-state",
    );
    expect(error.safeMessage).toContain("缺少时钟记录");
    expect(persistenceOf(value)).toEqual(before);
  });

  it("坏快照的冻结分支、时钟、事件前沿与源 run 不一致返回稳定领域错误码", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 3, mode: "paused" });
    const online = seedOnlineRun(value);
    const save = await createSqliteSavePort(value);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "错误分类", createdBy: "operator-1" });
    const restore = (): unknown =>
      restoreIn(value.storage, save, { snapshotId: snapshot.snapshotId, createdBy: "operator-1" });
    const frozen = value.storage.transact((tx) =>
      tx.rows("branches").get({ branch_id: snapshot.frozenBranchId }),
    );
    if (frozen === null) {
      throw new Error(`快照 ${snapshot.snapshotId} 缺少冻结分支`);
    }

    // 冻结分支状态不一致：稳定 invalid-state，而不是 HTTP 500 plugin-failed。
    value.storage.transact((tx) => {
      tx.rows("branches").put({ ...frozen, status: "active" });
    });
    let before = persistenceOf(value);
    const statusError = expectDomainError(restore, "invalid-state");
    expect(statusError.safeMessage).toContain("冻结分支状态");
    expect(persistenceOf(value)).toEqual(before);

    // 冻结分支时钟与快照记录不一致。
    value.storage.transact((tx) => {
      tx.rows("branches").put({ ...frozen });
      const clock = tx.branch(snapshot.frozenBranchId).table("clock").get({});
      if (clock === null) {
        throw new Error("缺少冻结分支时钟");
      }
      tx.branch(snapshot.frozenBranchId).table("clock").put({ ...clock, world_tick: snapshot.worldTick + 1 });
    });
    before = persistenceOf(value);
    const tickError = expectDomainError(restore, "invalid-state");
    expect(tickError.safeMessage).toContain("worldTick");
    expect(persistenceOf(value)).toEqual(before);

    // 快照事件前沿与冻结分支不一致。
    value.storage.transact((tx) => {
      const clock = tx.branch(snapshot.frozenBranchId).table("clock").get({});
      if (clock === null) {
        throw new Error("缺少冻结分支时钟");
      }
      tx.branch(snapshot.frozenBranchId).table("clock").put({ ...clock, world_tick: snapshot.worldTick });
      const row = tx.rows("snapshots").get({ snapshot_id: snapshot.snapshotId });
      if (row === null) {
        throw new Error("缺少快照记录");
      }
      tx.rows("snapshots").put({ ...row, world_seq: snapshot.worldSeq + 1 });
    });
    before = persistenceOf(value);
    const frontierError = expectDomainError(restore, "invalid-state");
    expect(frontierError.safeMessage).toContain("worldSeq");
    expect(persistenceOf(value)).toEqual(before);

    // 源 run 缺失。
    value.storage.transact((tx) => {
      const row = tx.rows("snapshots").get({ snapshot_id: snapshot.snapshotId });
      if (row === null) {
        throw new Error("缺少快照记录");
      }
      tx.rows("snapshots").put({ ...row, world_seq: snapshot.worldSeq });
      tx.rows("runs").delete({ run_id: online.runId });
    });
    before = persistenceOf(value);
    const runError = expectDomainError(restore, "not-found");
    expect(runError.safeMessage).toContain("不存在");
    expect(persistenceOf(value)).toEqual(before);
  });

  it("事件前沿按分支索引读取：无事件分支记 0，非法序号在创建快照时被拒绝", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 3, mode: "paused" });
    const save = await createSqliteSavePort(value);

    // 复制主分支为一条没有任何事件的分支，连同时钟一起复制：事件前沿 MAX 为空时按 0 处理，快照仍可创建。
    value.storage.transact((tx) => {
      const branch = tx.rows("branches").get({ branch_id: value.branchId });
      const clock = tx.branch(value.branchId).table("clock").get({});
      if (branch === null || clock === null) {
        throw new Error("缺少测试分支或时钟");
      }
      tx.rows("branches").put({ ...branch, branch_id: "brn-no-events" });
      // 时钟行携带源 branch_id：剥掉后由新分支 scope 注入自己的分支列。
      const { branch_id: _sourceBranch, ...clockFields } = clock;
      void _sourceBranch;
      tx.branch("brn-no-events").table("clock").put({ ...clockFields, world_tick: 2 });
    });
    const emptySnapshot = save.createSnapshot({ sourceBranchId: "brn-no-events", label: "空分支", createdBy: "operator-1" });
    expect(emptySnapshot.worldSeq).toBe(0);

    // 非法事件序号的两层防御：非整数由存储层读取时拒绝；负整数到达服务层前沿校验后拒绝。
    value.storage.transact((tx) => {
      tx.run(
        `INSERT INTO domain_events (branch_id, world_seq, event_id, world_tick, type, schema_version, principal_id,
                                    causation_ids_json, correlation_id, audience_json, payload_json, committed_at)
         SELECT 'brn-no-events', 1.5, event_id, world_tick, type, schema_version, principal_id,
                causation_ids_json, correlation_id, audience_json, payload_json, committed_at
           FROM domain_events WHERE branch_id = ? LIMIT 1`,
        [value.branchId],
      );
    });
    const nonIntegerError = expectDomainError(
      () => save.createSnapshot({ sourceBranchId: "brn-no-events", label: "非整数序号", createdBy: "operator-1" }),
      "invalid-state",
    );
    expect(nonIntegerError.safeMessage).toContain("超出安全范围");

    value.storage.transact((tx) => {
      tx.run("UPDATE domain_events SET world_seq = -1 WHERE branch_id = 'brn-no-events'");
    });
    const negativeError = expectDomainError(
      () => save.createSnapshot({ sourceBranchId: "brn-no-events", label: "负序号", createdBy: "operator-1" }),
      "invalid-state",
    );
    expect(negativeError.safeMessage).toContain("事件前沿");
  });

  it("事务内创建快照随调用方回滚，不留下冻结分支或快照行", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    const save = await createSqliteSavePort(value);
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
    const save = await createSqliteSavePort(value);
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "回滚点", createdBy: "operator-1" });
    const before = persistenceOf(value);

    const failingStorage = storageFailingAliasWrite(value.storage);
    const failing = await createSqliteSavePort(value, failingStorage);
    expect(() => restoreIn(failingStorage, failing, { snapshotId: snapshot.snapshotId, createdBy: "operator-1" })).toThrow(
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
    const save = await createSqliteSavePort(value);
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
    restoreIn(value.storage, save, { snapshotId: onlineSnapshot.snapshotId, createdBy: "operator-1" });
    expect(save.listSnapshots().map((item) => item.snapshotId)).toEqual([onlineSnapshot.snapshotId]);
    expect(experimentSnapshot.snapshotId).not.toBe(onlineSnapshot.snapshotId);
  });
});
