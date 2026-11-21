/**
 * 校验游戏模块端口绑定器按 requires 收窄处理器可见能力。
 * 依赖 kernel 装配解析、最小假模块端口与 app-server 的绑定器构造；不启动真实实例或存储。
 * 禁止让测试绕过绑定器直接断言静态端口对象。
 */
import { describe, expect, it } from "vitest";
import {
  DomainError,
  assemblyDescriptorSchema,
  capabilityIdSchema,
  emptyModuleConfigSchema,
  type ModuleDefinition,
  type ModuleInstance,
} from "@ai-npc/contracts";
import { resolveRealmPlan, type RunningInstance } from "@ai-npc/kernel";
import {
  defineModule,
  type GameContent,
  type GameModulePorts,
  type WorldTx,
} from "@ai-npc/module-sdk";
import {
  resolveGameModuleBindings,
  type GameModulePublicPort,
} from "@ai-npc/app-server";
import { createFakeHost } from "./authority-support";

function fakeModule(input: {
  readonly id: string;
  readonly provides: readonly string[];
  readonly requires?: readonly string[];
}): ModuleDefinition {
  return defineModule({
    id: input.id,
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "run",
    provides: input.provides.map((capability) => ({
      capability: capabilityIdSchema.parse(capability),
      cardinality: "exactly-one",
      instanceScope: "run",
    })),
    requires: (input.requires ?? []).map((capability) => ({
      capability: capabilityIdSchema.parse(capability),
      cardinality: "exactly-one",
      instanceScope: "run",
    })),
    requiresRemote: [],
    configSchema: emptyModuleConfigSchema,
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async () => {
      throw new Error("端口绑定测试不应创建模块实例");
    },
  });
}

const fakeInstance: ModuleInstance = {
  moduleId: "unused",
  start: async () => undefined,
  drain: async () => undefined,
  dispose: async () => undefined,
};

function runningInstance(definition: ModuleDefinition, port: unknown): RunningInstance {
  return {
    moduleId: definition.id,
    version: definition.version,
    instance: { ...fakeInstance, moduleId: definition.id },
    port,
  };
}

const mapDefinition = fakeModule({ id: "game.map.six-nodes", provides: ["game.map"] });
const worldDefinition = fakeModule({
  id: "game.world.slg-light",
  provides: ["game.world"],
  requires: ["game.map"],
});
const assembly = assemblyDescriptorSchema.parse({
  schemaVersion: 1,
  assemblyId: "test-module-port-bounds",
  configs: {},
  realms: {
    server: {
      bindings: [
        { capability: "game.map", moduleId: mapDefinition.id, configRef: null },
        { capability: "game.world", moduleId: worldDefinition.id, configRef: null },
      ],
    },
    client: { bindings: [] },
    console: { bindings: [] },
  },
});

/** 构造真实解析计划，并让世界模块的绑定函数记录它收到的依赖端口。 */
function planWithInstances() {
  const plan = resolveRealmPlan({ assembly, realm: "server", catalog: [mapDefinition, worldDefinition] });
  let worldDependencyPorts: Readonly<Record<string, unknown>> | null = null;
  const mapPort: GameModulePublicPort = {
    bind: () => ({ port: "map" }),
    contributor: { moduleId: mapDefinition.id, ownsAggregates: [] },
  };
  const worldPort: GameModulePublicPort = {
    bind: (_txFor, _content, _ids, context) => {
      worldDependencyPorts = context.ports;
      return { port: "world" };
    },
    contributor: { moduleId: worldDefinition.id, ownsAggregates: [] },
  };
  const instances = [
    runningInstance(mapDefinition, mapPort),
    runningInstance(worldDefinition, worldPort),
  ];
  return {
    plan,
    instances,
    worldDependencyPorts: () => worldDependencyPorts,
  };
}

const txFor = () => ({}) as WorldTx;

describe("游戏模块端口边界", () => {
  it("宿主视图拿到全部已装配端口", () => {
    const fixture = planWithInstances();
    const { binder } = resolveGameModuleBindings({
      plan: fixture.plan,
      instances: fixture.instances,
      content: {} as GameContent,
      host: createFakeHost(),
    });

    const ports = binder(txFor, null) as GameModulePorts;
    expect(ports["game.map"]).toEqual({ port: "map" });
    expect(ports["game.world"]).toEqual({ port: "world" });
  });

  it("世界模块只能看到自身能力与 requires，访问其他能力立即失败", () => {
    const fixture = planWithInstances();
    const { binder } = resolveGameModuleBindings({
      plan: fixture.plan,
      instances: fixture.instances,
      content: {} as GameContent,
      host: createFakeHost(),
    });

    const ports = binder(txFor, worldDefinition.id) as GameModulePorts;
    expect(ports["game.map"]).toEqual({ port: "map" });
    expect(ports["game.world"]).toEqual({ port: "world" });
    expect(() => ports["game.agreements"]).toThrow(DomainError);
    expect(() => ports["game.agreements"]).toThrow(/未声明能力 game\.agreements/);
  });

  it("地图模块看不到未声明的能力，地图端口在绑定世界前已就绪", () => {
    const fixture = planWithInstances();
    const { binder } = resolveGameModuleBindings({
      plan: fixture.plan,
      instances: fixture.instances,
      content: {} as GameContent,
      host: createFakeHost(),
    });

    const ports = binder(txFor, mapDefinition.id) as GameModulePorts;
    expect(ports["game.map"]).toEqual({ port: "map" });
    expect(() => ports["game.world"]).toThrow(/未声明能力 game\.world/);
    expect(fixture.worldDependencyPorts()).toMatchObject({ "game.map": { port: "map" } });
  });

  it("未知模块不获得任何端口视图", () => {
    const fixture = planWithInstances();
    const { binder } = resolveGameModuleBindings({
      plan: fixture.plan,
      instances: fixture.instances,
      content: {} as GameContent,
      host: createFakeHost(),
    });

    expect(() => binder(txFor, "game.clock.controlled")).toThrow(DomainError);
  });
});
