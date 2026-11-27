/**
 * 声明 platform.storage.sqlite 模块的身份、能力与严格配置 schema。
 * 依赖公共契约的模块类型、module-sdk 的描述符校验与 zod；实现由 create 动态加载，避免定义文件引入 SQLite。
 * 禁止在此静态 import 实现、打开数据库、读取环境变量或放宽未知配置键。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

/**
 * 可轮转观测表的保留天数。键只允许保留策略登记为可轮转的观测表，领域事件、审计与实验证据等其他表名由 strict 拒绝；
 * 整个对象缺省或某张表缺省都表示永久保留。上限约 100 年，更长的保留期与永久保留没有区别，应直接省略。
 */
export const retentionDaysSchema = z
  .object({
    trace_spans: z.number().int().positive().max(36_500).optional(),
  })
  .strict();

export type RetentionDays = z.infer<typeof retentionDaysSchema>;

/**
 * 存储适配器配置：数据目录与保留天数由宿主从部署环境并入，内联 artifact 上限由装配配置块提供。
 * 数据库文件位于 dataDir/world-prism.db，备份写入 dataDir/backups。
 * retentionDays 不设默认值：未配置时解析结果不含该键，已冻结 manifest 里的模块配置与摘要保持不变。
 */
export const storageConfigSchema = z
  .object({
    dataDir: z.string().min(1).default("./data"),
    inlineArtifactMaxBytes: z.number().int().positive().default(65536),
    retentionDays: retentionDaysSchema.optional(),
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
