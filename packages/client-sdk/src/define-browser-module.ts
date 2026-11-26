/**
 * 校验浏览器模块描述符的 ID、realm、kind 与必填字段后原样返回。
 * 依赖公共模块契约；不加载实现、React、PixiJS 或浏览器网络。
 * 禁止提供绕过描述符校验的注册入口，或让客户端模块依赖服务端 module-sdk。
 */
import {
  DomainError,
  capabilityIdSchema,
  emptyModuleConfigSchema,
  moduleIdSchema,
  moduleKindSchema,
  realmSchema,
  type CapabilityRef,
  type ContributionRef,
  type Json,
  type ModuleDefinition,
  type StrictConfigSchema,
} from "@world-prism/contracts";

type BrowserRealm = Extract<ModuleDefinition["realm"], "client" | "console">;

export interface BrowserModuleDefinitionInput {
  readonly id: string;
  readonly kind: ModuleDefinition["kind"];
  readonly provides: string;
  readonly requires?: readonly string[];
  readonly requiresRemote?: readonly string[];
  readonly configSchema?: StrictConfigSchema;
  readonly defaults?: Json;
  readonly contributions?: readonly ContributionRef[];
  readonly create: ModuleDefinition["create"];
}

function browserRealm(id: string): BrowserRealm {
  if (!moduleIdSchema.safeParse(id).success) {
    throw new DomainError("assembly-incompatible", `浏览器模块 ID 不合法：${id}`);
  }
  if (id.startsWith("client.")) {
    return "client";
  }
  if (id.startsWith("console.")) {
    return "console";
  }
  throw new DomainError("realm-violation", `模块 ${id} 不能由浏览器宿主注册`);
}

function capabilityRef(capability: string): CapabilityRef {
  return {
    capability: capabilityIdSchema.parse(capability),
    cardinality: "exactly-one",
    instanceScope: "session",
  };
}

export function defineBrowserModuleDefinition(
  input: BrowserModuleDefinitionInput,
): ModuleDefinition {
  return defineBrowserModule({
    id: input.id,
    realm: browserRealm(input.id),
    kind: input.kind,
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "session",
    provides: [capabilityRef(input.provides)],
    requires: (input.requires ?? []).map(capabilityRef),
    requiresRemote: (input.requiresRemote ?? []).map((capability) =>
      capabilityIdSchema.parse(capability),
    ),
    configSchema: input.configSchema ?? emptyModuleConfigSchema,
    defaults: input.defaults ?? {},
    stateSchemaVersion: null,
    migrationPaths: [],
    ...(input.contributions === undefined
      ? {}
      : { contributions: input.contributions }),
    create: input.create,
  });
}

export function defineBrowserModule<T extends ModuleDefinition>(definition: T): T {
  if (!moduleIdSchema.safeParse(definition.id).success) {
    throw new DomainError("assembly-incompatible", `浏览器模块 ID 不合法：${definition.id}`);
  }
  if (!realmSchema.safeParse(definition.realm).success || definition.realm === "server") {
    throw new DomainError("realm-violation", `模块 ${definition.id} 不是浏览器 realm`);
  }
  if (!moduleKindSchema.safeParse(definition.kind).success) {
    throw new DomainError("assembly-incompatible", `模块 ${definition.id} 的 kind 不合法`);
  }
  if (definition.version.length === 0 || definition.apiVersion.length === 0) {
    throw new DomainError("assembly-incompatible", `模块 ${definition.id} 缺少版本`);
  }
  return definition;
}
