/**
 * 校验装配驱动模块选择与已解析模块集；不启动服务端。
 */
import { describe, expect, it } from "vitest";
import {
  createGameContributorsFromAssembly,
  loadAssembly,
  resolveServerModules,
  serverModuleDefinitions,
} from "@ai-npc/app-server";
import type { AssemblyDescriptor } from "@ai-npc/contracts";

function withScenario(assembly: AssemblyDescriptor, moduleId: string): AssemblyDescriptor {
  return {
    ...assembly,
    realms: {
      ...assembly.realms,
      server: {
        ...assembly.realms.server,
        bindings: assembly.realms.server.bindings.map((binding) =>
          binding.capability === "game.scenario" ? { ...binding, moduleId } : binding,
        ),
      },
    },
  };
}

describe("装配驱动模块选择", () => {
  it("标准与升级装配都能生成规则贡献", () => {
    expect(createGameContributorsFromAssembly(loadAssembly("local-slg-standard-v1"))).toHaveLength(7);
    expect(createGameContributorsFromAssembly(loadAssembly("local-slg-escalating-v1"))).toHaveLength(7);
  });

  it("拒绝未实现的游戏模块绑定", () => {
    const assembly = withScenario(loadAssembly("local-slg-standard-v1"), "game.scenario.unknown");
    expect(() => createGameContributorsFromAssembly(assembly)).toThrow("未实现");
  });

  it("已解析模块集按配置内容生成稳定哈希", async () => {
    const assembly = loadAssembly("local-slg-standard-v1");
    const first = await resolveServerModules(assembly, serverModuleDefinitions);
    const second = await resolveServerModules(assembly, serverModuleDefinitions);
    expect(first).toEqual(second);
    expect(first.capabilities.length).toBeGreaterThan(0);
    expect(first.modules.every((module) => module.configHash.length === 64)).toBe(true);
    expect(first.assemblyHash).not.toBe(assembly.assemblyId);
    expect(first.assemblyHash.length).toBe(64);
  });
});
