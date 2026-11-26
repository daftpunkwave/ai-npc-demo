/**
 * 覆盖浏览器模块描述符工厂：realm 推导、能力引用、空配置与非法模块前缀。
 * 依赖本包定义辅助与公共模块契约；不加载具体插件实现或浏览器 API。
 * 禁止用宽松默认值掩盖非法模块 ID、realm 或配置 schema。
 */
import { describe, expect, it } from "vitest";
import { emptyModuleConfigSchema } from "@world-prism/contracts";
import { defineBrowserModuleDefinition } from "../src/define-browser-module";
import { expectDomainError } from "./support";

function createModule() {
  return {
    moduleId: "client.camera.standard",
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port: {},
  };
}

describe("defineBrowserModuleDefinition", () => {
  it("从模块 ID 推导 realm 并构造会话能力引用", () => {
    const definition = defineBrowserModuleDefinition({
      id: "client.camera.standard",
      kind: "service",
      provides: "client.camera",
      requires: ["client.world-view"],
      create: async () => createModule(),
    });

    expect(definition).toMatchObject({
      id: "client.camera.standard",
      realm: "client",
      kind: "service",
      version: "1.0.0",
      apiVersion: "1",
      instanceScope: "session",
      configSchema: emptyModuleConfigSchema,
      defaults: {},
      stateSchemaVersion: null,
      migrationPaths: [],
    });
    expect(definition.provides).toEqual([
      {
        capability: "client.camera",
        cardinality: "exactly-one",
        instanceScope: "session",
      },
    ]);
    expect(definition.requires).toEqual([
      {
        capability: "client.world-view",
        cardinality: "exactly-one",
        instanceScope: "session",
      },
    ]);
  });

  it("推导控制台 realm 并保留页面贡献的角色范围", () => {
    const definition = defineBrowserModuleDefinition({
      id: "console.health.standard",
      kind: "contributor",
      provides: "console.health",
      requiresRemote: ["platform.observability"],
      contributions: [
        {
          extensionId: "console.health.standard.page",
          slot: "console.page",
          order: 10,
          allowedRoles: ["operator"],
        },
      ],
      create: async () => createModule(),
    });

    expect(definition.realm).toBe("console");
    expect(definition.requiresRemote).toEqual(["platform.observability"]);
    expect(definition.contributions).toHaveLength(1);
  });

  it("拒绝不属于浏览器 realm 的模块 ID", () => {
    expectDomainError(
      () =>
        defineBrowserModuleDefinition({
          id: "platform.module-admin.standard",
          kind: "service",
          provides: "platform.module-admin",
          create: async () => createModule(),
        }),
      "realm-violation",
    );
  });

  it("拒绝结构非法的模块 ID", () => {
    expectDomainError(
      () =>
        defineBrowserModuleDefinition({
          id: "camera",
          kind: "service",
          provides: "client.camera",
          create: async () => createModule(),
        }),
      "assembly-incompatible",
    );
  });
});
