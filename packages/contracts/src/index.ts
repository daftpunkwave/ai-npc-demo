/**
 * 汇总公共契约包的命名导出：JSON、ID、信封、命令、事件、投影、模块、API、模型与 schema 工具。
 * 依赖各主题源文件的 Zod schema 与类型；不引入任何宿主机制或功能实现。
 * 禁止在此追加实现逻辑，包入口只做再导出并保留包名常量。
 */
export const packageName = "@ai-npc/contracts";

export * from "./json";
export * from "./ids";
export * from "./audience";
export * from "./frontier";
export * from "./observation";
export * from "./memory";
export * from "./errors";
export * from "./reason-codes";
export * from "./envelopes";
export * from "./commands";
export * from "./events";
export * from "./projection";
export * from "./agent-world-view";
export * from "./modules";
export * from "./storage";
export * from "./model";
export * from "./agent-runtime";
export * from "./schema-profile";
export * from "./versions";
export * from "./api";
export * from "./api-stream";
export * from "./api-console";
export * from "./api-operations";
export * from "./api-observe";
export * from "./api-debug";
export * from "./api-evaluation";
