/**
 * 验证 SQLite 存档：冻结快照复制源分支、快照行写入与按源 run 恢复在线分支。
 * 依赖真实 SQLite 分支持久化与游戏 harness 的种子分支。
 * 禁止直接改快照行模拟恢复。
 */
import { afterEach, describe, expect, it } from "vitest";
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

describe("SQLite 存档", () => {
  it("创建冻结快照并保留源分支", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "paused" });
    const save = new SqliteSaveService(value.storage, value.host.ids, () => value.host.nowIso());
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "测试存档", createdBy: "player-1" });
    expect(snapshot).toMatchObject({ sourceBranchId: value.branchId, worldTick: 5, label: "测试存档" });
    expect(save.listSnapshots().map((item) => item.snapshotId)).toContain(snapshot.snapshotId);
    const frozen = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: snapshot.frozenBranchId }));
    expect(frozen).toMatchObject({ kind: "snapshot", status: "frozen", parent_branch_id: value.branchId });
    const source = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: value.branchId }));
    expect(source).toMatchObject({ kind: "online" });
  });

  it("从快照恢复为绑定源 run 的在线分支", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    value.storage.transact((tx) => {
      const row = tx.rows("branches").get({ branch_id: value.branchId });
      if (row === null) {
        throw new Error("缺少源分支");
      }
      tx.rows("branches").put({ ...row, run_id: "run-save-test" });
    });
    const save = new SqliteSaveService(value.storage, value.host.ids, () => value.host.nowIso());
    const snapshot = save.createSnapshot({ sourceBranchId: value.branchId, label: "恢复点", createdBy: "operator-1" });
    const restored = save.restoreSnapshot({ snapshotId: snapshot.snapshotId, createdBy: "operator-1", runId: "run-save-restored" });
    expect(restored.runId).toBe("run-save-restored");
    const row = value.storage.transact((tx) => tx.rows("branches").get({ branch_id: restored.branchId }));
    expect(row).toMatchObject({ kind: "online", status: "active", run_id: "run-save-restored", parent_branch_id: snapshot.frozenBranchId });
  });
});
