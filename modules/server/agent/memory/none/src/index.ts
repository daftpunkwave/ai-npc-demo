/**
 * 导出无长期记忆模块的稳定公开入口。
 * 只暴露描述符数据，不加载实现。
 * 禁止保留状态或暴露平行运行时。
 */
export { memoryNoneModuleDefinition } from "./definition";
