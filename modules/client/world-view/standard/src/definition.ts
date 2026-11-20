/**
 * 声明玩家授权投影模块的会话能力、空配置与动态实现入口。
 * 依赖公共模块契约与 module-sdk；不在描述符阶段连接网络或创建投影状态。
 * 禁止让该模块持有服务端权威或绕过授权投影读取世界事实。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const configSchema = z.object({}).strict();

const definition: ModuleDefinition = {
  id: "client.world-view.standard",
  realm: "client",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.world-view"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createWorldViewModule } = await import("./plugin");
    return createWorldViewModule(input);
  },
};

export const worldViewModuleDefinition = defineBrowserModule(definition);
