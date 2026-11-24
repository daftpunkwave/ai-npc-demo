/**
 * 验证装配解析的错误路径：缺模块、跨 realm、重复绑定、能力闭包、作用域、配置与环。
 * 依赖 kernel 的 resolveRealmPlan、实例注册表与最小假模块，不加载真实模块或配置。
 * 禁止静默选择重复实现、放过缺失能力或把错误退化为首个候选。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModuleDefinition } from "@ai-npc/contracts";
import { createModuleRegistry, resolveRealmPlan, type CatalogSnapshot } from "../src/index";
import { binding, capability, detailsText, expectDomainError, fakeModule, makeAssembly } from "./support";

function catalogOf(...definitions: readonly ModuleDefinition[]): CatalogSnapshot {
  const registry = createModuleRegistry();
  for (const definition of definitions) {
    registry.register(definition);
  }
  return registry.snapshot();
}

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

describe("装配解析错误路径", () => {
  it("绑定未注册模块时报错", () => {
    const assembly = makeAssembly({
      server: { bindings: [binding("game.world", "game.world.slg-light")] },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock) }),
      "module-missing",
    );
    expect(detailsText(error)).toContain("game.world.slg-light");
  });

  it("跨 realm 绑定时报错", () => {
    const clientModule = fakeModule({
      id: "client.hud.standard",
      realm: "client",
      instanceScope: "session",
      provides: [capability("client.hud", "exactly-one", "session")],
    });
    const assembly = makeAssembly({
      server: { bindings: [binding("client.hud", "client.hud.standard")] },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clientModule) }),
      "realm-violation",
    );
    expect(detailsText(error)).toContain("client");
  });

  it("不支持模块契约版本时拒绝装配", () => {
    const futureClock = fakeModule({
      id: "game.clock.controlled",
      instanceScope: "run",
      apiVersion: "2",
      provides: [capability("game.clock", "exactly-one", "run")],
      configSchema: z.strictObject({ secondsPerTick: z.number().int().positive().default(10) }),
    });
    const assembly = makeAssembly({
      server: { bindings: [binding("game.clock", "game.clock.controlled")] },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(futureClock) }),
      "assembly-incompatible",
    );
    expect(detailsText(error)).toContain("apiVersion");
    expect(detailsText(error)).toContain("2");
  });

  it("绑定模块未声明该能力时报错", () => {
    const assembly = makeAssembly({
      server: { bindings: [binding("game.world", "game.clock.controlled")] },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock) }),
      "assembly-incompatible",
    );
  });

  it("缺少必需能力时报错并定位消费方", () => {
    const world = fakeModule({
      id: "game.world.slg-light",
      instanceScope: "run",
      provides: [capability("game.world", "exactly-one", "run")],
      requires: [capability("game.clock", "exactly-one", "run")],
    });
    const assembly = makeAssembly({
      server: { bindings: [binding("game.world", "game.world.slg-light")] },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(world) }),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("game.clock");
    expect(detailsText(error)).toContain("game.world.slg-light");
  });

  it("same capability 两个独占实现时报冲突", () => {
    const alternativeClock = fakeModule({
      id: "game.clock.manual",
      instanceScope: "run",
      provides: [capability("game.clock", "exactly-one", "run")],
    });
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("game.clock", "game.clock.controlled"),
          binding("game.clock", "game.clock.manual"),
        ],
      },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock, alternativeClock) }),
      "capability-conflict",
    );
    expect(detailsText(error)).toContain("game.clock.manual");
  });

  it("同一能力重复绑定同一模块时报冲突", () => {
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("game.clock", "game.clock.controlled"),
          binding("game.clock", "game.clock.controlled"),
        ],
      },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock) }),
      "capability-conflict",
    );
  });

  it("同一模块被声明多个版本时拒绝装配", () => {
    const upgrade = fakeModule({
      id: "game.clock.controlled",
      version: "2.0.0",
      instanceScope: "run",
      provides: [capability("game.clock", "exactly-one", "run")],
    });
    const assembly = makeAssembly({
      server: { bindings: [binding("game.clock", "game.clock.controlled")] },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock, upgrade) }),
      "assembly-incompatible",
    );
    expect(detailsText(error)).toContain("2.0.0");
  });

  it("绑定引用不存在的配置块时报错", () => {
    const assembly = makeAssembly({
      server: { bindings: [binding("game.clock", "game.clock.controlled", "missing")] },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock) }),
      "assembly-incompatible",
    );
  });

  it("配置校验失败时带模块 ID 与原因", () => {
    const assembly = makeAssembly({
      configs: { clock: { unexpected: true } },
      server: { bindings: [binding("game.clock", "game.clock.controlled", "clock")] },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock) }),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("game.clock.controlled");
    expect(error.safeMessage).toContain("unexpected");
  });

  it("同一模块绑定多个能力却使用不同配置块时报错", () => {
    const dual = fakeModule({
      id: "game.actions.standard",
      instanceScope: "run",
      provides: [
        capability("game.actions", "exactly-one", "run"),
        capability("game.timer", "exactly-one", "run"),
      ],
    });
    const assembly = makeAssembly({
      configs: { first: {}, second: {} },
      server: {
        bindings: [
          binding("game.actions", "game.actions.standard", "first"),
          binding("game.timer", "game.actions.standard", "second"),
        ],
      },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(dual) }),
      "assembly-incompatible",
    );
  });

  it("能力依赖成环时报错并给出环路", () => {
    const actions = fakeModule({
      id: "game.actions.standard",
      instanceScope: "run",
      provides: [capability("game.actions", "exactly-one", "run")],
      requires: [capability("game.map", "exactly-one", "run")],
    });
    const map = fakeModule({
      id: "game.map.six-nodes",
      instanceScope: "run",
      provides: [capability("game.map", "exactly-one", "run")],
      requires: [capability("game.actions", "exactly-one", "run")],
    });
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("game.actions", "game.actions.standard"),
          binding("game.map", "game.map.six-nodes"),
        ],
      },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(actions, map) }),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("->");
    expect(detailsText(error)).toContain("game.actions.standard");
    expect(detailsText(error)).toContain("game.map.six-nodes");
  });

  it("提供者实例作用域窄于消费方要求时报错", () => {
    const perception = fakeModule({
      id: "agent.perception.local",
      instanceScope: "agent",
      provides: [capability("agent.perception", "exactly-one", "agent")],
    });
    const world = fakeModule({
      id: "game.world.slg-light",
      instanceScope: "run",
      provides: [capability("game.world", "exactly-one", "run")],
      requires: [capability("agent.perception", "exactly-one", "run")],
    });
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("agent.perception", "agent.perception.local"),
          binding("game.world", "game.world.slg-light"),
        ],
      },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(perception, world) }),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("agent.perception");
  });

  it("agentSlots 候选模块的 requires 也纳入闭包", () => {
    const memory = fakeModule({
      id: "agent.memory.none",
      instanceScope: "agent",
      provides: [capability("agent.memory", "exactly-one", "agent")],
      requires: [capability("game.comms", "exactly-one", "run")],
    });
    const assembly = makeAssembly({
      server: { bindings: [], agentSlots: { memory: ["agent.memory.none"] } },
    });
    const error = expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(memory) }),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("game.comms");
  });

  it("agentSlots 候选跨 realm 时报错", () => {
    const clientModule = fakeModule({
      id: "client.hud.standard",
      realm: "client",
      instanceScope: "session",
      provides: [capability("client.hud", "exactly-one", "session")],
    });
    const assembly = makeAssembly({
      server: { bindings: [], agentSlots: { memory: ["client.hud.standard"] } },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clientModule) }),
      "realm-violation",
    );
  });

  it("agentSlots 数组内重复模块 ID 时报错", () => {
    const memory = fakeModule({
      id: "agent.memory.none",
      instanceScope: "agent",
      provides: [capability("agent.memory", "exactly-one", "agent")],
    });
    const assembly = makeAssembly({
      server: { bindings: [], agentSlots: { memory: ["agent.memory.none", "agent.memory.none"] } },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(memory) }),
      "assembly-incompatible",
    );
  });

  it("宿主固定必需能力缺失时报错", () => {
    const assembly = makeAssembly({ server: { bindings: [] } });
    const error = expectDomainError(
      () =>
        resolveRealmPlan({
          assembly,
          realm: "server",
          catalog: catalogOf(storage),
          requiredCapabilities: [capability("platform.storage", "exactly-one", "deployment")],
        }),
      "assembly-incompatible",
    );
    expect(detailsText(error)).toContain("host");
  });

  it("服务端模块声明 requiresRemote 时报错", () => {
    const remoteConsumer = fakeModule({
      id: "game.comms.standard",
      instanceScope: "run",
      provides: [capability("game.comms", "exactly-one", "run")],
      requiresRemote: ["game.world"],
    });
    const assembly = makeAssembly({
      server: { bindings: [binding("game.comms", "game.comms.standard")] },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(remoteConsumer) }),
      "assembly-incompatible",
    );
  });

  it("fallback 绑定尚未支持时显式报错", () => {
    const assembly = makeAssembly({
      server: {
        bindings: [
          {
            ...binding("game.clock", "game.clock.controlled"),
            fallbackModuleIds: ["game.clock.manual"],
          },
        ],
      },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock) }),
      "assembly-incompatible",
    );
  });

  it("同一能力的实现声明不同基数时报错", () => {
    const manyClock = fakeModule({
      id: "game.clock.multi",
      instanceScope: "run",
      provides: [capability("game.clock", "many", "run")],
    });
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("game.clock", "game.clock.controlled"),
          binding("game.clock", "game.clock.multi"),
        ],
      },
    });
    expectDomainError(
      () => resolveRealmPlan({ assembly, realm: "server", catalog: catalogOf(clock, manyClock) }),
      "assembly-incompatible",
    );
  });
});
