/**
 * kernel 测试共享的最小假模块、假宿主与错误断言助手。
 * 依赖公共契约类型与 zod 构造严格配置 schema，以及本包 DomainError。
 * 禁止联网、写文件、读取真实模块或使用真实哈希/时间实现。
 */
import { expect } from "vitest";
import { z } from "zod";
import {
  DomainError,
  assemblyDescriptorSchema,
  canonicalJson,
  capabilityIdSchema,
  type AgentSlotImplementations,
  type AssemblyDescriptor,
  type CapabilityBinding,
  type CapabilityRef,
  type Cardinality,
  type ErrorCode,
  type HostServices,
  type InstanceScope,
  type Json,
  type ModuleCreateInput,
  type ModuleDefinition,
  type ModuleInstance,
  type ModuleKind,
  type Realm,
} from "@world-prism/contracts";

/** 构造能力引用，能力 ID 走契约品牌校验。 */
export function capability(
  capabilityId: string,
  cardinality: Cardinality,
  instanceScope: InstanceScope,
): CapabilityRef {
  return { capability: capabilityIdSchema.parse(capabilityId), cardinality, instanceScope };
}

/** 构造装配绑定，模块 ID 只做字符串校验而不做目录存在性判断。 */
export function binding(
  capabilityId: string,
  moduleId: string,
  configRef: string | null = null,
): CapabilityBinding {
  return { capability: capabilityIdSchema.parse(capabilityId), moduleId, configRef };
}

export interface AssemblySpec {
  readonly assemblyId?: string;
  readonly configs?: Readonly<Record<string, Json>>;
  readonly server?: {
    readonly bindings: readonly CapabilityBinding[];
    readonly agentSlots?: AgentSlotImplementations;
  };
  readonly client?: { readonly bindings: readonly CapabilityBinding[] };
  readonly console?: { readonly bindings: readonly CapabilityBinding[] };
}

/** 构造通过契约 schema 的装配描述符，未给出的 realm 默认为空绑定。 */
export function makeAssembly(spec: AssemblySpec = {}): AssemblyDescriptor {
  return assemblyDescriptorSchema.parse({
    schemaVersion: 1,
    assemblyId: spec.assemblyId ?? "test-assembly",
    configs: spec.configs ?? {},
    realms: {
      server: spec.server ?? { bindings: [] },
      client: spec.client ?? { bindings: [] },
      console: spec.console ?? { bindings: [] },
    },
  });
}

export interface FakeModuleSpec {
  readonly id: string;
  readonly realm?: Realm;
  readonly kind?: ModuleKind;
  readonly version?: string;
  readonly apiVersion?: string;
  readonly instanceScope?: InstanceScope;
  readonly provides?: readonly CapabilityRef[];
  readonly requires?: readonly CapabilityRef[];
  readonly requiresRemote?: readonly string[];
  readonly configSchema?: ModuleDefinition["configSchema"];
  readonly defaults?: Json;
  readonly port?: unknown;
  readonly create?: (input: ModuleCreateInput) => Promise<ModuleInstance> | ModuleInstance;
  readonly onCreate?: (input: ModuleCreateInput) => void;
  readonly onStart?: (signal: AbortSignal) => Promise<void> | void;
  readonly onDrain?: (deadlineMs: number) => Promise<void> | void;
  readonly onDispose?: () => Promise<void> | void;
}

/** 构造最小 ModuleDefinition；生命周期钩子可被测试观测或抛错。 */
export function fakeModule(spec: FakeModuleSpec): ModuleDefinition {
  return {
    id: spec.id,
    realm: spec.realm ?? "server",
    kind: spec.kind ?? "service",
    version: spec.version ?? "1.0.0",
    apiVersion: spec.apiVersion ?? "1",
    instanceScope: spec.instanceScope ?? "deployment",
    provides: spec.provides ?? [],
    requires: spec.requires ?? [],
    requiresRemote: (spec.requiresRemote ?? []).map((remote) => capabilityIdSchema.parse(remote)),
    configSchema: spec.configSchema ?? z.strictObject({}),
    ...(spec.defaults === undefined ? {} : { defaults: spec.defaults }),
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async (input) => {
      spec.onCreate?.(input);
      if (spec.create !== undefined) {
        return spec.create(input);
      }
      return {
        moduleId: spec.id,
        start: async (signal) => {
          await spec.onStart?.(signal);
        },
        drain: async (deadlineMs) => {
          await spec.onDrain?.(deadlineMs);
        },
        dispose: async () => {
          await spec.onDispose?.();
        },
        ...(spec.port === undefined ? {} : { port: spec.port }),
      };
    },
  };
}

/** 假宿主服务：只提供确定性的最小实现，不触碰真实环境。 */
export function fakeHostServices(overrides: Partial<HostServices> = {}): HostServices {
  const host: HostServices = {
    ids: (prefix: string) => `${prefix}-000000000000`,
    nowIso: () => "2026-01-01T00:00:00.000Z",
    monotonicMs: () => 0,
    sleep: async () => undefined,
    rng: () => () => 0.5,
    hash: async (value: Json) => `h${canonicalJson(value).length}`,
    hashText: async (text: string) => `h${text.length}`,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    tracer: {
      span: <T>(_name: string, _attrs: Json, fn: () => T): T => fn(),
    },
  };
  return { ...host, ...overrides };
}

function stableDigest(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** 假哈希端口：稳定、可记录输入，用于验证规范化与稳定性而非密码学强度。 */
export function fakeHasher(record?: string[]): (canonical: string) => Promise<string> {
  return async (canonical: string) => {
    record?.push(canonical);
    return stableDigest(canonical);
  };
}

function domainErrorOf(error: unknown): DomainError {
  expect(error).toBeInstanceOf(DomainError);
  if (!(error instanceof DomainError)) {
    throw new Error("期望 DomainError");
  }
  return error;
}

/** 断言同步动作抛出指定错误码的 DomainError，并返回错误对象供细节断言。 */
export function expectDomainError(action: () => unknown, code: ErrorCode): DomainError {
  try {
    action();
  } catch (error) {
    const domainError = domainErrorOf(error);
    expect(domainError.code).toBe(code);
    return domainError;
  }
  throw new Error("期望抛出 DomainError，实际没有抛错");
}

/** 断言异步动作抛出指定错误码的 DomainError，并返回错误对象供细节断言。 */
export async function expectDomainErrorAsync(
  action: () => Promise<unknown>,
  code: ErrorCode,
): Promise<DomainError> {
  try {
    await action();
  } catch (error) {
    const domainError = domainErrorOf(error);
    expect(domainError.code).toBe(code);
    return domainError;
  }
  throw new Error("期望抛出 DomainError，实际没有抛错");
}

/** 把错误 details 序列化，便于断言模块 ID、能力 ID 等定位信息。 */
export function detailsText(error: DomainError): string {
  return JSON.stringify(error.details);
}
