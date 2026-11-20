/**
 * 校验装配驱动的模块选择：kernel 解析计划、按计划实例化、公开端口绑定与有效配置。
 * 覆盖三种主装配的完整 server 模块集、测试装配只差装配 ID、模块启动顺序与规则贡献集合、
 * 升级装配替换剧情贡献，以及资源阈值取自模块配置并影响库存等级。
 * 依赖真实模块定义与内容包、临时 SQLite 数据目录、最小假宿主与内存事务；
 * 不启动网络监听，也不经 startHost 组装宿主。
 * 禁止手工构造模块实例、绕过解析计划断言选择结果，或把假宿主行为当成生产宿主行为。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssemblyDescriptor, Json, StoragePort } from "@ai-npc/contracts";
import { startInstances, type ResolvedRealmPlan, type StartedInstances } from "@ai-npc/kernel";
import {
  createServerRuntime,
  filterPlan,
  loadAssembly,
  resolveServerAssembly,
  resolveServerModules,
  serverModuleDefinitions,
} from "@ai-npc/app-server";
import { toGameContent } from "@ai-npc/app-server/content";
import type { GameContent, GameResourcesPort, WorldTx } from "@ai-npc/module-sdk";
import { loadContentPack } from "@ai-npc/experiment";
import { createFakeHost } from "./authority-support";
import { createMemoryTx } from "./game-support";

const host = createFakeHost();
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-assembly-test-"));
  dirs.push(dir);
  return dir;
}

function withResourcesConfig(
  assembly: AssemblyDescriptor,
  config: Readonly<Record<string, Json>>,
): AssemblyDescriptor {
  return {
    ...assembly,
    configs: { ...assembly.configs, resources: { ...config } },
    realms: {
      ...assembly.realms,
      server: {
        ...assembly.realms.server,
        bindings: assembly.realms.server.bindings.map((binding) =>
          binding.capability === "game.resources" ? { ...binding, configRef: "resources" } : binding,
        ),
      },
    },
  };
}

function gameContent(): GameContent {
  return toGameContent(loadContentPack("content", "earth-2964-v1"));
}

/** 按宿主顺序启动：先启动部署级存储并绑定到宿主服务，再启动其余模块并复用其端口。 */
async function startPlan(plan: ResolvedRealmPlan): Promise<{
  readonly started: StartedInstances;
  readonly storageStarted: StartedInstances;
  readonly instances: readonly import("@ai-npc/kernel").RunningInstance[];
}> {
  const storageStarted = await startInstances(
    filterPlan(plan, (moduleId) => moduleId === "platform.storage.sqlite"),
    { host, scope: {} },
  );
  const storage = storageStarted.instances[0]?.port as StoragePort | undefined;
  if (storage === undefined) {
    throw new Error("测试存储实例没有暴露 StoragePort");
  }
  const started = await startInstances(
    filterPlan(plan, (moduleId) => moduleId !== "platform.storage.sqlite"),
    { host, scope: {}, running: storageStarted.instances },
  );
  return { started, storageStarted, instances: [...storageStarted.instances, ...started.instances] };
}

