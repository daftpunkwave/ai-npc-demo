/**
 * 从进程环境按 credentialRef 解析密钥；只接受 allowlist 中的变量名。
 * 依赖严格配置与进程环境；在创建时读取并缓存到内存 Map。
 * 禁止返回未授权变量、记录密钥或对浏览器暴露端口。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { secretsConfigSchema, type SecretsConfig } from "./definition";

/** 只读环境密钥端口；值在构造时按 allowlist 固化。 */
export class SecretsPort {
  private readonly values: ReadonlyMap<string, string>;

  constructor(config: SecretsConfig) {
    const allowlist = new Set(config.allowlist);
    const values = new Map<string, string>();
    for (const [name, value] of Object.entries(process.env)) {
      if (allowlist.has(name) && typeof value === "string" && value.length > 0) {
        values.set(name, value);
      }
    }
    this.values = values;
  }

  resolve(credentialRef: string): string | null {
    return this.values.get(credentialRef) ?? null;
  }
}

/** 创建只读环境密钥端口。 */
export function createSecretsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = secretsConfigSchema.parse(input.config);
  return createStatelessModule(input, new SecretsPort(config));
}
