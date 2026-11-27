/**
 * 核心职责：锁定注入给模块的 HostServices 字段全集，防止重新引入未类型化的宿主出口。
 * 交互契约：只依赖 @world-prism/contracts 的公开类型；断言在 `pnpm typecheck` 中求值，运行期无副作用。
 * 约束与禁忌：不得放宽为子集比较；存储与模型必须经 requires 声明的 typed port 获得，不得挂在 HostServices 上。
 */
import { describe, expectTypeOf, it } from "vitest";
import type { HostServices } from "@world-prism/contracts";

describe("HostServices 公开字段", () => {
  it("只包含有精确类型的宿主服务，不含 storage/model 等 unknown 出口", () => {
    // 字段全集相等而非包含：新增任何字段都会让类型检查失败，迫使评审确认它不是绕过 typed port 的后门。
    expectTypeOf<keyof HostServices>().toEqualTypeOf<
      "ids" | "nowIso" | "monotonicMs" | "sleep" | "rng" | "hash" | "hashText" | "logger" | "tracer"
    >();
    expectTypeOf<HostServices>().not.toHaveProperty("storage");
    expectTypeOf<HostServices>().not.toHaveProperty("model");
  });
});
