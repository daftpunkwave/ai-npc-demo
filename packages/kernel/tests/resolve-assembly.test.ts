/**
 * 验证装配解析的成功路径：拓扑顺序、配置解析、port 装配关系、多实现与可选能力。
 * 依赖 kernel 的 resolveRealmPlan、实例注册表与最小假模块，不加载真实模块或配置。
 * 禁止依赖装配书写顺序或注册顺序得到非确定结果。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityRef, ModuleDefinition, Realm } from "@ai-npc/contracts";
import { createModuleRegistry, resolveRealmPlan, type CatalogSnapshot } from "../src/index";
import { binding, capability, fakeModule, makeAssembly } from "./support";

function catalogOf(...definitions: readonly ModuleDefinition[]): CatalogSnapshot {
  const registry = createModuleRegistry();
  for (const definition of definitions) {
    registry.register(definition);
  }
  return registry.snapshot();
}

function planFor(
  definitions: readonly ModuleDefinition[],
  assembly: ReturnType<typeof makeAssembly>,
  realm: Realm = "server",
) {
  return resolveRealmPlan({ assembly, realm, catalog: catalogOf(...definitions) });
}

const clock = fakeModule({
  id: "game.clock.controlled",
  instanceScope: "run",
  provides: [capability("game.clock", "exactly-one", "run")],
  configSchema: z.strictObject({ secondsPerTick: z.number().int().positive().default(10) }),
  port: { capability: "game.clock" },
});

const storage = fakeModule({
  id: "platform.storage.sqlite",
  instanceScope: "deployment",
  provides: [capability("platform.storage", "exactly-one", "deployment")],
  port: { capability: "platform.storage" },
});

const world = fakeModule({
  id: "game.world.slg-light",
  instanceScope: "run",
  provides: [capability("game.world", "exactly-one", "run")],
  requires: [
    capability("game.clock", "exactly-one", "run"),
    capability("platform.storage", "exactly-one", "deployment"),
  ],
  port: { capability: "game.world" },
});

const standardAssembly = makeAssembly({
  configs: { clock: { secondsPerTick: 10 } },
  server: {
    bindings: [
      binding("game.world", "game.world.slg-light"),
      binding("game.clock", "game.clock.controlled", "clock"),
      binding("platform.storage", "platform.storage.sqlite"),
    ],
  },
});

describe("装配解析成功路径", () => {
  it("按依赖拓扑排序并填入配置默认值", () => {
    const plan = planFor([world, storage, clock], standardAssembly);
    expect(plan.realm).toBe("server");
    expect(plan.assemblyId).toBe("test-assembly");
    expect(plan.modules.map((module) => module.moduleId)).toEqual([
      "game.clock.controlled",
      "platform.storage.sqlite",
      "game.world.slg-light",
    ]);
    const clockPlan = plan.modules.find((module) => module.moduleId === "game.clock.controlled");
    expect(clockPlan?.config).toEqual({ secondsPerTick: 10 });
    expect(clockPlan?.configRef).toBe("clock");
  });

  it("记录每个 requires 的 port 提供者", () => {
    const plan = planFor([world, storage, clock], standardAssembly);
    const worldPlan = plan.modules.find((module) => module.moduleId === "game.world.slg-light");
    const clockRequirement = worldPlan?.requires.find((requirement) => requirement.capability === "game.clock");
    expect(clockRequirement?.providers).toEqual([{ moduleId: "game.clock.controlled", version: "1.0.0" }]);
    const storageRequirement = worldPlan?.requires.find(
      (requirement) => requirement.capability === "platform.storage",
    );
    expect(storageRequirement?.providers).toEqual([{ moduleId: "platform.storage.sqlite", version: "1.0.0" }]);
  });

  it("解析注册顺序不同但语义相同的目录，实例顺序一致", () => {
    const first = planFor([world, storage, clock], standardAssembly);
    const second = planFor([clock, storage, world], standardAssembly);
    expect(second.modules.map((module) => module.moduleId)).toEqual(
      first.modules.map((module) => module.moduleId),
    );
  });

  it("many 能力保留全部绑定并按装配绑定顺序排列", () => {
    const anthropic = fakeModule({
      id: "platform.model-transport.anthropic",
      provides: [capability("platform.model-transport", "many", "deployment")],
      port: { adapter: "anthropic" },
    });
    const openai = fakeModule({
      id: "platform.model-transport.openai-compatible",
      provides: [capability("platform.model-transport", "many", "deployment")],
      port: { adapter: "openai-compatible" },
    });
    const pool = fakeModule({
      id: "agent.model-pool.shared",
      provides: [capability("agent.model-pool", "exactly-one", "deployment")],
      requires: [capability("platform.model-transport", "many", "deployment")],
      port: { capability: "agent.model-pool" },
    });
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("agent.model-pool", "agent.model-pool.shared"),
          binding("platform.model-transport", "platform.model-transport.anthropic"),
          binding("platform.model-transport", "platform.model-transport.openai-compatible"),
        ],
      },
    });
    const plan = planFor([openai, anthropic, pool], assembly);
    expect(plan.modules.map((module) => module.moduleId)).toEqual([
      "platform.model-transport.anthropic",
      "platform.model-transport.openai-compatible",
      "agent.model-pool.shared",
    ]);
    const poolPlan = plan.modules.find((module) => module.moduleId === "agent.model-pool.shared");
    const transportRequirement = poolPlan?.requires.find(
      (requirement) => requirement.capability === "platform.model-transport",
    );
    expect(transportRequirement?.providers).toEqual([
      { moduleId: "platform.model-transport.anthropic", version: "1.0.0" },
      { moduleId: "platform.model-transport.openai-compatible", version: "1.0.0" },
    ]);
  });

  it("optional 能力缺失时保留空提供者而不报错", () => {
    const hud = fakeModule({
      id: "client.hud.standard",
      realm: "client",
      instanceScope: "session",
      provides: [capability("client.hud", "exactly-one", "session")],
      requires: [capability("client.assets", "optional", "session")],
      port: { capability: "client.hud" },
    });
    const assembly = makeAssembly({ client: { bindings: [binding("client.hud", "client.hud.standard")] } });
    const plan = planFor([hud], assembly, "client");
    const hudPlan = plan.modules[0];
    expect(hudPlan?.requires).toEqual([
      { capability: "client.assets", cardinality: "optional", instanceScope: "session", providers: [] },
    ]);
  });

  it("同一模块绑定多个能力时只生成一个实例计划", () => {
    const dual = fakeModule({
      id: "game.actions.standard",
      instanceScope: "run",
      provides: [
        capability("game.actions", "exactly-one", "run"),
        capability("game.timer", "exactly-one", "run"),
      ],
      port: { capability: "game.actions" },
    });
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("game.actions", "game.actions.standard"),
          binding("game.timer", "game.actions.standard"),
        ],
      },
    });
    const plan = planFor([dual], assembly);
    expect(plan.modules.map((module) => module.moduleId)).toEqual(["game.actions.standard"]);
  });

  it("agentSlots 候选只校验闭包、不进入实例计划", () => {
    const comms = fakeModule({
      id: "game.comms.standard",
      instanceScope: "run",
      provides: [capability("game.comms", "exactly-one", "run")],
      port: { capability: "game.comms" },
    });
    const memory = fakeModule({
      id: "agent.memory.none",
      instanceScope: "agent",
      provides: [capability("agent.memory", "exactly-one", "agent")],
      requires: [capability("game.comms", "exactly-one", "run")],
      port: { capability: "agent.memory" },
    });
    const assembly = makeAssembly({
      server: {
        bindings: [binding("game.comms", "game.comms.standard")],
        agentSlots: { memory: ["agent.memory.none"] },
      },
    });
    const plan = planFor([comms, memory], assembly);
    expect(plan.modules.map((module) => module.moduleId)).toEqual(["game.comms.standard"]);
    expect(plan.agentSlots).toEqual({ memory: ["agent.memory.none"] });
  });

  it("浏览器模块允许声明 requiresRemote", () => {
    const hud = fakeModule({
      id: "client.hud.standard",
      realm: "client",
      instanceScope: "session",
      provides: [capability("client.hud", "exactly-one", "session")],
      requiresRemote: ["server.world"],
      port: { capability: "client.hud" },
    });
    const assembly = makeAssembly({ client: { bindings: [binding("client.hud", "client.hud.standard")] } });
    const plan = planFor([hud], assembly, "client");
    expect(plan.modules.length).toBe(1);
  });

  it("宿主固定必需能力全部有绑定时通过", () => {
    const assembly = makeAssembly({
      server: { bindings: [binding("platform.storage", "platform.storage.sqlite")] },
    });
    const requiredCapabilities: CapabilityRef[] = [capability("platform.storage", "exactly-one", "deployment")];
    const plan = resolveRealmPlan({
      assembly,
      realm: "server",
      catalog: catalogOf(storage, clock),
      requiredCapabilities,
    });
    expect(plan.modules.map((module) => module.moduleId)).toEqual(["platform.storage.sqlite"]);
  });
});
