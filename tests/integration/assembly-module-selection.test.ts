/**
 * 校验装配驱动的模块选择：kernel 解析计划、按计划实例化、公开端口绑定与有效配置。
 * 覆盖三种主装配的完整 server 模块集、标准与测试装配的传输差异、模块启动顺序与规则贡献集合、
 * 升级装配替换剧情贡献，以及资源阈值取自模块配置并影响库存等级。
 * 依赖真实模块定义与内容包、临时 SQLite 数据目录、最小假宿主与内存事务；
 * 不启动网络监听，也不经 startHost 组装宿主。
 * 禁止手工构造模块实例、绕过解析计划断言选择结果，或把假宿主行为当成生产宿主行为。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssemblyDescriptor, Json, StoragePort } from "@world-prism/contracts";
import { startInstances, type ResolvedRealmPlan, type StartedInstances } from "@world-prism/kernel";
import {
  createServerRuntime,
  filterPlan,
  loadAssembly,
  resolveServerAssembly,
  resolveServerModules,
  serverModuleDefinitions,
} from "@world-prism/app-server";
import { toGameContent } from "@world-prism/app-server/content";
import type { GameContent, GameResourcesPort, WorldTx } from "@world-prism/module-sdk";
import { loadContentPack } from "@world-prism/experiment";
import { gameToolsModuleDefinition } from "@world-prism/mod-agent-tools-game-tools";
import { z } from "zod";
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
  const dir = mkdtempSync(join(tmpdir(), "world-prism-assembly-test-"));
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
  readonly instances: readonly import("@world-prism/kernel").RunningInstance[];
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
      expect(resolved.plan.modules).toHaveLength(ref === "local-slg-escalating-v1" ? 17 : ref === "local-slg-test-v1" ? 22 : 23);
      if (ref !== "local-slg-escalating-v1") {
        expect(resolved.plan.agentSlots.decision).toEqual([
          "agent.decision.deterministic",
          "agent.decision.model",
        ]);
        expect(resolved.modules.capabilities.map(({ capability }) => capability))
          .toEqual(expect.arrayContaining(["agent.scheduling", "agent.tools"]));
      }
      expect(resolved.modules.assemblyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(resolved.modules.capabilities.some((capability) => capability.capability === "game.clock")).toBe(true);
    }
  });

  it("标准装配使用真实传输，测试装配使用确定性传输", async () => {
    const standard = loadAssembly("local-slg-standard-v1");
    const test = loadAssembly("local-slg-test-v1");
    const standardPlan = (await resolveServerAssembly(standard, serverModuleDefinitions)).plan;
    const testPlan = (await resolveServerAssembly(test, serverModuleDefinitions)).plan;
    expect(test.assemblyId).toBe("local-slg-test-v1");
    const standardIds = new Set(standardPlan.modules.map(({ moduleId }) => moduleId));
    const testIds = new Set(testPlan.modules.map(({ moduleId }) => moduleId));
    expect([...standardIds].filter((id) => !testIds.has(id)).sort()).toEqual([
      "platform.model-transport.anthropic",
      "platform.model-transport.openai-compatible",
    ]);
    expect([...testIds].filter((id) => !standardIds.has(id)).sort()).toEqual([
      "platform.model-transport.deterministic",
    ]);
    for (const id of ["agent.model-pool.shared", "platform.budget.standard"]) {
      expect(standardIds.has(id)).toBe(true);
      expect(testIds.has(id)).toBe(true);
    }
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
      expect((await resolveServerModules(assembly, serverModuleDefinitions)).modules).toHaveLength(23);
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

  it("agent.tools 换成其他模块时，宿主按能力把内容包工具描述注入新 provider 的配置", async () => {
    const content = loadContentPack("content", "earth-2964-v1");
    // 与共享工具模块契约相同、只换模块 ID 的替代 provider；宿主不应因模块 ID 不同而跳过注入。
    const alternative = {
      ...gameToolsModuleDefinition,
      id: "agent.tools.alternative-tools",
      sourceModuleId: gameToolsModuleDefinition.id,
    };
    const base = loadAssembly("local-slg-standard-v1");
    const swapped: AssemblyDescriptor = {
      ...base,
      realms: {
        ...base.realms,
        server: {
          ...base.realms.server,
          bindings: base.realms.server.bindings.map((binding) =>
            binding.capability === "agent.tools" ? { ...binding, moduleId: alternative.id } : binding,
          ),
        },
      },
    };
    const resolved = await resolveServerAssembly(swapped, [...serverModuleDefinitions, alternative], { content });
    const moduleIds = resolved.plan.modules.map((module) => module.moduleId);
    expect(moduleIds).toContain(alternative.id);
    expect(moduleIds).not.toContain(gameToolsModuleDefinition.id);
    expect(resolved.plan.modules.find((module) => module.moduleId === alternative.id)?.config)
      .toEqual({ toolDescriptions: content.prompts.toolDescriptions });
  });

  it("注入工具描述时保留调用方对工具 provider 的其他配置覆盖，非对象覆盖仍被拒绝", async () => {
    const content = loadContentPack("content", "earth-2964-v1");
    // 替代 provider 除工具描述外还需要一个必填字段，由部署期配置覆盖提供。
    const alternative = {
      ...gameToolsModuleDefinition,
      id: "agent.tools.listing-tools",
      sourceModuleId: gameToolsModuleDefinition.id,
      configSchema: z.object({
        toolDescriptions: z.record(z.string().min(1), z.string().min(1)),
        maxListedTools: z.number().int().positive(),
      }).strict(),
    };
    const base = loadAssembly("local-slg-standard-v1");
    const swapped: AssemblyDescriptor = {
      ...base,
      realms: {
        ...base.realms,
        server: {
          ...base.realms.server,
          bindings: base.realms.server.bindings.map((binding) =>
            binding.capability === "agent.tools" ? { ...binding, moduleId: alternative.id } : binding,
          ),
        },
      },
    };
    const definitions = [...serverModuleDefinitions, alternative];
    const resolved = await resolveServerAssembly(swapped, definitions, {
      content,
      configOverrides: { [alternative.id]: { maxListedTools: 5 } },
    });
    expect(resolved.plan.modules.find((module) => module.moduleId === alternative.id)?.config)
      .toEqual({ toolDescriptions: content.prompts.toolDescriptions, maxListedTools: 5 });
    await expect(resolveServerAssembly(swapped, definitions, {
      content,
      configOverrides: { [alternative.id]: "max-5" },
    })).rejects.toThrow("部署配置覆盖必须是 JSON 对象");
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
