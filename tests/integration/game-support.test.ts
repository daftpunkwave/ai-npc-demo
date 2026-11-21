/**
 * 验证集成测试公共 harness 的释放契约：单个释放失败仍释放全部资源，并汇总为 AggregateError。
 * 依赖 game-support 的 disposeTrackedGameHarnesses 与 vitest；不使用真实 SQLite 或宿主。
 * 禁止在这里放宽断言，或让失败释放被静默吞掉。
 */
import { describe, expect, it } from "vitest";
import { disposeTrackedGameHarnesses } from "./game-support";
import type { GameHarness } from "./game-support";

function failingHarness(released: string[], name: string, fails: boolean): GameHarness {
  return {
    dispose: async () => {
      released.push(name);
      if (fails) {
        throw new Error(`释放失败：${name}`);
      }
    },
  } as unknown as GameHarness;
}

describe("游戏测试环境释放", () => {
  it("单个 harness 释放失败时仍释放全部，并汇总抛出 AggregateError", async () => {
    const released: string[] = [];
    const active = [
      failingHarness(released, "first", true),
      failingHarness(released, "second", false),
      failingHarness(released, "third", true),
    ];
    let caught: unknown;
    try {
      await disposeTrackedGameHarnesses(active);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(released).toEqual(["first", "second", "third"]);
    expect(active).toHaveLength(0);
    expect((caught as AggregateError).errors).toHaveLength(2);
  });
});
