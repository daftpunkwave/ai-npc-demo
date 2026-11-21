/**
 * 导出无长期记忆模块的稳定公开入口。
 * Public entry for the no-long-term-memory module.
 * Exposes descriptor data without loading the implementation.
 * Must not retain state or expose a parallel runtime.
 */
export { memoryNoneModuleDefinition } from "./definition";
