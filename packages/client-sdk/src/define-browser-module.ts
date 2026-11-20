/**
 * 校验浏览器模块描述符的 ID、realm、kind 与必填字段后原样返回。
 * 依赖公共模块契约；不加载实现、React、PixiJS 或浏览器网络。
 * 禁止提供绕过描述符校验的注册入口，或让客户端模块依赖服务端 module-sdk。
 */
import {
  DomainError,
  moduleIdSchema,
  moduleKindSchema,
  realmSchema,
  type ModuleDefinition,
} from "@ai-npc/contracts";

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
