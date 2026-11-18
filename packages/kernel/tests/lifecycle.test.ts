/**
 * 验证实例生命周期的创建/启动顺序、port 注入、失败回滚与 drain/dispose 幂等。
 * 依赖 kernel 的 resolveRealmPlan、startInstances 与最小假模块；不创建真实存储、模型或网络资源。
 * 禁止掩盖原始 create/start 错误、跳过逆序释放或重复执行释放动作。
 */
import { describe, expect, it } from "vitest";
import type { HostServices, ModuleScope } from "@ai-npc/contracts";
import {
  createModuleRegistry,
  resolveRealmPlan,
  startInstances,
  type ResolvedRealmPlan,
} from "../src/index";
import { binding, capability, expectDomainErrorAsync, fakeHostServices, fakeModule, makeAssembly } from "./support";

const storagePort = { capability: "platform.storage" };
const worldPort = { capability: "game.world" };
const storageRef = capability("platform.storage", "exactly-one", "deployment");
const worldRef = capability("game.world", "exactly-one", "run");

interface FixtureOptions {
  readonly failWorldCreate?: boolean;
  readonly failWorldStart?: boolean;
  readonly portlessStorage?: boolean;
  readonly disposeThrows?: boolean;
}

interface Fixture {
  readonly plan: ResolvedRealmPlan;
  readonly events: string[];
  readonly failure: Error;
  readonly host: HostServices;
  readonly scope: ModuleScope;
  readonly worldPorts: () => Readonly<Record<string, unknown>> | undefined;
  readonly createdHost: () => HostServices | undefined;
  readonly createdScope: () => ModuleScope | undefined;
  readonly createdSignal: () => AbortSignal | undefined;
}

function buildFixture(options: FixtureOptions = {}): Fixture {
  const events: string[] = [];
  const failure = new Error("模块启动失败");
  let worldPorts: Readonly<Record<string, unknown>> | undefined;
  let createdHost: HostServices | undefined;
  let createdScope: ModuleScope | undefined;
  let createdSignal: AbortSignal | undefined;

  const storage = fakeModule({
    id: "platform.storage.sqlite",
    provides: [storageRef],
    ...(options.portlessStorage === true ? {} : { port: storagePort }),
    onCreate: () => {
      events.push("create:storage");
    },
    onStart: async () => {
      events.push("start:storage");
    },
    onDrain: async (deadlineMs) => {
      events.push(`drain:storage:${deadlineMs}`);
    },
    onDispose: async () => {
      events.push("dispose:storage");
      if (options.disposeThrows) {
        throw new Error("dispose 失败");
      }
    },
  });

  const world = fakeModule({
    id: "game.world.slg-light",
    instanceScope: "run",
    provides: [worldRef],
    requires: [storageRef],
    port: worldPort,
    onCreate: (input) => {
      events.push("create:world");
      worldPorts = input.ports;
      createdHost = input.host;
      createdScope = input.scope;
      createdSignal = input.signal;
    },
    ...(options.failWorldCreate === true
      ? {
          create: async () => {
            throw failure;
          },
        }
      : {}),
    onStart: async () => {
      events.push("start:world");
      if (options.failWorldStart) {
        throw failure;
      }
    },
    onDrain: async (deadlineMs) => {
      events.push(`drain:world:${deadlineMs}`);
    },
    onDispose: async () => {
      events.push("dispose:world");
    },
  });

  const registry = createModuleRegistry();
  registry.register(storage);
  registry.register(world);
  const assembly = makeAssembly({
    server: {
      bindings: [
        binding("game.world", "game.world.slg-light"),
        binding("platform.storage", "platform.storage.sqlite"),
      ],
    },
  });
  const plan = resolveRealmPlan({ assembly, realm: "server", catalog: registry.snapshot() });
  return {
    plan,
    events,
    failure,
    host: fakeHostServices(),
    scope: { worldId: "world-test", branchId: "branch-test" },
    worldPorts: () => worldPorts,
    createdHost: () => createdHost,
    createdScope: () => createdScope,
    createdSignal: () => createdSignal,
  };
}

