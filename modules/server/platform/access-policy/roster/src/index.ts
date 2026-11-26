/**
 * 核心职责：汇总名册权限模块的公开入口。
 * 交互契约：只导出定义、配置 schema 与端口类型。
 * 约束与禁忌：不加载实现、不读取环境变量。
 */
export const packageName = "@ai-npc/mod-platform-access-policy-roster";

export { accessPolicyConfigSchema, accessPolicyModuleDefinition } from "./definition";
export type { AccessPolicyConfig } from "./definition";
export type { AccessPolicyPort } from "./plugin";
