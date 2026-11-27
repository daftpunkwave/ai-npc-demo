/**
 * 覆盖浏览器模块描述符工厂：realm 推导、能力引用、空配置、非法模块前缀，以及与服务端共用的字段级校验。
 * 依赖本包定义辅助、公共模块契约与 zod；不加载具体插件实现或浏览器 API。
 * 禁止用宽松默认值掩盖非法模块 ID、realm 或配置 schema。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyModuleConfigSchema } from "@world-prism/contracts";
import { defineBrowserModule, defineBrowserModuleDefinition } from "../src/define-browser-module";
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

describe("浏览器描述符与服务端共用同一份校验", () => {
  it("本地 requires 混入服务端能力时在定义期按 realm 命名空间拒绝", () => {
    const error = expectDomainError(
      () =>
        defineBrowserModuleDefinition({
          id: "console.health.standard",
          kind: "contributor",
          provides: "console.health",
          requires: ["platform.observability"],
          create: async () => createModule(),
        }),
      "realm-violation",
    );
    expect(error.details).toMatchObject({ moduleId: "console.health.standard", field: "requires" });
  });

  it("requiresRemote 指向本 realm 能力时拒绝", () => {
    const error = expectDomainError(
      () =>
        defineBrowserModuleDefinition({
          id: "client.hud.standard",
          kind: "contributor",
          provides: "client.hud",
          requiresRemote: ["client.world-view"],
          create: async () => createModule(),
        }),
      "realm-violation",
    );
    expect(error.details).toMatchObject({ moduleId: "client.hud.standard", field: "requiresRemote" });
  });

  it("同一 slot 重复扩展 ID 的贡献被拒绝", () => {
    const page = { extensionId: "console.health.standard.page", slot: "console.page", order: 10 };
    const error = expectDomainError(
      () =>
        defineBrowserModuleDefinition({
          id: "console.health.standard",
          kind: "contributor",
          provides: "console.health",
          contributions: [page, { ...page, order: 20 }],
          create: async () => createModule(),
        }),
      "assembly-incompatible",
    );
    expect(error.details).toMatchObject({ moduleId: "console.health.standard", field: "contributions" });
  });

  it("非严格的 configSchema 被拒绝", () => {
    const error = expectDomainError(
      () =>
        defineBrowserModuleDefinition({
          id: "client.camera.standard",
          kind: "service",
          provides: "client.camera",
          configSchema: z.object({ zoom: z.number() }),
          create: async () => createModule(),
        }),
      "assembly-incompatible",
    );
    expect(error.details).toMatchObject({ moduleId: "client.camera.standard", field: "configSchema" });
  });

  it("defineBrowserModule 拒绝服务端 realm 的完整描述符", () => {
    const serverDefinition = {
      ...defineBrowserModuleDefinition({
        id: "client.camera.standard",
        kind: "service",
        provides: "client.camera",
        create: async () => createModule(),
      }),
      id: "platform.camera.standard",
      realm: "server" as const,
      provides: [],
    };
    const error = expectDomainError(() => defineBrowserModule(serverDefinition), "realm-violation");
    expect(error.details).toEqual({ moduleId: "platform.camera.standard", realm: "server" });
  });
});
