/**
 * 验证模块配置的严格校验、默认值填充、schema 对自身输出幂等与错误定位。
 * 依赖 kernel 的 resolveModuleConfig、zod 严格 schema 与最小假模块。
 * 禁止使用真实模块配置或放宽未知键与类型检查。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveModuleConfig } from "../src/index";
import { detailsText, expectDomainError, fakeModule } from "./support";

const clockSchema = z.strictObject({
  secondsPerTick: z.number().int().positive().default(10),
  maxStepTicks: z.number().int().positive().default(24),
});

const clockDefinition = fakeModule({
  id: "game.clock.controlled",
  configSchema: clockSchema,
});

describe("模块配置解析", () => {
  it("按 schema 填入默认值", () => {
    expect(resolveModuleConfig(clockDefinition, {})).toEqual({ secondsPerTick: 10, maxStepTicks: 24 });
  });

  it("合并模块 defaults 且装配配置优先", () => {
    const definition = fakeModule({
      id: "game.clock.controlled",
      configSchema: clockSchema,
      defaults: { secondsPerTick: 5 },
    });
    expect(resolveModuleConfig(definition, { maxStepTicks: 8 })).toEqual({
      secondsPerTick: 5,
      maxStepTicks: 8,
    });
    expect(resolveModuleConfig(definition, { secondsPerTick: 30 })).toEqual({
      secondsPerTick: 30,
      maxStepTicks: 24,
    });
  });

  it("未提供配置时等同于空对象", () => {
    expect(resolveModuleConfig(clockDefinition, undefined)).toEqual({ secondsPerTick: 10, maxStepTicks: 24 });
  });

  it("配置块为 null 时按 schema 拒绝而不是当作空对象", () => {
    expectDomainError(() => resolveModuleConfig(clockDefinition, null), "assembly-incompatible");
  });

  it("未知键被拒绝并带模块 ID 与原因", () => {
    const error = expectDomainError(
      () => resolveModuleConfig(clockDefinition, { secondsPerTick: 10, unexpected: true }, "clock"),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("game.clock.controlled");
    expect(error.safeMessage).toContain("unexpected");
    expect(detailsText(error)).toContain("clock");
  });

  it("类型不符被拒绝", () => {
    expectDomainError(
      () => resolveModuleConfig(clockDefinition, { secondsPerTick: "10" }),
      "assembly-incompatible",
    );
  });

  it("缺少必填配置被拒绝", () => {
    const required = fakeModule({
      id: "game.map.six-nodes",
      configSchema: z.strictObject({ mapRef: z.string().min(1) }),
    });
    expectDomainError(() => resolveModuleConfig(required, {}), "assembly-incompatible");
  });

  it("defaults 不是 JSON 对象时报错", () => {
    const definition = fakeModule({ id: "game.resources.light", defaults: 42 });
    expectDomainError(() => resolveModuleConfig(definition, {}), "assembly-incompatible");
  });

  it("schema 输出不是 JSON 值时拒绝", () => {
    const definition = fakeModule({
      id: "game.world.slg-light",
      configSchema: z.strictObject({ startedAt: z.date() }),
    });
    expectDomainError(() => resolveModuleConfig(definition, { startedAt: new Date(0) }), "assembly-incompatible");
  });
});

describe("configSchema 对自身输出幂等", () => {
  it("改变类型的 transform 让解析输出无法再次通过 schema，解析阶段即拒绝并指向 schema", () => {
    const definition = fakeModule({
      id: "transport.http-ws.fastify",
      configSchema: z.strictObject({ port: z.string().transform(Number) }),
    });
    const error = expectDomainError(() => resolveModuleConfig(definition, { port: "8080" }, "transport"), "assembly-incompatible");
    expect(error.details).toMatchObject({
      moduleId: "transport.http-ws.fastify",
      configRef: "transport",
      reason: "config-not-idempotent",
      issues: [expect.stringContaining("再次解析失败：port")],
    });
    expect(error.safeMessage).toContain("对自身输出不幂等");
  });

  it("不可重入的 transform 再次解析得到不同的值时拒绝", () => {
    const definition = fakeModule({
      id: "game.clock.controlled",
      configSchema: z.strictObject({ secondsPerTick: z.number().int().transform((value) => value + 1) }),
    });
    const error = expectDomainError(() => resolveModuleConfig(definition, { secondsPerTick: 10 }), "assembly-incompatible");
    expect(error.details).toMatchObject({
      reason: "config-not-idempotent",
      issues: ["再次解析得到的配置与首次解析输出不同"],
    });
  });

  it("可重入的 transform 与 schema 默认值对自身输出幂等，照常解析", () => {
    const definition = fakeModule({
      id: "client.hud.standard",
      realm: "client",
      configSchema: z.strictObject({
        title: z.string().transform((value) => value.trim()),
        tags: z.array(z.string()).default([]),
      }),
    });
    expect(resolveModuleConfig(definition, { title: "  灰港  " })).toEqual({ title: "灰港", tags: [] });
  });
});
