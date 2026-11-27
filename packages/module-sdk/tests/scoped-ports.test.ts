/**
 * 覆盖 scoped 状态作用域辅助函数：从模块定义与创建输入构造不可变作用域，并拒绝无状态或错配输入。
 * 依赖本包 createScopedStateKey 与共享夹具；不读写真实存储，也不创建模块实例。
 * 禁止让作用域静默接受缺失世界/分支标识或跨 realm 定义。
 */
import { describe, expect, it } from "vitest";
import { createScopedStateKey } from "../src/index";
import { createInput, expectDomainError, moduleDefinition } from "./support";

const statefulDefinition = moduleDefinition({
  stateSchemaVersion: 2,
  migrationPaths: [{ fromVersion: 1, toVersion: 2, migrate: (state: unknown) => state }],
});

describe("createScopedStateKey", () => {
  it("按世界、分支、模块与状态版本构造作用域", () => {
    const key = createScopedStateKey(statefulDefinition, createInput());
    expect(key).toEqual({
      worldId: "wld-000000000000",
      branchId: "br-000000000000",
      agentId: null,
      moduleId: "platform.sdk-fixture.standard",
      stateSchemaVersion: 2,
    });
  });

  it("带主体作用域时保留 agentId", () => {
    const key = createScopedStateKey(
      statefulDefinition,
      createInput({
        scope: {
          worldId: "wld-000000000000",
          branchId: "br-000000000000",
          agentId: "agent-000000000000",
        },
      }),
    );
    expect(key.agentId).toBe("agent-000000000000");
  });

  it("返回冻结对象，模块不能就地改写作用域", () => {
    const key = createScopedStateKey(statefulDefinition, createInput());
    expect(Object.isFrozen(key)).toBe(true);
  });

  it("无状态模块不能创建作用域", () => {
    expectDomainError(
      () => createScopedStateKey(moduleDefinition(), createInput()),
      "assembly-incompatible",
    );
  });

  it("模块 ID 不一致时报错", () => {
    expectDomainError(
      () => createScopedStateKey(statefulDefinition, createInput({ moduleId: "platform.sdk-fixture.other" })),
      "assembly-incompatible",
    );
  });

  it("realm 不一致时报错", () => {
    expectDomainError(
      () => createScopedStateKey(statefulDefinition, createInput({ realm: "client" })),
      "realm-violation",
    );
  });

  it("缺少 worldId 或 branchId 时报错", () => {
    expectDomainError(
      () => createScopedStateKey(statefulDefinition, createInput({ scope: {} })),
      "assembly-incompatible",
    );
    expectDomainError(
      () =>
        createScopedStateKey(
          statefulDefinition,
          createInput({ scope: { worldId: "wld-000000000000" } }),
        ),
      "assembly-incompatible",
    );
  });
});
