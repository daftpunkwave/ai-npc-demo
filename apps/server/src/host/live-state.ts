/**
 * 运行期在线入口状态：宿主内存中的当前分支与世界 ID，恢复或重开后同步更新。
 * 只定义可变状态结构；不读写存储、不实现切换逻辑。
 * 禁止把该状态当作持久化事实读取，持久入口始终以 world_aliases('online') 为准。
 */
/** 运行期在线入口；字段可变，分支切换后由宿主更新。 */
export interface LiveRunState {
  branchId: string;
  worldId: string;
}
