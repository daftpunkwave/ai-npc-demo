/**
 * 核心职责：识别在线 run 的能力闭包升级场景并执行显式迁移；迁移在单事务内派生新分支与新 run。
 * 交互契约：依赖 StoragePort 的 forkBranch 端口、宿主 ID 与时间服务、冻结 manifest 的规范化哈希。
 * 约束与禁忌：不修改源 run 行、源分支与源 manifest；不决定迁移时机（由宿主启动编排按部署开关触发）；
 * 不可迁移的失败（数据损坏、内容版本不一致）不得进入迁移路径。
 */
import { type HostServices, type Json, type StoragePort, type StorageTransaction } from "@ai-npc/contracts";
import type { RunManifest } from "./manifest";
import type { OnlineEntry } from "./online-entry";

/**
 * 在线 run 的冻结 manifest 无法按当前模块目录复算：能力闭包已升级，需要显式迁移。
 * 携带 runId 与失败细节，供启动编排区分「需要迁移」与不可恢复的数据损坏。
 */
export class OnlineRunMigrationRequiredError extends Error {
  readonly runId: string;
  readonly branchId: string;

  constructor(input: { readonly runId: string; readonly branchId: string; readonly detail: string }) {
    super(
      `在线 run ${input.runId} 的冻结 manifest 无法按当前模块目录复算（能力闭包已升级）：${input.detail}。` +
        "源 run 与分支保持原样，未被修改。设置 NPC_MIGRATE_ONLINE_RUN=1 重启以执行显式迁移" +
        "（从源分支派生新分支与新 run，沿用原 seed 与 RunSpec，按当前能力闭包冻结新 manifest），" +
        "或回退到创建该 run 的代码版本。",
    );
    this.name = "OnlineRunMigrationRequiredError";
    this.runId = input.runId;
    this.branchId = input.branchId;
  }
}

/** 迁移结果：新 run 与新分支的标识；源 run 与源分支保持原样。 */
export interface MigratedOnlineRun {
  readonly runId: string;
  readonly branchId: string;
}

/** 迁移输入：在线入口、冻结 RunSpec 原文与按当前能力闭包重建的 manifest。 */
export interface MigrateOnlineRunInput {
  readonly storage: StoragePort;
  /** 宿主服务：生成 runId/branchId 与时间戳。 */
  readonly host: Pick<HostServices, "ids" | "nowIso">;
  readonly online: OnlineEntry;
  readonly runSpec: Json;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

function numericCell(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function putRunRow(tx: StorageTransaction, input: MigrateOnlineRunInput, runId: string, branchId: string, nowIso: string): void {
  const sourceRun = input.online.run;
  tx.rows("runs").put({
    run_id: runId,
    world_id: input.online.worldId,
    branch_id: branchId,
    mode: "live",
    status: "running",
    run_spec_json: input.runSpec,
    manifest_json: input.manifest as unknown as Json,
    manifest_hash: input.manifestHash,
    contaminated: numericCell(sourceRun["contaminated"], 0),
    evidence_complete: numericCell(sourceRun["evidence_complete"], 1),
    created_at: nowIso,
    started_at: nowIso,
    ended_at: null,
  });
}

/**
 * 执行显式迁移：单事务内派生 online 分支、写入新 run 行并把 online 别名切换到新分支。
 * forkBranch 在同一事务内复制全部分支级表（事件与状态原样延续），并暂停新分支时钟、
 * 释放未完成 trigger、把激活置为 dormant；源 run 与源分支的所有行保持原样。
 */
export function migrateOnlineRun(input: MigrateOnlineRunInput): MigratedOnlineRun {
  const runId = input.host.ids("run");
  const branchId = input.host.ids("br");
  const nowIso = input.host.nowIso();
  input.storage.transact((tx) => {
    input.storage.forkBranch(tx, {
      srcBranchId: input.online.branchId,
      dstBranchId: branchId,
      kind: "online",
      runId,
      profileHash: null,
    });
    putRunRow(tx, input, runId, branchId, nowIso);
    tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: nowIso });
  });
  return { runId, branchId };
}

/** 迁移证据描述：源与新 run 的标识与沿用 seed，供启动日志与测试断言使用。 */
export function migrationSummary(input: MigrateOnlineRunInput, migrated: MigratedOnlineRun): string {
  return `在线 run 迁移完成：源 run ${input.online.runId}（分支 ${input.online.branchId}）保持原样，` +
    `新 run ${migrated.runId}（分支 ${migrated.branchId}）按当前能力闭包冻结 manifest ${input.manifestHash}，` +
    `seed 沿用源 run：${input.manifest.seed}。`;
}
