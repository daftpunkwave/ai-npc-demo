/**
 * 声明玩家显示、镜头、存档与无障碍设置模块。
 * 依赖玩家投影与本地偏好端口；不改变世界规则、权限或当前模块装配。
 * 禁止把偏好保存当作服务端存档，也禁止从设置入口读取后台配置。
 */
import { capabilityIdSchema, type CapabilityRef, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const requirement: CapabilityRef = {
  capability: capabilityIdSchema.parse("client.world-view"),
  cardinality: "exactly-one",
  instanceScope: "session",
};

const definition: ModuleDefinition = {
  id: "client.settings.standard",
  realm: "client",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.settings"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [requirement],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  contributions: [
    {
      extensionId: "client.settings.standard.section",
      slot: "settings.section",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createSettingsModule } = await import("./plugin");
    return createSettingsModule(input);
  },
};

export const settingsModuleDefinition = defineBrowserModule(definition);
