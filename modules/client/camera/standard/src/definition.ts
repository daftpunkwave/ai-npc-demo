/**
 * 声明客户端相机模块的会话能力与空配置。
 * 依赖公共模块契约；实现通过动态入口加载，不读取世界数据。
 * 禁止在描述符中创建计时器、订阅或浏览器画布。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const definition: ModuleDefinition = {
  id: "client.camera.standard",
  realm: "client",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.camera"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createCameraModule } = await import("./plugin");
    return createCameraModule(input);
  },
};

export const cameraModuleDefinition = defineBrowserModule(definition);