describe("实例生命周期", () => {
  it("按拓扑顺序先创建后启动，并向消费方注入提供者 port", async () => {
    const fixture = buildFixture();
    const started = await startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope });
    expect(fixture.events).toEqual(["create:storage", "create:world", "start:storage", "start:world"]);
    expect(fixture.worldPorts()).toEqual({ "platform.storage": storagePort });
    expect(started.instances.map((running) => running.moduleId)).toEqual([
      "platform.storage.sqlite",
      "game.world.slg-light",
    ]);
  });

  it("把调用方的 host、scope 与取消信号传给模块实例", async () => {
    const fixture = buildFixture();
    const controller = new AbortController();
    await startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope, signal: controller.signal });
    expect(fixture.createdHost()).toBe(fixture.host);
    expect(fixture.createdScope()).toBe(fixture.scope);
    expect(fixture.createdSignal()).toBe(controller.signal);
  });

  it("create 失败时逆序释放已创建实例并重抛原错误", async () => {
    const fixture = buildFixture({ failWorldCreate: true });
    let caught: unknown;
    try {
      await startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(fixture.failure);
    expect(fixture.events).toEqual(["create:storage", "create:world", "dispose:storage"]);
  });

  it("start 失败时逆序释放已启动实例并重抛原错误", async () => {
    const fixture = buildFixture({ failWorldStart: true });
    let caught: unknown;
    try {
      await startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(fixture.failure);
    expect(fixture.events).toEqual([
      "create:storage",
      "create:world",
      "start:storage",
      "start:world",
      "dispose:world",
      "dispose:storage",
    ]);
  });

  it("回滚中的 dispose 失败不会覆盖原始错误", async () => {
    const fixture = buildFixture({ failWorldStart: true, disposeThrows: true });
    let caught: unknown;
    try {
      await startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(fixture.failure);
    expect(fixture.events).toContain("dispose:storage");
  });

  it("drain 与 dispose 幂等并按创建逆序执行", async () => {
    const fixture = buildFixture();
    const started = await startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope });
    await started.drain(1000);
    await started.drain(2000);
    expect(fixture.events.slice(4)).toEqual(["drain:world:1000", "drain:storage:1000"]);
    await started.dispose();
    await started.dispose();
    expect(fixture.events.slice(6)).toEqual(["dispose:world", "dispose:storage"]);
  });

  it("many 能力按提供者顺序注入 port 数组", async () => {
    const transportA = fakeModule({
      id: "platform.model-transport.anthropic",
      provides: [capability("platform.model-transport", "many", "deployment")],
      port: { adapter: "anthropic" },
    });
    const transportB = fakeModule({
      id: "platform.model-transport.openai-compatible",
      provides: [capability("platform.model-transport", "many", "deployment")],
      port: { adapter: "openai" },
    });
    let poolPorts: Readonly<Record<string, unknown>> | undefined;
    const pool = fakeModule({
      id: "agent.model-pool.shared",
      provides: [capability("agent.model-pool", "exactly-one", "deployment")],
      requires: [capability("platform.model-transport", "many", "deployment")],
      port: { capability: "agent.model-pool" },
      onCreate: (input) => {
        poolPorts = input.ports;
      },
    });
    const registry = createModuleRegistry();
    registry.register(transportA);
    registry.register(transportB);
    registry.register(pool);
    const assembly = makeAssembly({
      server: {
        bindings: [
          binding("agent.model-pool", "agent.model-pool.shared"),
          binding("platform.model-transport", "platform.model-transport.anthropic"),
          binding("platform.model-transport", "platform.model-transport.openai-compatible"),
        ],
      },
    });
    const plan = resolveRealmPlan({ assembly, realm: "server", catalog: registry.snapshot() });
    await startInstances(plan, { host: fakeHostServices(), scope: {} });
    expect(poolPorts?.["platform.model-transport"]).toEqual([{ adapter: "anthropic" }, { adapter: "openai" }]);
  });

  it("提供者未暴露 port 时拒绝装配并回滚", async () => {
    const fixture = buildFixture({ portlessStorage: true });
    await expectDomainErrorAsync(
      () => startInstances(fixture.plan, { host: fixture.host, scope: fixture.scope }),
      "plugin-failed",
    );
    expect(fixture.events).toEqual(["create:storage", "dispose:storage"]);
  });
});