describe("装配驱动的模块选择与启动", () => {
  it("标准、测试与升级装配都能解析出完整 server 模块集", async () => {
    for (const ref of ["local-slg-standard-v1", "local-slg-test-v1", "local-slg-escalating-v1"]) {
      const assembly = loadAssembly(ref);
      const resolved = await resolveServerAssembly(assembly, serverModuleDefinitions);
      expect(resolved.plan.assemblyId).toBe(ref);
      expect(resolved.plan.modules).toHaveLength(14);
      expect(resolved.modules.assemblyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(resolved.modules.capabilities.some((capability) => capability.capability === "game.clock")).toBe(true);
    }
  });

  it("测试装配与标准装配只在装配 ID 不同", async () => {
    const standard = loadAssembly("local-slg-standard-v1");
    const test = loadAssembly("local-slg-test-v1");
    const standardPlan = (await resolveServerAssembly(standard, serverModuleDefinitions)).plan;
    const testPlan = (await resolveServerAssembly(test, serverModuleDefinitions)).plan;
    expect(test.assemblyId).toBe("local-slg-test-v1");
    expect(testPlan.modules.map((module) => module.moduleId)).toEqual(
      standardPlan.modules.map((module) => module.moduleId),
    );
  });

  it("按解析计划实例化模块并按依赖顺序注入公开端口与规则贡献", async () => {
    const assembly = loadAssembly("local-slg-standard-v1");
    const startup = await resolveServerAssembly(assembly, serverModuleDefinitions, {
      configOverrides: { "platform.storage.sqlite": { dataDir: tempDataDir() } },
    });
    const started = await startPlan(startup.plan);
    try {
      expect(started.started.instances.map((instance) => instance.moduleId)).toEqual(
        startup.plan.modules
          .filter((module) => module.moduleId !== "platform.storage.sqlite")
          .map((module) => module.moduleId),
      );
      const runtime = createServerRuntime({
        plan: startup.plan,
        instances: started.instances,
        content: gameContent(),
        host,
      });
      expect(runtime.contributors).toHaveLength(7);
      expect(runtime.contributors.map((contributor) => contributor.moduleId)).toContain("game.scenario.watergate");
      const clockPlan = startup.plan.modules.find((module) => module.moduleId === "game.clock.controlled");
      expect(clockPlan?.config).toMatchObject({ secondsPerTick: 20 });
      expect((await resolveServerModules(assembly, serverModuleDefinitions)).modules).toHaveLength(14);
    } finally {
      await started.started.dispose();
      await started.storageStarted.dispose();
    }
  });

  it("升级装配用升级剧情贡献替换标准剧情", async () => {
    const assembly = loadAssembly("local-slg-escalating-v1");
    const startup = await resolveServerAssembly(assembly, serverModuleDefinitions, {
      configOverrides: { "platform.storage.sqlite": { dataDir: tempDataDir() } },
    });
    const started = await startPlan(startup.plan);
    try {
      const runtime = createServerRuntime({
        plan: startup.plan,
        instances: started.instances,
        content: gameContent(),
        host,
      });
      expect(runtime.contributors.map((contributor) => contributor.moduleId)).toContain(
        "game.scenario.watergate-escalating",
      );
      expect(runtime.contributors.map((contributor) => contributor.moduleId)).not.toContain(
        "game.scenario.watergate",
      );
    } finally {
      await started.started.dispose();
      await started.storageStarted.dispose();
    }
  });

  it("资源阈值取自装配有效配置并影响库存等级判定", async () => {
    const content = gameContent();
    const base = loadAssembly("local-slg-standard-v1");
    const strict = withResourcesConfig(base, { scarceRatio: 0.9, surplusRatio: 1.2 });
    const resolved = await resolveServerAssembly(strict, serverModuleDefinitions);
    const resourcesPlan = filterPlan(resolved.plan, (moduleId) => moduleId === "game.resources.light");
    expect(resourcesPlan.modules).toHaveLength(1);
    expect(resourcesPlan.modules[0]?.config).toEqual({ scarceRatio: 0.9, surplusRatio: 1.2 });

    const started = await startInstances(resourcesPlan, { host, scope: {} });
    try {
      const port = started.instances[0]?.instance.port as {
        bind(txFor: () => WorldTx): GameResourcesPort;
      };
      const tx = createMemoryTx();
      const resources = port.bind(() => tx);
      resources.initializeCampaign(content);
      expect(resources.available("sp-commons", "supply")).toBe(60);
      expect(resources.level("sp-commons").supply).toBe("adequate");
      expect(resources.adjust({ stockpileId: "sp-commons", delta: { supply: -20 }, reason: "test" })).toEqual({ ok: true });
      expect(resources.level("sp-commons").supply).toBe("scarce");
      expect(resources.adjust({ stockpileId: "sp-commons", delta: { supply: 20 }, reason: "test" })).toEqual({ ok: true });
      expect(resources.level("sp-commons").supply).toBe("adequate");
    } finally {
      await started.dispose();
    }
  });
});
