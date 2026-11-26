/**
 * 验证创建 run 的 HTTP 入口与配置文件加载共用同一套 RunSpec 结构约束。
 * 依赖真实仓库配置；只读配置，不打开存储或启动模块。
 * 禁止为 HTTP 入口放宽断言，也禁止让两套 schema 各自演化出不同结论。
 */
import { describe, expect, it } from "vitest";
import { loadRunSpec, runSpecSchema } from "@world-prism/experiment";

const loadContext = { configDir: "config" };

describe("RunSpec 结构约束在文件与 HTTP 入口一致", () => {
  it("HTTP 入口使用的 schema 与文件加载相同，都拒绝未声明字段", () => {
    const valid = loadRunSpec("online-default", loadContext, { seed: "run-seed-1" }).value;

    // 文件加载会拒绝的额外字段，HTTP 入口经同一 schema 也必须拒绝。
    expect(runSpecSchema.safeParse({ ...valid, unexpectedKey: "value" }).success).toBe(false);
    expect(runSpecSchema.safeParse(null).success).toBe(false);
    expect(runSpecSchema.safeParse("text").success).toBe(false);
    expect(runSpecSchema.safeParse([]).success).toBe(false);
    // 合法规格仍通过，说明拒绝来自字段形状而不是 schema 过严。
    expect(runSpecSchema.safeParse(valid).success).toBe(true);
  });

  it("未实现取值在结构校验阶段就被拒绝，不会进入后续交叉检查", () => {
    const valid = loadRunSpec("online-default", loadContext, { seed: "run-seed-1" }).value;
    expect(runSpecSchema.safeParse({ ...valid, mode: "audit" }).success).toBe(false);
    expect(runSpecSchema.safeParse({
      ...valid,
      initialState: { kind: "snapshot", snapshotRef: "some-snapshot" },
    }).success).toBe(false);
  });
});
