/**
 * 声明不绘制画面的测试场景适配器，记录最近一次授权场景供确定性测试读取。
 * 依赖世界视图、相机、屏幕投影与输入能力；不属于标准视觉装配。
 * 禁止在测试渲染器中显示或持久化未授权数据。
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
  id: "client.scene-renderer.null",
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
      extensionId: "client.scene-renderer.null.scene",
      slot: "scene",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createNullSceneModule } = await import("./plugin");
    return createNullSceneModule(input);
  },
};

export const nullSceneModuleDefinition = defineBrowserModule(definition);
