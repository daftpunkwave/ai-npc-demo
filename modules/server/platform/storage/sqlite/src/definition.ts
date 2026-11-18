/**
 * 声明 platform.storage.sqlite 模块的身份、能力与严格配置 schema。
 * 依赖公共契约的模块类型、module-sdk 的描述符校验与 zod；实现由 create 动态加载，避免定义文件引入 SQLite。
 * 禁止在此静态 import 实现、打开数据库、读取环境变量或放宽未知配置键。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

/**
 * 存储适配器配置：数据目录由宿主从部署环境并入，内联 artifact 上限由装配配置块提供。
 * 数据库文件位于 dataDir/ai-npc.db，备份写入 dataDir/backups。
 */
export const storageConfigSchema = z
  .object({
    dataDir: z.string().min(1).default("./data"),
    inlineArtifactMaxBytes: z.number().int().positive().default(65536),
  })
  .strict();

export type StorageConfig = z.infer<typeof storageConfigSchema>;

const storageDefinition: ModuleDefinition = {
  id: "platform.storage.sqlite",
  realm: "server",
  kind: "adapter",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.storage"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: storageConfigSchema,
  defaults: { dataDir: "./data", inlineArtifactMaxBytes: 65536 },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createSqliteStorageModule } = await import("./plugin");
    return createSqliteStorageModule(input);
  },
};

/** 经 module-sdk 校验后的存储适配器模块定义；组合根只登记这一个入口。 */
export const storageModuleDefinition = defineModule(storageDefinition);
