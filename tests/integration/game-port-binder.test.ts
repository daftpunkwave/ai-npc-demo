/**
 * 验证游戏端口绑定器的绑定上下文契约：依赖端口记录冻结、只含 requires 声明的能力，
 * 且按调用方收窄处理器可见端口。
 * 依赖 app-server 公开的绑定器与 kernel 计划类型；不启动存储或真实模块。
 * 禁止在本文件绕过绑定器直接构造处理器上下文。
 */
import { describe, expect, it } from "vitest";
import type { ModuleDefinition } from "@world-prism/contracts";
import type { GameContent, GameModulePorts, GamePortBindContext, ModuleBinder } from "@world-prism/module-sdk";
import { resolveGameModuleBindings } from "@world-prism/app-server/host";

/** 记录每次绑定收到的上下文，供断言端口记录内容使用。 */
const bindContexts: { readonly moduleId: string; readonly context: GamePortBindContext }[] = [];

/** 构造只记录绑定上下文的模块公开端口；规则贡献按参数声明聚合所有权。 */
function recordingPort(moduleId: string, ownsAggregates: readonly string[] = []): unknown {
  return {
    bind: (
      _txFor: unknown,
      _content: GameContent,
      _ids: unknown,
      context: GamePortBindContext,
    ) => {
      bindContexts.push({ moduleId, context });
      return { moduleId };
    },
    contributor: { moduleId, ownsAggregates },
  };
}

/** 构造最小模块定义；能力声明与聚合所有权即实际读取的全部字段。 */
function definition(
  id: string,
  provides: readonly string[],
  requires: readonly string[],
  ownsAggregates: readonly string[] = [],
): ModuleDefinition {
  return {
    id,
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "run",
    provides: provides.map((capability) => ({
      capability: capability as never,
      cardinality: "exactly-one" as const,
      instanceScope: "run" as const,
    })),
    requires: requires.map((capability) => ({
      capability: capability as never,
      cardinality: "exactly-one" as const,
      instanceScope: "run" as const,
    })),
    requiresRemote: [],
    configSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
    defaults: {},
    stateSchemaVersion: 1,
    ownsAggregates,
    migrationPaths: [],
    create: async () => {
      throw new Error("绑定器测试不创建实例");
    },
  };
}

function planned(id: string, definition: ModuleDefinition, requires: readonly string[]) {
  return {
    moduleId: id,
    definition,
    requires: requires.map((capability) => ({ capability })),
  };
}

function contentStub(): GameContent {
  return { factions: new Map() } as unknown as GameContent;
}

/** 构造两个模块的绑定：mod-map 提供 game.map，mod-world 提供 game.world 并依赖 game.map。 */
function bindings(): { readonly binder: ModuleBinder } {
  bindContexts.length = 0;
  const mapPlanned = planned("mod-map", definition("mod-map", ["game.map"], []), []);
  const worldPlanned = planned(
    "mod-world",
    definition("mod-world", ["game.world"], ["game.map"]),
    ["game.map"],
  );
  return resolveGameModuleBindings({
    plan: {
      assemblyId: "test-assembly",
      realm: "server",
      modules: [mapPlanned, worldPlanned],
      agentSlots: {},
    } as never,
    instances: [
      { moduleId: "mod-map", version: "1.0.0", instance: {} as never, port: recordingPort("mod-map") },
      { moduleId: "mod-world", version: "1.0.0", instance: {} as never, port: recordingPort("mod-world") },
    ],
    content: contentStub(),
    host: { ids: (prefix: string) => `${prefix}-000000000001` } as never,
  });
}

describe("游戏端口绑定上下文", () => {
  it("绑定上下文的依赖端口记录被冻结", () => {
    const { binder } = bindings();
    binder((() => {
      throw new Error("绑定器测试不打开事务");
    }) as never, "mod-world");
    const worldBind = bindContexts.find((entry) => entry.moduleId === "mod-world");
    expect(worldBind).toBeDefined();
    expect(Object.isFrozen(worldBind?.context.ports)).toBe(true);
  });

  it("依赖端口记录只含 requires 声明的能力，不包含自身提供或未声明的能力", () => {
    const { binder } = bindings();
    binder((() => {
      throw new Error("绑定器测试不打开事务");
    }) as never, "mod-world");
    const worldBind = bindContexts.find((entry) => entry.moduleId === "mod-world");
    expect(Object.keys(worldBind?.context.ports ?? {})).toEqual(["game.map"]);
    const mapBind = bindContexts.find((entry) => entry.moduleId === "mod-map");
    expect(Object.keys(mapBind?.context.ports ?? {})).toEqual([]);
  });

  it("模块的处理器端口视图拒绝未声明能力，宿主视图可见全部端口", () => {
    const { binder } = bindings();
    const txFor = (() => {
      throw new Error("绑定器测试不打开事务");
    }) as never;
    const worldPorts = binder(txFor, "mod-world") as GameModulePorts;
    expect(() => (worldPorts as unknown as Record<string, unknown>)["game.comms"]).toThrow(/未声明能力/);
    expect((worldPorts as unknown as Record<string, unknown>)["game.map"]).toBeDefined();
    expect((worldPorts as unknown as Record<string, unknown>)["game.world"]).toBeDefined();

    const hostPorts = binder(txFor, null) as unknown as Record<string, unknown>;
    expect(hostPorts["game.map"]).toBeDefined();
    expect(hostPorts["game.world"]).toBeDefined();
  });

  it("模块定义与规则贡献的聚合所有权不一致时启动期失败并列出差异", () => {
    const mapPlanned = planned("mod-map", definition("mod-map", ["game.map"], [], ["road"]), []);
    expect(() => resolveGameModuleBindings({
      plan: { assemblyId: "test-assembly", realm: "server", modules: [mapPlanned], agentSlots: {} } as never,
      instances: [{
        moduleId: "mod-map",
        version: "1.0.0",
        instance: {} as never,
        port: recordingPort("mod-map", ["passage-grant", "road"]),
      }],
      content: contentStub(),
      host: { ids: (prefix: string) => `${prefix}-000000000001` } as never,
    })).toThrow("游戏模块 mod-map 的规则贡献与模块定义声明的聚合所有权不一致：仅模块定义声明 []，仅规则贡献声明 [passage-grant]");
  });

  it("聚合所有权按集合比较，声明顺序不同不视为不一致", () => {
    const mapPlanned = planned("mod-map", definition("mod-map", ["game.map"], [], ["road", "passage-grant"]), []);
    const result = resolveGameModuleBindings({
      plan: { assemblyId: "test-assembly", realm: "server", modules: [mapPlanned], agentSlots: {} } as never,
      instances: [{
        moduleId: "mod-map",
        version: "1.0.0",
        instance: {} as never,
        port: recordingPort("mod-map", ["passage-grant", "road"]),
      }],
      content: contentStub(),
      host: { ids: (prefix: string) => `${prefix}-000000000001` } as never,
    });
    expect(result.contributors.map((contributor) => contributor.ownsAggregates)).toEqual([["passage-grant", "road"]]);
  });

  it("未注册的模块 ID 直接失败", () => {
    const { binder } = bindings();
    const txFor = (() => {
      throw new Error("绑定器测试不打开事务");
    }) as never;
    expect(() => binder(txFor, "mod-missing")).toThrow(/未注册游戏端口绑定/);
  });
});
