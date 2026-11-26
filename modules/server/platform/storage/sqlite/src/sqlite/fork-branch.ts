/**
 * 分支复制：写入新的 branches 行，把全部分支级表整表复制到新 branch_id，再执行时钟、租约、trigger 与激活状态的修正。
 * 依赖 node:sqlite 连接、迁移推导的分支级表清单与端口契约；必须在调用方已开启的同步事务内执行。
 * 禁止复制运行级数据、遗漏分支级表、跳过 trigger 释放或让新分支沿用源分支的控制 epoch。
 */
import type { DatabaseSync } from "node:sqlite";
import { DomainError, type BranchKind, type BranchStatus, type ForkBranchRequest, type ForkBranchResult } from "@world-prism/contracts";
import { BRANCH_COLUMN, quoteSqlIdentifier, type StorageCatalog } from "./schema";

function q(identifier: string): string {
  return quoteSqlIdentifier(identifier);
}

/** 新分支的初始状态：快照冻结，在线、实验与沙盒分支活动。 */
function statusForKind(kind: BranchKind): BranchStatus {
  return kind === "snapshot" ? "frozen" : "active";
}

interface BranchSnapshotInfo {
  readonly worldId: string;
}

function readSourceBranch(database: DatabaseSync, branchId: string): BranchSnapshotInfo {
  const row = database.prepare("SELECT world_id FROM branches WHERE branch_id = ?").get(branchId);
  if (row === undefined) {
    throw new DomainError("not-found", `源分支 ${branchId} 不存在`, { details: { branchId } });
  }
  return { worldId: String(row["world_id"]) };
}

function assertTargetAbsent(database: DatabaseSync, branchId: string): void {
  const row = database.prepare("SELECT 1 AS present FROM branches WHERE branch_id = ?").get(branchId);
  if (row !== undefined) {
    throw new DomainError("validation", `目标分支 ${branchId} 已存在`, { details: { branchId } });
  }
}

function maxWorldSeq(database: DatabaseSync, branchId: string): number | null {
  const row = database.prepare("SELECT MAX(world_seq) AS value FROM domain_events WHERE branch_id = ?").get(branchId);
  const value = row?.["value"];
  return value === null || value === undefined ? null : Number(value);
}

/** 复制单张分支级表：只替换首列 branch_id，其余列按迁移目录原样拷贝。 */
function copyBranchTable(
  database: DatabaseSync,
  tableName: string,
  columns: readonly string[],
  srcBranchId: string,
  dstBranchId: string,
): number {
  const otherColumns = columns.filter((column) => column !== BRANCH_COLUMN);
  const insertColumns = [BRANCH_COLUMN, ...otherColumns].map(q).join(", ");
  const selectColumns = otherColumns.map(q).join(", ");
  const selectSql =
    selectColumns.length === 0
      ? `SELECT ? FROM ${q(tableName)} WHERE ${q(BRANCH_COLUMN)} = ?`
      : `SELECT ?, ${selectColumns} FROM ${q(tableName)} WHERE ${q(BRANCH_COLUMN)} = ?`;
  const sql = `INSERT INTO ${q(tableName)} (${insertColumns}) ${selectSql}`;
  const result = database.prepare(sql).run(dstBranchId, srcBranchId);
  return Number(result.changes);
}

/**
 * 复制完成后的修正：
 * 时钟暂停并递增 run_version；控制租约 epoch 递增以 fenced 源分支的在途输出；
 * trigger 仅在消费它的 turn 已到达终点时删除，否则释放供新分支重新调度；激活状态一律 dormant。
 */
function fixCopiedBranchRows(database: DatabaseSync, dstBranchId: string): void {
  database
    .prepare(
      `UPDATE ${q("clock")} SET ${q("mode")} = 'paused', ${q("run_version")} = ${q("run_version")} + 1 WHERE ${q(
        BRANCH_COLUMN,
      )} = ?`,
    )
    .run(dstBranchId);
  database
    .prepare(
      `UPDATE ${q("controller_leases")} SET ${q("controller_epoch")} = ${q("controller_epoch")} + 1 WHERE ${q(
        BRANCH_COLUMN,
      )} = ?`,
    )
    .run(dstBranchId);
  database
    .prepare(
      `UPDATE ${q("agent_activations")} SET ${q("status")} = 'dormant' WHERE ${q(BRANCH_COLUMN)} = ?`,
    )
    .run(dstBranchId);
  // trigger 的“已消费”判定独立于 turn 终态：cancelled 的 turn 会释放其 trigger 供重新调度，
  // 只有 completed/failed/budget-exhausted 视为已消费并在下方删除。
  database
    .prepare(
      `UPDATE ${q("triggers")} SET ${q("consumed_by_turn_id")} = NULL
       WHERE ${q(BRANCH_COLUMN)} = ? AND ${q("consumed_by_turn_id")} IS NOT NULL
         AND ${q("consumed_by_turn_id")} NOT IN (
           SELECT ${q("turn_id")} FROM ${q("turn_runs")}
           WHERE ${q("status")} IN ('completed', 'failed', 'budget-exhausted')
         )`,
    )
    .run(dstBranchId);
  database
    .prepare(
      `DELETE FROM ${q("triggers")} WHERE ${q(BRANCH_COLUMN)} = ? AND ${q("consumed_by_turn_id")} IS NOT NULL`,
    )
    .run(dstBranchId);
}

/** 在调用方事务内执行一次完整的分支复制，并返回新分支行与各表复制行数。 */
export function forkBranchDatabase(
  database: DatabaseSync,
  catalog: StorageCatalog,
  nowIso: string,
  request: ForkBranchRequest,
): ForkBranchResult {
  const source = readSourceBranch(database, request.srcBranchId);
  assertTargetAbsent(database, request.dstBranchId);

  const status = statusForKind(request.kind);
  const runId = request.runId ?? null;
  const profileHash = request.profileHash ?? null;
  const forkedAtWorldSeq = maxWorldSeq(database, request.srcBranchId);

  database
    .prepare(
      `INSERT INTO ${q("branches")} (${q("branch_id")}, ${q("world_id")}, ${q("kind")}, ${q("status")}, ${q(
        "parent_branch_id",
      )}, ${q("forked_at_world_seq")}, ${q("run_id")}, ${q("profile_hash")}, ${q("created_at")})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      request.dstBranchId,
      source.worldId,
      request.kind,
      status,
      request.srcBranchId,
      forkedAtWorldSeq,
      runId,
      profileHash,
      nowIso,
    );

  const copiedRows: Record<string, number> = {};
  for (const table of catalog.branchTables) {
    copiedRows[table.name] = copyBranchTable(
      database,
      table.name,
      table.columns.map((column) => column.name),
      request.srcBranchId,
      request.dstBranchId,
    );
  }
  fixCopiedBranchRows(database, request.dstBranchId);

  return {
    branchId: request.dstBranchId,
    parentBranchId: request.srcBranchId,
    kind: request.kind,
    status,
    runId,
    profileHash,
    forkedAtWorldSeq,
    copiedRows,
  };
}
