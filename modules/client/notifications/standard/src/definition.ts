/**
 * 声明标准通知模块，向 notification slot 贡献玩家授权提醒。
 * 依赖玩家投影；不把日志、错误或控制台事件当作游戏提醒。
 * 禁止用渲染器本地计时器生成世界事实。
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
  id: "client.notifications.standard",
  realm: "client",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.notifications"),
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
      extensionId: "client.notifications.standard.toast",
      slot: "notification",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createNotificationsModule } = await import("./plugin");
    return createNotificationsModule(input);
  },
};

export const notificationsModuleDefinition = defineBrowserModule(definition);
