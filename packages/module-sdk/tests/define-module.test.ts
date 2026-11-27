/**
 * 覆盖 defineModule 对必填字段、realm/能力命名空间、严格配置 schema 与状态迁移一致性的校验。
 * 依赖本包 defineModule 与共享夹具；不加载模块实现、不创建实例，也不访问真实存储或网络。
 * 禁止用宽松断言掩盖错误码变化，或让非法描述符被静默接受。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule } from "../src/index";
import {
  browserModuleDefinition,
  capability,
  createInput,
  expectDomainError,
  moduleDefinition,
} from "./support";

describe("defineModule", () => {
  it("合法服务端描述符原样返回", () => {
    const definition = moduleDefinition();
    expect(defineModule(definition)).toBe(definition);
  });

  it("合法浏览器描述符原样返回", () => {
    const definition = browserModuleDefinition({
      requiresRemote: ["game.world"],
      contributions: [{ extensionId: "hud.standard", slot: "hud", order: 10 }],
    });
    expect(defineModule(definition)).toBe(definition);
  });

  it("有状态模块的连续迁移链通过", () => {
    const definition = moduleDefinition({
      stateSchemaVersion: 3,
      migrationPaths: [
        { fromVersion: 1, toVersion: 2, migrate: (state: unknown) => state },
        { fromVersion: 2, toVersion: 3, migrate: (state: unknown) => state },
      ],
    });
    expect(defineModule(definition)).toBe(definition);
  });

  it("缺少 id 时报错", () => {
    expectDomainError(() => defineModule(moduleDefinition({ id: undefined })), "assembly-incompatible");
  });

  it("非法 id 格式时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ id: "Game.Clock.Controlled" })),
      "assembly-incompatible",
    );
  });

  it("模块 ID 与 realm 命名空间不一致时报错", () => {
    const error = expectDomainError(
      () => defineModule(moduleDefinition({ realm: "server", id: "client.hud.standard" })),
      "realm-violation",
    );
    expect(error.details).toMatchObject({ field: "id" });
  });

  it("非法 realm 时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ realm: "worker" })),
      "assembly-incompatible",
    );
  });

  it("非法 kind 与 instanceScope 时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ kind: "plugin" })),
      "assembly-incompatible",
    );
    expectDomainError(
      () => defineModule(moduleDefinition({ instanceScope: "global" })),
      "assembly-incompatible",
    );
  });

  it("version 或 apiVersion 为空时报错", () => {
    expectDomainError(() => defineModule(moduleDefinition({ version: "  " })), "assembly-incompatible");
    expectDomainError(
      () => defineModule(moduleDefinition({ apiVersion: 42 })),
      "assembly-incompatible",
    );
  });

  it("服务端模块声明 requiresRemote 时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ requiresRemote: ["game.world"] })),
      "realm-violation",
    );
  });

  it("浏览器模块的本地 requires 混入服务端能力时报错", () => {
    const error = expectDomainError(
      () =>
        defineModule(
          browserModuleDefinition({
            requires: [capability("game.world", "exactly-one", "run")],
          }),
        ),
      "realm-violation",
    );
    expect(error.details).toMatchObject({ field: "requires" });
  });

  it("浏览器模块的 requiresRemote 混入本 realm 能力时报错", () => {
    expectDomainError(
      () => defineModule(browserModuleDefinition({ requiresRemote: ["client.world-view"] })),
      "realm-violation",
    );
  });

  it("能力引用重复时报错", () => {
    expectDomainError(
      () =>
        defineModule(
          moduleDefinition({
            provides: [
              capability("game.clock", "exactly-one", "run"),
              capability("game.clock", "many", "run"),
            ],
          }),
        ),
      "assembly-incompatible",
    );
  });

  it("能力引用不符合契约形状时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ requires: [{ capability: "game.map" }] })),
      "assembly-incompatible",
    );
  });

  it("能力 ID 不符合 <group>.<family> 语法时报错", () => {
    for (const invalid of ["game.", "game.WORLD", "agent.memory.extra", "game.world x"]) {
      const error = expectDomainError(
        () =>
          defineModule(
            moduleDefinition({
              provides: [{ capability: invalid, cardinality: "exactly-one", instanceScope: "run" }],
            }),
          ),
        "assembly-incompatible",
      );
      expect(error.details).toMatchObject({ field: "provides" });
    }
  });

  it("configSchema 非严格对象时报错", () => {
    const error = expectDomainError(
      () => defineModule(moduleDefinition({ configSchema: z.object({ enabled: z.boolean() }) })),
      "assembly-incompatible",
    );
    expect(error.details).toMatchObject({ field: "configSchema" });
  });

  it("configSchema 不是对象 schema 时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ configSchema: z.string() })),
      "assembly-incompatible",
    );
  });

  it("无状态模块声明迁移路径时报错", () => {
    expectDomainError(
      () =>
        defineModule(
          moduleDefinition({
            stateSchemaVersion: null,
            migrationPaths: [{ fromVersion: 1, toVersion: 2, migrate: (state: unknown) => state }],
          }),
        ),
      "assembly-incompatible",
    );
  });

  it("有状态模块缺少迁移链时报错", () => {
    const error = expectDomainError(
      () => defineModule(moduleDefinition({ stateSchemaVersion: 2, migrationPaths: [] })),
      "assembly-incompatible",
    );
    expect(error.details).toMatchObject({ field: "migrationPaths" });
  });

  it("迁移路径跳跃或倒序时报错", () => {
    expectDomainError(
      () =>
        defineModule(
          moduleDefinition({
            stateSchemaVersion: 2,
            migrationPaths: [{ fromVersion: 2, toVersion: 1, migrate: (state: unknown) => state }],
          }),
        ),
      "assembly-incompatible",
    );
    expectDomainError(
      () =>
        defineModule(
          moduleDefinition({
            stateSchemaVersion: 2,
            migrationPaths: [{ fromVersion: 1, toVersion: 3, migrate: (state: unknown) => state }],
          }),
        ),
      "assembly-incompatible",
    );
  });

  it("迁移路径不参与版本链时报错", () => {
    expectDomainError(
      () =>
        defineModule(
          moduleDefinition({
            stateSchemaVersion: 3,
            migrationPaths: [
              { fromVersion: 1, toVersion: 3, migrate: (state: unknown) => state },
              { fromVersion: 2, toVersion: 3, migrate: (state: unknown) => state },
            ],
          }),
        ),
      "assembly-incompatible",
    );
  });

  it("create 不是函数时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ create: "not-a-factory" })),
      "assembly-incompatible",
    );
  });

  it("defaults 不是 JSON 对象时报错", () => {
    expectDomainError(
      () => defineModule(moduleDefinition({ defaults: ["not", "object"] })),
      "assembly-incompatible",
    );
  });

  it("浏览器模块声明 ownsAggregates 时报错", () => {
    expectDomainError(
      () => defineModule(browserModuleDefinition({ ownsAggregates: ["character"] })),
      "realm-violation",
    );
  });

  it("contributions 重复扩展 ID 时报错", () => {
    expectDomainError(
      () =>
        defineModule(
          browserModuleDefinition({
            contributions: [
              { extensionId: "hud.standard", slot: "hud", order: 1 },
              { extensionId: "hud.standard", slot: "hud", order: 2 },
            ],
          }),
        ),
      "assembly-incompatible",
    );
  });

  it("保留 create 的具体返回类型并产出实例", async () => {
    interface CustomInstance {
      readonly moduleId: string;
      start(signal: AbortSignal): Promise<void>;
      drain(deadlineMs: number): Promise<void>;
      dispose(): Promise<void>;
      readonly port: { readonly ping: () => string };
    }
    const definition = moduleDefinition({
      create: async (input: { readonly moduleId: string }): Promise<CustomInstance> => ({
        moduleId: input.moduleId,
        start: async () => undefined,
        drain: async () => undefined,
        dispose: async () => undefined,
        port: { ping: () => "pong" },
      }),
    });
    const instance = await defineModule(definition).create(createInput());
    expect(instance.moduleId).toBe("platform.sdk-fixture.standard");
    expect((instance as CustomInstance).port.ping()).toBe("pong");
  });
});
