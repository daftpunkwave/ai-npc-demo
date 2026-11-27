/**
 * 验证浏览器宿主在握手装配时拒绝不支持的协议版本，并按下发的远端能力描述复核本地模块的 requiresRemote。
 * 依赖 client-sdk 的模块启动入口、描述符工厂与公共契约的装配描述；不创建真实网络或浏览器实例。
 * 禁止在协议版本不匹配或远端能力缺失时静默继续启动。
 */
import { describe, expect, it } from "vitest";
import type { CapabilityId, Json, ModuleDefinition, ResolvedModuleSet } from "@world-prism/contracts";
import { defineBrowserModuleDefinition, startBrowserModules } from "../src/index";

function resolved(protocolVersion: string): ResolvedModuleSet {
  return {
    realm: "client",
    protocolVersion,
    modules: [],
    capabilities: [],
    assemblyHash: "hash",
  };
}

describe("浏览器装配握手的协议版本", () => {
  it("拒绝服务端不支持的协议版本", async () => {
    await expect(
      startBrowserModules({ definitions: [], resolved: resolved("2") }),
    ).rejects.toMatchObject({
      code: "assembly-incompatible",
    });
  });

  it("协议版本一致时正常启动并可释放", async () => {
    const started = await startBrowserModules({ definitions: [], resolved: resolved("1") });
    expect(started.instances).toEqual([]);
    await started.dispose();
  });
});

/** 带远端依赖的控制台页面模块；created 记录实例创建，用于断言拒绝发生在创建之前。 */
function consolePage(id: string, requiresRemote: readonly string[], created: string[]): ModuleDefinition {
  return defineBrowserModuleDefinition({
    id,
    kind: "contributor",
    provides: id.split(".").slice(0, 2).join("."),
    requiresRemote,
    create: async (input) => {
      created.push(input.moduleId);
      return {
        moduleId: input.moduleId,
        start: async () => undefined,
        drain: async () => undefined,
        dispose: async () => undefined,
      };
    },
  });
}

/** 控制台模块集：每个模块带空配置与其规范摘要，远端能力描述按参数给出或省略。 */
function consoleSet(moduleIds: readonly string[], remoteCapabilities?: readonly string[]): ResolvedModuleSet {
  const emptyConfig: Json = {};
  return {
    realm: "console",
    protocolVersion: "1",
    modules: moduleIds.map((moduleId) => ({
      moduleId,
      version: "1.0.0",
      apiVersion: "1",
      // 空对象规范 JSON 的 SHA-256，与服务端 configHash 的口径一致。
      configHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      config: emptyConfig,
    })),
    capabilities: [],
    ...(remoteCapabilities === undefined
      ? {}
      : { remoteCapabilities: remoteCapabilities.map((capability) => capability as CapabilityId) }),
    assemblyHash: "hash",
  };
}

describe("浏览器握手复核 requiresRemote", () => {
  it("远端能力缺失时以 assembly-incompatible 拒绝并逐模块列出缺失能力，不创建任何实例", async () => {
    const created: string[] = [];
    const definitions = [
      consolePage("console.health.standard", ["platform.observability", "platform.operations"], created),
      consolePage("console.module-admin.standard", ["platform.module-admin"], created),
    ];
    await expect(
      startBrowserModules({
        definitions,
        resolved: consoleSet(
          ["console.health.standard", "console.module-admin.standard"],
          ["platform.module-admin", "platform.observability"],
        ),
      }),
    ).rejects.toMatchObject({
      code: "assembly-incompatible",
      details: {
        realm: "console",
        modules: [{ moduleId: "console.health.standard", missing: ["platform.operations"] }],
      },
    });
    expect(created).toEqual([]);
  });

  it("远端能力全部由服务端绑定时正常启动", async () => {
    const created: string[] = [];
    const started = await startBrowserModules({
      definitions: [consolePage("console.observability.standard", ["platform.observability"], created)],
      resolved: consoleSet(["console.observability.standard"], ["platform.observability", "platform.operations"]),
    });
    try {
      expect(created).toEqual(["console.observability.standard"]);
    } finally {
      await started.dispose();
    }
  });

  it("载荷没有远端能力描述时，声明了远端依赖的模块按缺失全部能力拒绝", async () => {
    const created: string[] = [];
    await expect(
      startBrowserModules({
        definitions: [consolePage("console.observability.standard", ["platform.observability"], created)],
        resolved: consoleSet(["console.observability.standard"]),
      }),
    ).rejects.toMatchObject({
      code: "assembly-incompatible",
      details: {
        modules: [{ moduleId: "console.observability.standard", missing: ["platform.observability"] }],
      },
    });
    expect(created).toEqual([]);
  });

  it("未进入装配的模块即使远端依赖缺失也不参与比对", async () => {
    const created: string[] = [];
    const started = await startBrowserModules({
      definitions: [
        consolePage("console.observability.standard", ["platform.observability"], created),
        consolePage("console.evaluation.standard", ["platform.evaluation"], created),
      ],
      resolved: consoleSet(["console.observability.standard"], ["platform.observability"]),
    });
    try {
      expect(created).toEqual(["console.observability.standard"]);
    } finally {
      await started.dispose();
    }
  });
});
