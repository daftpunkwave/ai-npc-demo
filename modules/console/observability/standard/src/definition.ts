/**
 * 声明研究员的只读观测页面，首版提供世界时间线与 Agent 摘要。
 * 依赖远端平台观测能力；不读取原始模型密钥或改变游戏世界。
 * 禁止让运营或评估角色通过页面绕过服务端角色范围。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const definition: ModuleDefinition = {
  id: "console.observability.standard",
  realm: "console",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("console.observability"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [],
  requiresRemote: [capabilityIdSchema.parse("platform.observability")],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  contributions: [
    {
      extensionId: "console.observability.standard.page",
      slot: "console.page",
      order: 30,
      allowedRoles: ["researcher"],
    },
  ],
  create: async (input) => {
    const { createObservabilityPageModule } = await import("./plugin");
    return createObservabilityPageModule(input);
  },
};

export const observabilityPageModuleDefinition = defineBrowserModule(definition);
