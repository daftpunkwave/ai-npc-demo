/**
 * 浏览器模块描述符的作者入口：按模块 ID 推导 realm 并构造能力引用，再交给 kernel 的统一描述符校验后原样返回。
 * 依赖公共模块契约与 kernel 描述符校验；不加载实现、React、PixiJS 或浏览器网络。
 * 禁止提供绕过描述符校验的注册入口，或让客户端模块依赖服务端 module-sdk。
 */
import {
  DomainError,
  capabilityIdSchema,
  emptyModuleConfigSchema,
  moduleIdSchema,
  type CapabilityRef,
  type ContributionRef,
  type Json,
  type ModuleDefinition,
  type StrictConfigSchema,
} from "@world-prism/contracts";
import { validateModuleDefinition } from "@world-prism/kernel";

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

/**
 * 校验浏览器模块描述符后原样返回。
 * 字段级规则（能力命名空间、重复贡献、严格配置 schema 等）与服务端模块共用 kernel 的同一份校验；
 * 这里只额外拒绝 server realm，因为浏览器宿主不能加载服务端模块。
 */
export function defineBrowserModule<T extends ModuleDefinition>(definition: T): T {
  validateModuleDefinition(definition);
  if (definition.realm === "server") {
    throw new DomainError("realm-violation", `模块 ${definition.id} 不是浏览器 realm`, {
      details: { moduleId: definition.id, realm: definition.realm },
    });
  }
  return definition;
}
