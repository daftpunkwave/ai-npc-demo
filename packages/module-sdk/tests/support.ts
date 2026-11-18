/**
 * module-sdk 测试共享的最小模块描述符、创建输入与错误断言助手。
 * 依赖 zod 构造严格配置 schema、公共契约的模块/能力类型与本包定义对象；不加载模块实现或真实宿主资源。
 * 禁止联网、读写文件、使用真实时间/随机源，或放宽 defineModule 的校验语义。
 */
import { expect } from "vitest";
import { z } from "zod";
import {
  DomainError,
  capabilityIdSchema,
  type CapabilityRef,
  type ErrorCode,
  type HostServices,
  type Json,
  type ModuleCreateInput,
  type ModuleDefinition,
  type ModuleInstance,
} from "@ai-npc/contracts";

/** 构造带品牌的能力引用，能力 ID 走契约校验。 */
export function capability(
  capabilityId: string,
  cardinality: CapabilityRef["cardinality"],
  instanceScope: CapabilityRef["instanceScope"],
): CapabilityRef {
  return { capability: capabilityIdSchema.parse(capabilityId), cardinality, instanceScope };
}

/** 与真实模块相同的严格配置 schema：未知键必须被拒绝才能通过 defineModule。 */
export function strictConfigSchema(): ModuleDefinition["configSchema"] {
  return z.strictObject({
    enabled: z.boolean().default(true),
    tickSeconds: z.number().int().positive().default(1),
  });
}

/** 构造一个最小但合法的服务端模块描述符，供测试按字段覆盖出非法组合。 */
export function moduleDefinition(overrides: Readonly<Record<string, unknown>> = {}): ModuleDefinition {
  const definition: ModuleDefinition = {
    id: "game.clock.controlled",
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "run",
    provides: [capability("game.clock", "exactly-one", "run")],
    requires: [],
    requiresRemote: [],
    configSchema: strictConfigSchema(),
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async (input): Promise<ModuleInstance> => ({
      moduleId: input.moduleId,
      start: async () => undefined,
      drain: async () => undefined,
      dispose: async () => undefined,
    }),
  };
  return { ...definition, ...overrides } as unknown as ModuleDefinition;
}

/** 构造一个最小但合法的浏览器模块描述符。 */
export function browserModuleDefinition(
  overrides: Readonly<Record<string, unknown>> = {},
): ModuleDefinition {
  return moduleDefinition({
    id: "client.hud.standard",
    realm: "client",
    kind: "contributor",
    instanceScope: "session",
    provides: [capability("client.hud", "exactly-one", "session")],
    requires: [capability("client.world-view", "exactly-one", "session")],
    requiresRemote: [],
    ...overrides,
  });
}

/** 假宿主服务：只提供确定性最小实现，不触碰真实环境。 */
export function fakeHostServices(): HostServices {
  return {
    ids: (prefix: string) => `${prefix}-000000000000`,
    nowIso: () => "2026-01-01T00:00:00.000Z",
    monotonicMs: () => 0,
    sleep: async () => undefined,
    rng: () => () => 0.5,
    hash: async (value: Json) => `h${JSON.stringify(value).length}`,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    tracer: { span: <T,>(_name: string, _attrs: Json, fn: () => T): T => fn() },
  };
}

/** 构造模块创建输入；默认带世界与分支作用域，可按需覆盖。 */
export function createInput(overrides: Partial<ModuleCreateInput> = {}): ModuleCreateInput {
  return {
    moduleId: "game.clock.controlled",
    realm: "server",
    config: {},
    scope: { worldId: "wld-000000000000", branchId: "br-000000000000" },
    ports: {},
    host: fakeHostServices(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** 断言同步动作抛出指定错误码的 DomainError，并返回错误对象供细节断言。 */
export function expectDomainError(action: () => unknown, code: ErrorCode): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    if (!(error instanceof DomainError)) {
      throw new Error("期望 DomainError");
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error("期望抛出 DomainError，实际没有抛错");
}
