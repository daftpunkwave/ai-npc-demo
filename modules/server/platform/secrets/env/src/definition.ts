/**
 * 声明 platform.secrets.env 的身份、能力与严格配置 schema。
 * 依赖公共契约与 module-sdk；环境读取只在插件内发生。
 * 禁止在此读取环境变量或把密钥写入日志/快照。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

export const secretsConfigSchema = z
  .object({
    allowlist: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  })
  .strict();

export type SecretsConfig = z.infer<typeof secretsConfigSchema>;

const definition: ModuleDefinition = {
  id: "platform.secrets.env",
  realm: "server",
  kind: "adapter",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.secrets"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: secretsConfigSchema,
  defaults: { allowlist: [] },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createSecretsModule } = await import("./plugin");
    return createSecretsModule(input);
  },
};

/** 经 module-sdk 校验的环境密钥适配器定义。 */
export const secretsModuleDefinition = defineModule(definition);
