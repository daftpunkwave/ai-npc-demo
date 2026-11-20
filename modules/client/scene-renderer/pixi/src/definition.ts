/**
 * 声明 PixiJS 灰盒场景适配器，并向 scene slot 贡献可替换画布。
 * 依赖世界视图、相机、屏幕投影与输入能力；不读取服务端数据库或私密内容。
 * 禁止由渲染器决定路径、位置、命中权限或任务完成结果。
 */
import { capabilityIdSchema, type CapabilityRef, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

function requirement(capability: string): CapabilityRef {
  return {
    capability: capabilityIdSchema.parse(capability),
    cardinality: "exactly-one",
    instanceScope: "session",
  };
}

const definition: ModuleDefinition = {
  id: "client.scene-renderer.pixi",
  realm: "client",
  kind: "adapter",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.scene-renderer"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [
    requirement("client.world-view"),
    requirement("client.camera"),
    requirement("client.screen-projection"),
    requirement("client.input"),
  ],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  contributions: [
    {
      extensionId: "client.scene-renderer.pixi.scene",
      slot: "scene",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createPixiSceneModule } = await import("./plugin");
    return createPixiSceneModule(input);
  },
};

export const pixiSceneModuleDefinition = defineBrowserModule(definition);
