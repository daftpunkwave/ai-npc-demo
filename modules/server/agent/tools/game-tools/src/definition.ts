/**
 * 声明共享游戏 ToolDefinition 与绑定解析能力。
 * 交互契约：模块配置提供内容包中的工具描述；binding 由调用方在 run 启动阶段冻结。
 * 约束与禁忌：不得在描述符中保存某 Agent 的长期权限或执行世界命令。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const gameToolsConfigSchema = z
  .object({
    toolDescriptions: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

export type GameToolsConfig = z.infer<typeof gameToolsConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.tools.game-tools",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [{
    capability: capabilityIdSchema.parse("agent.tools"),
    cardinality: "exactly-one",
    instanceScope: "run",
  }],
  requires: [],
  requiresRemote: [],
  configSchema: gameToolsConfigSchema,
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createGameToolsModule } = await import("./plugin");
    return createGameToolsModule(input);
  },
};

export const gameToolsModuleDefinition = defineModule(definition);