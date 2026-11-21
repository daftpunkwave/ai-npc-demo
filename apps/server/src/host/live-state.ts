/**
 * 运行期在线入口状态：宿主内存中的当前分支与世界 ID，恢复或重开后同步更新。
 * 在在线别名提交后更新内存状态，并通知依赖分支作用域的宿主服务。
 * 禁止把该状态当作持久化事实读取，持久入口始终以 world_aliases('online') 为准。
 */
/** 运行期在线入口；字段可变，分支切换后由宿主更新。 */
export interface LiveRunState {
  branchId: string;
  worldId: string;
  readonly onBranchChanged?: () => void;
}

export function switchLiveBranch(active: LiveRunState, branchId: string, worldId = active.worldId): void {
  if (active.branchId === branchId && active.worldId === worldId) return;
  active.branchId = branchId;
  active.worldId = worldId;
  active.onBranchChanged?.();
}
