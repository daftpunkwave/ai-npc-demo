/**
 * 验证浏览器宿主用装配下发配置启动模块，而不是模块自带的 defaults。
 * 依赖 client-sdk 的模块启动入口与公共契约的装配描述；不创建真实网络或浏览器实例。
 * 禁止用 defaults 静默替代装配配置，也禁止把 schema 失败降级成原始 ZodError。
 */
import { describe, expect, it } from "vitest";
import type { ModuleCreateInput, ModuleDefinition, ModuleInstance, ResolvedModuleSet } from "@ai-npc/contracts";
import { z } from "zod";
import { startBrowserModules } from "../src/index";

/** 带非默认配置的浏览器模块：defaults 与服务端下发的配置明显不同，便于断言实际生效的是哪一份。 */
function cameraModule(received: Json[]): ModuleDefinition {
  const configSchema = z
    .strictObject({ zoom: z.number().min(0.5).max(4), label: z.string().min(1).default("默认视角") });
  return {
    id: "client.camera.standard",
    realm: "client",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "session",
    provides: [{ capability: "client.camera" as never, cardinality: "exactly-one", instanceScope: "session" }],
    requires: [],
    requiresRemote: [],
    configSchema,
    defaults: { zoom: 1 },
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async (input: ModuleCreateInput): Promise<ModuleInstance> => {
      received.push(input.config);
      return {
        moduleId: input.moduleId,
        start: async () => undefined,
        drain: async () => undefined,
        dispose: async () => undefined,
      };
    },
  };
}

type Json = import("@ai-npc/contracts").Json;

function resolvedWith(config: Json): ResolvedModuleSet {
  return {
    realm: "client",
    protocolVersion: "1",
    modules: [
      { moduleId: "client.camera.standard", version: "1.0.0", apiVersion: "1", configHash: "hash-camera", config },
    ],
    capabilities: [],
    assemblyHash: "hash",
  };
}

describe("浏览器模块按装配配置启动", () => {
  it("模块收到装配下发的配置而不是 defaults", async () => {
    const received: Json[] = [];
    const definition = cameraModule(received);
    const started = await startBrowserModules({
      definitions: [definition],
      resolved: resolvedWith({ zoom: 2.5 }),
    });
    try {
      // 缺省字段由 configSchema 补默认值；显式字段必须来自装配而不是 defaults 的 zoom: 1。
      expect(received).toEqual([{ zoom: 2.5, label: "默认视角" }]);
    } finally {
      await started.dispose();
    }
  });

  it("装配配置未通过 configSchema 时报 assembly-incompatible 并带模块定位", async () => {
    const received: Json[] = [];
    const definition = cameraModule(received);
    await expect(
      startBrowserModules({ definitions: [definition], resolved: resolvedWith({ zoom: 99 }) }),
    ).rejects.toMatchObject({
      code: "assembly-incompatible",
      details: {
        moduleId: "client.camera.standard",
        issues: [expect.objectContaining({ path: "zoom" })],
      },
    });
    // 配置校验失败必须在创建实例之前发生，不能先按错误配置启动再回滚。
    expect(received).toEqual([]);
  });

  it("未进入装配计划的定义不会被启动，也不会因缺少配置而中断", async () => {
    const received: Json[] = [];
    const definition = cameraModule(received);
    const started = await startBrowserModules({
      definitions: [definition],
      resolved: { realm: "client", protocolVersion: "1", modules: [], capabilities: [], assemblyHash: "hash" },
    });
    try {
      // 只启动装配选中的模块：未选中即不创建实例，也不读配置。
      expect(received).toEqual([]);
      expect(started.instances).toEqual([]);
    } finally {
      await started.dispose();
    }
  });
});
describe("配置的 transform 不重复生效", () => {
  it("模块拿到的是服务端已转换的值，不是客户端再转换一次的结果", async () => {
    const received: Json[] = [];
    const definition: ModuleDefinition = {
      ...cameraModule(received),
      // 服务端已执行过一次 transform 并把结果下发（delivered 为 2）；
      // 若客户端把再次解析的输出交给模块，模块会收到 3，与服务端冻结结果不一致。
      configSchema: z.strictObject({
        zoom: z.number().min(0.5).max(4),
        delivered: z.number().int().transform((value) => value + 1),
      }),
    };
    const started = await startBrowserModules({
      definitions: [definition],
      resolved: resolvedWith({ zoom: 2, delivered: 2 }),
    });
    try {
      expect(received).toEqual([{ zoom: 2, delivered: 2 }]);
    } finally {
      await started.dispose();
    }
  });
});