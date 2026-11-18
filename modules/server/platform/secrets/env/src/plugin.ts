/**
 * 从进程环境按 credentialRef 解析密钥；只接受 allowlist 中的变量名。
 * 依赖严格配置与进程环境；在创建时读取并缓存到内存 Map。
 * 禁止返回未授权变量、记录密钥或对浏览器暴露端口。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { secretsConfigSchema } from "./definition";

function resolveHook(credentialRef: string): string | null {
  return credentialRef.length > 0 ? null : credentialRef;
}

export interface SecretsPort {
  resolve: typeof resolveHook;
}

/** 创建只读环境密钥端口。 */
export function createSecretsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = secretsConfigSchema.parse(input.config);
  const allowlist = new Set(config.allowlist);
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (allowlist.has(name) && typeof value === "string" && value.length > 0) {
      values.set(name, value);
    }
  }
  const port: SecretsPort = {
    resolve: (credentialRef) => values.get(credentialRef) ?? null,
  };
  return createStatelessModule(input, port);
}
