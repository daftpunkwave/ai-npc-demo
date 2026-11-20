/**
 * 声明客户端选择与输入意图模块，依赖世界视图、相机和屏幕投影。
 * 依赖公共模块契约；不直接发送命令或宣布游戏行动成功。
 * 禁止在描述符阶段绑定 DOM 事件或读取私有世界状态。
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
  id: "client.input.standard",
  realm: "client",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.input"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [
    requirement("client.world-view"),
    requirement("client.camera"),
    requirement("client.screen-projection"),
  ],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createInputModule } = await import("./plugin");
    return createInputModule(input);
  },
};

export const inputModuleDefinition = defineBrowserModule(definition);
