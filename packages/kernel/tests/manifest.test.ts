/**
 * 验证 configHash、catalogHash 与 assemblyHash 的稳定性、规范化输入与内容敏感性。
 * 依赖 kernel 的摘要函数、装配解析、注册表与假哈希端口，不实现真实密码学哈希。
 * 禁止让键书写顺序、注册顺序或数组声明顺序无意改变摘要。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModuleDefinition } from "@world-prism/contracts";
import {
  computeAssemblyHash,
  computeCatalogHash,
  computeConfigHash,
  createModuleRegistry,
  resolveRealmPlan,
  type CatalogSnapshot,
} from "../src/index";
import { binding, capability, expectDomainErrorAsync, fakeHasher, fakeModule, makeAssembly } from "./support";

const clock = fakeModule({
  id: "game.clock.controlled",
  instanceScope: "run",
  provides: [capability("game.clock", "exactly-one", "run")],
  configSchema: z.strictObject({ secondsPerTick: z.number().int().positive().default(10) }),
});

const storage = fakeModule({
  id: "platform.storage.sqlite",
  provides: [capability("platform.storage", "exactly-one", "deployment")],
});

const world = fakeModule({
  id: "game.world.slg-light",
  instanceScope: "run",
  provides: [capability("game.world", "exactly-one", "run")],
  requires: [
    capability("game.clock", "exactly-one", "run"),
    capability("platform.storage", "exactly-one", "deployment"),
  ],
});

function catalogOf(registerOrder: readonly ModuleDefinition[]): CatalogSnapshot {
  const registry = createModuleRegistry();
  for (const definition of registerOrder) {
    registry.register(definition);
  }
  return registry.snapshot();
}

const assembly = makeAssembly({
  configs: { clock: { secondsPerTick: 10 } },
  server: {
    bindings: [
      binding("game.world", "game.world.slg-light"),
      binding("game.clock", "game.clock.controlled", "clock"),
      binding("platform.storage", "platform.storage.sqlite"),
    ],
  },
});

describe("configHash", () => {
  it("键书写顺序不同但语义相同则摘要相同", async () => {
    const hash = fakeHasher();
    const first = await computeConfigHash({ alpha: 1, beta: { gamma: 2, delta: [1, 2] } }, hash);
    const second = await computeConfigHash({ beta: { delta: [1, 2], gamma: 2 }, alpha: 1 }, hash);
    expect(second).toBe(first);
  });

  it("内容不同则摘要不同，并把规范 JSON 交给 hash 端口", async () => {
    const record: string[] = [];
    const hash = fakeHasher(record);
    const small = await computeConfigHash({ b: 1, a: 2 }, hash);
    const large = await computeConfigHash({ b: 1, a: 3 }, hash);
    expect(large).not.toBe(small);
    expect(record[0]).toBe('{"a":2,"b":1}');
  });

  it("hash 端口返回空摘要时报错", async () => {
    await expectDomainErrorAsync(() => computeConfigHash({}, async () => ""), "plugin-failed");
  });
});

describe("catalogHash", () => {
  it("注册顺序不同不影响目录摘要", async () => {
    const hash = fakeHasher();
    const first = await computeCatalogHash(catalogOf([clock, storage, world]), hash);
    const second = await computeCatalogHash(catalogOf([world, storage, clock]), hash);
    expect(second).toBe(first);
  });

  it("能力声明顺序不同不影响目录摘要", async () => {
    const forward = fakeModule({
      id: "game.actions.standard",
      instanceScope: "run",
      provides: [
        capability("game.actions", "exactly-one", "run"),
        capability("game.timer", "exactly-one", "run"),
      ],
      requires: [
        capability("game.clock", "exactly-one", "run"),
        capability("game.map", "exactly-one", "run"),
      ],
    });
    const backward = fakeModule({
      id: "game.actions.standard",
      instanceScope: "run",
      provides: [
        capability("game.timer", "exactly-one", "run"),
        capability("game.actions", "exactly-one", "run"),
      ],
      requires: [
        capability("game.map", "exactly-one", "run"),
        capability("game.clock", "exactly-one", "run"),
      ],
    });
    const hash = fakeHasher();
    expect(await computeCatalogHash(catalogOf([forward]), hash)).toBe(
      await computeCatalogHash(catalogOf([backward]), hash),
    );
  });

  it("模块版本变化会改变目录摘要", async () => {
    const hash = fakeHasher();
    const upgraded = fakeModule({
      id: "game.clock.controlled",
      version: "2.0.0",
      instanceScope: "run",
      provides: [capability("game.clock", "exactly-one", "run")],
    });
    const first = await computeCatalogHash(catalogOf([clock]), hash);
    const second = await computeCatalogHash(catalogOf([upgraded]), hash);
    expect(second).not.toBe(first);
  });
});

describe("assemblyHash", () => {
  const catalog = catalogOf([world, storage, clock]);

  it("同一装配与计划重复计算结果稳定", async () => {
    const plan = resolveRealmPlan({ assembly, realm: "server", catalog });
    const hash = fakeHasher();
    const first = await computeAssemblyHash({ assembly, realm: "server", plan, hash });
    const second = await computeAssemblyHash({ assembly, realm: "server", plan, hash });
    expect(second).toBe(first);
  });

  it("配置变化会改变装配摘要", async () => {
    const changedAssembly = makeAssembly({
      configs: { clock: { secondsPerTick: 20 } },
      server: {
        bindings: [
          binding("game.world", "game.world.slg-light"),
          binding("game.clock", "game.clock.controlled", "clock"),
          binding("platform.storage", "platform.storage.sqlite"),
        ],
      },
    });
    const hash = fakeHasher();
    const basePlan = resolveRealmPlan({ assembly, realm: "server", catalog });
    const changedPlan = resolveRealmPlan({ assembly: changedAssembly, realm: "server", catalog });
    expect(await computeAssemblyHash({ assembly: changedAssembly, realm: "server", plan: changedPlan, hash })).not.toBe(
      await computeAssemblyHash({ assembly, realm: "server", plan: basePlan, hash }),
    );
  });

  it("Agent 槽位变化会改变装配摘要，计划模块不变", async () => {
    const memory = fakeModule({
      id: "agent.memory.none",
      instanceScope: "agent",
      provides: [capability("agent.memory", "exactly-one", "agent")],
    });
    const withSlots = makeAssembly({
      configs: { clock: { secondsPerTick: 10 } },
      server: {
        bindings: [
          binding("game.world", "game.world.slg-light"),
          binding("game.clock", "game.clock.controlled", "clock"),
          binding("platform.storage", "platform.storage.sqlite"),
        ],
        agentSlots: { memory: ["agent.memory.none"] },
      },
    });
    const slotsCatalog = catalogOf([world, storage, clock, memory]);
    const basePlan = resolveRealmPlan({ assembly, realm: "server", catalog: slotsCatalog });
    const slotsPlan = resolveRealmPlan({ assembly: withSlots, realm: "server", catalog: slotsCatalog });
    expect(slotsPlan.modules.map((module) => module.moduleId)).toEqual(
      basePlan.modules.map((module) => module.moduleId),
    );
    const hash = fakeHasher();
    expect(
      await computeAssemblyHash({ assembly: withSlots, realm: "server", plan: slotsPlan, hash }),
    ).not.toBe(await computeAssemblyHash({ assembly, realm: "server", plan: basePlan, hash }));
  });

  it("装配摘要包含每个模块的配置摘要", async () => {
    const plan = resolveRealmPlan({ assembly, realm: "server", catalog });
    const record: string[] = [];
    const hash = fakeHasher(record);
    await computeAssemblyHash({ assembly, realm: "server", plan, hash });
    const finalPayload = record[record.length - 1];
    expect(finalPayload).toBeDefined();
    const parsed = JSON.parse(finalPayload ?? "{}") as {
      assemblyId?: string;
      realm?: string;
      modules?: readonly { moduleId?: string; configHash?: string }[];
    };
    expect(parsed.assemblyId).toBe("test-assembly");
    expect(parsed.realm).toBe("server");
    expect(parsed.modules?.map((module) => module.moduleId).sort()).toEqual([
      "game.clock.controlled",
      "game.world.slg-light",
      "platform.storage.sqlite",
    ]);
    expect(parsed.modules?.every((module) => (module.configHash ?? "").length > 0)).toBe(true);
  });

  it("计划 realm 与请求 realm 不一致时报错", async () => {
    const plan = resolveRealmPlan({ assembly, realm: "server", catalog });
    await expectDomainErrorAsync(
      () => computeAssemblyHash({ assembly, realm: "client", plan, hash: fakeHasher() }),
      "assembly-incompatible",
    );
  });
});
