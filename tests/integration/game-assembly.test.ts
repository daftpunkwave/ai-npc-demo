/**
 * 验证地图、资源与世界模块通过 ModuleDefinition.create 暴露端口绑定器。
 * 依赖真实内容包、模块定义、内存 WorldTx 与确定性宿主；不绕过模块创建入口。
 * 禁止直接构造端口实现来替代模块实例。
 */
import { describe, expect, it } from "vitest";
import { loadContentPack } from "@ai-npc/experiment";
import type { ModuleCreateInput } from "@ai-npc/contracts";
import type { GameContent, WorldTx } from "@ai-npc/module-sdk";
import { createFakeHost } from "./authority-support";
import { createMemoryTx, toGameContent } from "./game-support";
import { mapModuleDefinition } from "@ai-npc/mod-game-map-six-nodes";
import { resourcesModuleDefinition } from "@ai-npc/mod-game-resources-light";
import { worldModuleDefinition } from "@ai-npc/mod-game-world-slg-light";

function input(definition: { readonly id: string }, host: ReturnType<typeof createFakeHost>): ModuleCreateInput {
  return {
    moduleId: definition.id,
    realm: "server",
    config: {},
    scope: {},
    ports: {},
    host,
    signal: new AbortController().signal,
  };
}

describe("模块实例端口", () => {
  const content: GameContent = toGameContent(loadContentPack("content", "earth-2964-v1"));
  const host = createFakeHost();

  it("地图模块实例可绑定并查询路径", async () => {
    const instance = await mapModuleDefinition.create(input(mapModuleDefinition, host));
    const port = instance.port as {
      bind(txFor: () => WorldTx, content: GameContent, ids: (prefix: string) => string): {
        findRoute(query: { fromNodeId: string; toNodeId: string; factionId: string; atTick: number; withCargo: boolean }): unknown;
      };
    };
    const map = port.bind(() => createMemoryTx(), content, host.ids);
    expect(map.findRoute({ fromNodeId: "grayharbor", toNodeId: "orchard", factionId: "human-neutral", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-gh-or"],
      travelTicks: 5,
    });
  });

  it("资源模块实例可绑定并初始化库存", async () => {
    const instance = await resourcesModuleDefinition.create(input(resourcesModuleDefinition, host));
    const port = instance.port as {
      bind(txFor: () => WorldTx): {
        initializeCampaign(content: GameContent): void;
        available(stockpileId: string, resource: "supply"): number;
      };
    };
    const tx = createMemoryTx();
    const resources = port.bind(() => tx);
    resources.initializeCampaign(content);
    expect(resources.available("sp-commons", "supply")).toBe(60);
  });

  it("世界模块实例可绑定并读取空世界", async () => {
    const instance = await worldModuleDefinition.create(input(worldModuleDefinition, host));
    const port = instance.port as {
      bind(txFor: () => WorldTx, content: GameContent, ids: (prefix: string) => string): {
        campaign(): unknown;
        meters(): unknown;
      };
    };
    const world = port.bind(() => createMemoryTx(), content, host.ids);
    expect(world.campaign()).toBeNull();
    expect(world.meters()).toBeNull();
  });
});
