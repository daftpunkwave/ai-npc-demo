/**
 * 声明标准玩家 HUD 模块，向顶部 hud slot 贡献时间、读数、资源与时钟操作。
 * 依赖玩家授权投影；不计算库存、结算或任务完成。
 * 禁止用本地按钮状态代替服务端时钟，或隐藏失败并伪造保存成功。
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
  id: "client.hud.standard",
  realm: "client",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.hud"),
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
      extensionId: "client.hud.standard.top",
      slot: "hud",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createHudModule } = await import("./plugin");
    return createHudModule(input);
  },
};

export const hudModuleDefinition = defineBrowserModule(definition);
