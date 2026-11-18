/**
 * 汇总内容 schema 的公开入口：共用原语、世界文件、状态文件与模板文件。
 * 依赖各主题 schema 文件；调用方只经此处引用，不导入更深的内部结构。
 * 禁止在此新增字段形状或改变文件归属。
 */
export * from "./common";
export * from "./world";
export * from "./state";
export * from "./templates";
