/**
 * 声明 platform.operations.standard 的身份、能力与严格配置 schema。
 * 依赖公共契约与 module-sdk；具体编排由端口注入。
 * 禁止在此直接写世界表、暂停时钟或调用存档实现。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const operationsConfigSchema = z.object({}).strict();

export type OperationsConfig = z.infer<typeof operationsConfigSchema>;

const definition: ModuleDefinition = {
  id: "platform.operations.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.operations"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: operationsConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createOperationsModule } = await import("./plugin");
    return createOperationsModule(input);
  },
};

/** 经 module-sdk 校验的运营编排定义。 */
export const operationsModuleDefinition = defineModule(definition);
