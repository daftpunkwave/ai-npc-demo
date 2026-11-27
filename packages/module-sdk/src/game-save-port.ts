/**
 * 核心职责：定义存档能力（game.save）的公共端口：快照创建与列出、恢复预检与事务内恢复，以及它们共用的数据结构；
 *   另声明模块实例公开端口与宿主注入的检查点查询（分支世界 tick 与事件前沿）。
 * 交互契约：依赖公共契约的存储事务与 JSON 类型；InTransaction 方法只读写调用方传入的事务，不自行提交或回滚。
 * 约束与禁忌：只声明结构，不含实现；端口不暂停时钟、不排空 job，这些由调用方在快照前完成。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type { Json, StorageTransaction } from "@world-prism/contracts";

/** 一条快照记录：冻结分支、源分支与快照时的事件前沿和世界 tick。 */
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

/**
 * 存档端口：宿主的快照、恢复与恢复预检编排只经此端口使用存档能力，不依赖具体实现。
 * 可预期的校验失败（快照不完整、源 run 不一致）以 DomainError 的 invalid-state 或 not-found 表示。
 */
export interface SavePort {
  /** 在自己的事务内创建快照：复制源分支为冻结分支并写入快照记录。 */
  createSnapshot(input: CreateSnapshotInput): SnapshotRecord;
  /** 在调用方事务内创建快照，供宿主把运营幂等记录与快照写入一起提交。 */
  createSnapshotInTransaction(tx: StorageTransaction, input: CreateSnapshotInput): SnapshotRecord;
  /** 只列出当前 campaign 创建的快照。 */
  listSnapshots(): readonly SnapshotRecord[];
  /** 恢复 dry-run：只读校验快照完整性与源 run。 */
  inspectRestore(snapshotId: string): RestoreInspection;
  /** 在调用方事务内执行恢复 dry-run；只读传入事务。 */
  inspectRestoreInTransaction(tx: StorageTransaction, snapshotId: string): RestoreInspection;
  /**
   * 在调用方事务内从快照切换在线世界：建立后继分支与 run、结束旧 run、归档旧分支并切换在线别名。
   * 给出 expected 时先比对 dry-run 摘要，不一致即拒绝。
   */
  restoreSnapshotInTransaction(tx: StorageTransaction, input: RestoreSnapshotInput): RestoreResult;
}

/**
 * 分支事件前沿查询：在调用方事务内返回该分支已提交领域事件的最大 world_seq，没有事件时为 0。
 * 领域事件归 authority 所有，存档实现不直接读事件表，由宿主把 authority 的查询注入存档模块。
 */
export type BranchEventFrontierQuery = (tx: StorageTransaction, branchId: string) => number;

/**
 * 分支世界 tick 查询：在调用方事务内返回该分支时钟的 world_tick；分支没有时钟行时抛 not-found。
 * 时钟归 game.clock 模块所有，存档实现不直接读时钟表，由宿主以时钟端口的 readInTransaction 提供。
 */
export type BranchWorldTickQuery = (tx: StorageTransaction, branchId: string) => number;

/**
 * 宿主组合根在绑定时注入存档实现的检查点查询。两者都不经 requires 解析：
 * 存档模块的描述符只依赖 platform.storage，模块目录摘要与已冻结 run 的 manifest 不因这些查询变化。
 */
export interface SaveHostQueries {
  readonly eventFrontier: BranchEventFrontierQuery;
  readonly worldTick: BranchWorldTickQuery;
}

/** game.save 模块实例的公开端口：宿主注入检查点查询后取得存档端口。 */
export interface SaveModulePort {
  bind(queries: SaveHostQueries): SavePort;
}
