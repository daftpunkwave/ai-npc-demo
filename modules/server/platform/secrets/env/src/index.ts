/**
 * 汇总环境密钥模块的公开入口：定义、配置 schema 与端口类型。
 * 不读取环境变量、不暴露密钥。
 */
export const packageName = "@ai-npc/mod-platform-secrets-env";

export { secretsConfigSchema, secretsModuleDefinition } from "./definition";
export type { SecretsConfig } from "./definition";
export type { SecretsPort } from "./plugin";
