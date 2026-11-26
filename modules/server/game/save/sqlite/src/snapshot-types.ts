/**
 * 核心职责：声明存档服务对外的快照记录、创建/恢复入参与结果结构，以及内部冻结快照视图。
 * 交互契约：这些类型是存档端口与 SQLite 实现共用的数据契约；只声明结构，不含行为。
 * 约束与禁忌：不在此读写存储、不校验业务规则，也不重复定义通用存储单元格类型。
 */
import type { Json, StorageCell } from "@ai-npc/contracts";

export interface SnapshotRecord {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly label: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreateSnapshotInput {
  readonly sourceBranchId: string;
  readonly label: string;
  readonly createdBy: string;
}

/** 恢复 dry-run 读出的源 run；宿主据它校验内容、装配、名册与运行规格兼容性。 */
export interface SnapshotSourceRun {
  readonly runId: string;
  readonly worldId: string;
  readonly branchId: string;
  readonly runSpec: Json;
  readonly manifest: Json;
  readonly manifestHash: string;
  readonly contaminated: number;
  readonly evidenceComplete: number;
}

/** 一次恢复 dry-run 的结果；只做只读校验，不产生任何写入。 */
export interface RestoreInspection {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly sourceRun: SnapshotSourceRun;
}

/** dry-run 与提交之间源 run 的稳定摘要；事务内重新比对，防止校验后被并发改写。 */
export interface RestoreExpectation {
  readonly sourceRunId: string;
  readonly canonicalRunSpec: string;
  readonly manifestHash: string;
  readonly worldSeq: number;
  readonly worldTick: number;
}

export interface RestoreSnapshotInput {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
  readonly expected?: RestoreExpectation;
}

/** 恢复提交结果：新在线分支、绑定的新 run 与被替换的旧在线分支。 */
export interface RestoreResult {
  readonly branchId: string;
  readonly runId: string;
  readonly worldId: string;
  readonly previousBranchId: string;
  readonly sourceRunId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
}

/** 已校验的冻结快照：快照行与冻结分支一致，且冻结分支带完整时钟与事件前沿。 */
export interface FrozenSnapshot {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly sourceRunId: string | null;
}
