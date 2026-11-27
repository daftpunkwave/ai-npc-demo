/**
 * 校验浏览器会话装配的服务端解析：requiresRemote 必须由同一装配的 server 段绑定满足，模块集下发远端能力描述。
 * 依赖真实组合根目录与仓库装配文件；只做装配解析，不启动模块、不打开存储或监听端口。
 * 禁止手工拼装解析结果，或在远端能力缺失时把断言放宽成只检查抛错。
 */
import { describe, expect, it } from "vitest";
import type { AssemblyDescriptor } from "@world-prism/contracts";
import { allModuleDefinitions, loadAssembly, resolveSessionAssemblies } from "@world-prism/app-server";

/** 去掉 server 段的指定能力绑定，模拟部署换掉或漏装某个远端能力的 provider。 */
function withoutServerCapability(assembly: AssemblyDescriptor, capability: string): AssemblyDescriptor {
  return {
    ...assembly,
    realms: {
      ...assembly.realms,
      server: {
        ...assembly.realms.server,
        bindings: assembly.realms.server.bindings.filter((binding) => binding.capability !== capability),
      },
    },
  };
}

describe("浏览器会话装配的远端能力", () => {
  it("client 与 console 模块集下发 server 段已绑定能力的去重有序清单", async () => {
    const assembly = loadAssembly("local-slg-standard-v1");
    const sessions = await resolveSessionAssemblies(assembly, allModuleDefinitions);
    const expected = [...new Set(assembly.realms.server.bindings.map((binding) => binding.capability))].sort();
    expect(sessions.client.remoteCapabilities).toEqual(expected);
    expect(sessions.console.remoteCapabilities).toEqual(expected);
    expect(expected).toContain("platform.observability");
  });

  it("server 段缺少控制台页面需要的远端能力时以 assembly-incompatible 拒绝并列出全部缺口", async () => {
    const assembly = withoutServerCapability(loadAssembly("local-slg-escalating-v1"), "platform.observability");
    await expect(resolveSessionAssemblies(assembly, allModuleDefinitions)).rejects.toMatchObject({
      code: "assembly-incompatible",
      details: {
        realm: "console",
        modules: [
          { moduleId: "console.health.standard", missing: ["platform.observability"] },
          { moduleId: "console.observability.standard", missing: ["platform.observability"] },
          { moduleId: "console.debug.standard", missing: ["platform.observability"] },
        ],
      },
    });
  });
});
