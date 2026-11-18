/**
 * 从进程环境按 credentialRef 解析密钥；只接受 allowlist 中的变量名。
 * 依赖严格配置与 process.env；不缓存明文。
 * 禁止返回未授权变量、记录密钥或对浏览器暴露端口。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { secretsConfigSchema } from "./definition";

export interface SecretsPort {
  resolve(credentialRef: string): string | null;
}

/** 创建只读环境密钥端口。 */
export async function createSecretsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = secretsConfigSchema.parse(input.config);
  const allowlist = new Set(config.allowlist);
  const port: SecretsPort = {
    resolve: (credentialRef) => {
      if (!allowlist.has(credentialRef)) {
        return null;
      }
      const value = process.env[credentialRef];
      return typeof value === "string" && value.length > 0 ? value : null;
    },
  };
  return createStatelessModule(input, port);
}
