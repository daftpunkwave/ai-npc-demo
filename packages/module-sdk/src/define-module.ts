/**
 * 暴露服务端与浏览器模块的作者入口：校验描述符必填字段与非法组合后原样返回。
 * 依赖本包 descriptor-validation 的校验与公共契约的模块类型；不加载实现、不创建实例或资源。
 * 禁止提供绕过校验的注册通道，或在返回时丢失调用方描述符的具体类型。
 */
import type { ModuleDefinition } from "@world-prism/contracts";
import { validateModuleDefinition } from "./descriptor-validation";

/**
 * 校验模块描述符的必填字段与明显非法组合后原样返回。
 * 泛型返回值保留调用方描述符的具体类型（不丢失 port 与工厂签名收窄），校验失败直接抛领域错误。
 */
export function defineModule<T extends ModuleDefinition>(definition: T): T {
  validateModuleDefinition(definition);
  return definition;
}
