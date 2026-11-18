/**
 * 验证实例级模块注册表的注册、精确反注册、目录快照与重复登记拒绝。
 * 依赖 kernel 的 createModuleRegistry 与最小假模块，不使用全局状态或真实模块。
 * 禁止依赖注册顺序推导快照顺序，或接受未声明的重复 id@version。
 */
import { describe, expect, it } from "vitest";
import { createModuleRegistry } from "../src/index";
import { detailsText, expectDomainError, fakeModule } from "./support";

const clockDefinition = fakeModule({ id: "game.clock.controlled" });
const clockUpgrade = fakeModule({ id: "game.clock.controlled", version: "2.0.0" });
const storageDefinition = fakeModule({ id: "platform.storage.sqlite" });

describe("模块注册表", () => {
  it("每个注册表实例相互独立", () => {
    const first = createModuleRegistry();
    const second = createModuleRegistry();
    first.register(clockDefinition);
    expect(first.get("game.clock.controlled", "1.0.0")).not.toBeNull();
    expect(second.get("game.clock.controlled", "1.0.0")).toBeNull();
    second.register(clockDefinition);
    expect(second.snapshot().length).toBe(1);
  });

  it("反注册函数只移除本次注册，且重复调用安全", () => {
    const registry = createModuleRegistry();
    const disposeClock = registry.register(clockDefinition);
    registry.register(storageDefinition);
    disposeClock();
    disposeClock();
    expect(registry.snapshot().map((definition) => definition.id)).toEqual(["platform.storage.sqlite"]);
    expect(registry.get("game.clock.controlled", "1.0.0")).toBeNull();
  });

  it("旧反注册函数不会误删后来重注册的同一条目", () => {
    const registry = createModuleRegistry();
    const disposeOld = registry.register(clockDefinition);
    disposeOld();
    registry.register(clockDefinition);
    disposeOld();
    expect(registry.get("game.clock.controlled", "1.0.0")).not.toBeNull();
  });

  it("同 id@version 重复注册报错", () => {
    const registry = createModuleRegistry();
    registry.register(clockDefinition);
    const error = expectDomainError(() => registry.register(fakeModule({ id: "game.clock.controlled" })), "plugin-failed");
    expect(detailsText(error)).toContain("game.clock.controlled");
  });

  it("同 id 不同 version 可并存并按版本排序", () => {
    const registry = createModuleRegistry();
    registry.register(clockUpgrade);
    registry.register(clockDefinition);
    expect(registry.findById("game.clock.controlled").map((definition) => definition.version)).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
    expect(registry.snapshot().map((definition) => definition.version)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("快照按 id 与版本排序、数组被冻结且不反映后续变更", () => {
    const registry = createModuleRegistry();
    registry.register(storageDefinition);
    const before = registry.snapshot();
    expect(Object.isFrozen(before)).toBe(true);
    registry.register(clockDefinition);
    expect(before.map((definition) => definition.id)).toEqual(["platform.storage.sqlite"]);
    expect(registry.snapshot().map((definition) => definition.id)).toEqual([
      "game.clock.controlled",
      "platform.storage.sqlite",
    ]);
  });
});
