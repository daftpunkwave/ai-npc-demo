/**
 * 汇总名册权限模块的公开入口：定义、配置 schema 与端口类型。
 * 不加载实现、不读取环境变量。
 */
export const packageName = "@ai-npc/mod-platform-access-policy-roster";

export { accessPolicyConfigSchema, accessPolicyModuleDefinition } from "./definition";
export type { AccessPolicyConfig } from "./definition";
export type { AccessDecision, AccessPolicyPort, AccessRequest } from "./plugin";
