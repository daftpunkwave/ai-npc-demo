/**
 * 在线入口解析：从 world_aliases('online') 读出唯一的在线分支与 live run，并在启动前校验一致性。
 * 依赖存储行视图、规范 JSON 与 kernel 解析计划；不创建分支、不修改别名。
 * 禁止在别名缺失之外静默新建或改选其他分支，也禁止接受状态不一致的在线记录继续启动。
 */
import { canonicalJson, type StorageRow, type StorageTransaction } from "@ai-npc/contracts";
import type { ResolvedRealmPlan } from "@ai-npc/kernel";

/** 在线入口：world_aliases('online') 指向的唯一在线分支及其绑定的 live run。 */
export interface OnlineEntry {
  readonly branch: StorageRow;
  readonly run: StorageRow;
  readonly branchId: string;
  readonly runId: string;
  readonly worldId: string;
}

/**
 * 从持久化的在线别名解析分支与 run；这是启动、重启与恢复共同的唯一入口。
 * 别名缺失表示首次启动，返回 null；别名存在但分支、run 或状态不一致时明确失败，不静默新建或改选其他分支。
 */
export function readOnlineEntry(tx: StorageTransaction): OnlineEntry | null {
  const alias = tx.rows("world_aliases").get({ alias: "online" });
  if (alias === null) {
    return null;
  }
  const branchId = typeof alias["branch_id"] === "string" ? alias["branch_id"] : "";
  if (branchId.length === 0) {
    throw new Error("world_aliases('online') 缺少 branch_id");
  }
  const branch = tx.rows("branches").get({ branch_id: branchId });
  if (branch === null) {
    throw new Error(`在线别名指向的分支 ${branchId} 不存在；拒绝启动`);
  }
  if (branch["kind"] !== "online") {
    throw new Error(`在线别名指向的分支 ${branchId} 不是 online 分支；拒绝启动`);
  }
  const status = branch["status"];
  if (status !== "active" && status !== "paused") {
    throw new Error(`在线别名指向的分支 ${branchId} 状态为 ${String(status)}；拒绝启动`);
  }
  const runId = typeof branch["run_id"] === "string" ? branch["run_id"] : "";
  if (runId.length === 0) {
    throw new Error(`在线分支 ${branchId} 没有绑定 run；拒绝启动`);
  }
  const run = tx.rows("runs").get({ run_id: runId });
  if (run === null) {
    throw new Error(`在线分支 ${branchId} 绑定的 run ${runId} 不存在；拒绝启动`);
  }
  if (run["mode"] !== "live") {
    throw new Error(`在线 run ${runId} 不是 live run；拒绝启动`);
  }
  if (run["branch_id"] !== branchId) {
    throw new Error(`在线 run ${runId} 绑定的分支与别名分支 ${branchId} 不一致；拒绝启动`);
  }
  const runStatus = run["status"];
  if (runStatus === "completed" || runStatus === "failed" || runStatus === "invalid") {
    throw new Error(`在线 run ${runId} 状态为 ${String(runStatus)}；拒绝启动`);
  }
  const worldId = typeof branch["world_id"] === "string" ? branch["world_id"] : "";
  if (worldId.length === 0) {
    throw new Error(`在线分支 ${branchId} 缺少 world_id；拒绝启动`);
  }
  return { branch, run, branchId, runId, worldId };
}

/** 内容版本不兼容时给出冻结值与当前值，便于定位是哪一次内容发布。 */
export function contentVersionMismatch(frozen: string, current: string, scope: string): Error {
  return new Error(`内容包 contentVersion 不一致：${scope} 冻结「${frozen}」，当前内容包「${current}」；拒绝启动`);
}

/** 已启动的存储实例必须与在线装配声明的存储配置一致，避免用错误设置继续运行。 */
export function assertStorageCompatible(
  activePlan: ResolvedRealmPlan,
  requestedPlan: ResolvedRealmPlan,
  storageModuleId: string,
): void {
  const activeStorage = activePlan.modules.find((module) => module.moduleId === storageModuleId);
  const requestedStorage = requestedPlan.modules.find((module) => module.moduleId === storageModuleId);
  if (activeStorage === undefined || requestedStorage === undefined) {
    throw new Error(`在线装配缺少当前启动的存储模块 ${storageModuleId}`);
  }
  if (canonicalJson(activeStorage.config) !== canonicalJson(requestedStorage.config)) {
    throw new Error("在线装配的存储配置与本次启动不一致；拒绝使用不匹配的存储实例");
  }
}
