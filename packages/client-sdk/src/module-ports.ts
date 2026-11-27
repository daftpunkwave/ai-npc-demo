/**
 * 计算浏览器模块可见的端口：宿主固定端口按 realm 契约校验，模块只拿到固定端口与自己声明的能力端口。
 * 依赖公共契约的宿主固定端口清单、模块描述符与 DomainError；不创建端口、不访问网络或 DOM。
 * 禁止把清单外的宿主端口转交给模块，也禁止把模块未声明的能力端口放进它的视图。
 */
import { BROWSER_HOST_PORTS, DomainError, type ModuleDefinition, type Realm } from "@world-prism/contracts";

/**
 * 校验宿主注入的固定端口都在本 realm 的固定端口契约内并原样返回。
 * 清单外的键说明宿主与模块之间多了一条未登记的取用通道，check:catalog 也无法对账，直接按装配不兼容拒绝。
 */
export function contractedHostPorts(
  realm: Realm,
  fixedPorts: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const allowed: readonly string[] = realm === "server" ? [] : BROWSER_HOST_PORTS[realm];
  for (const key of Object.keys(fixedPorts)) {
    if (!allowed.includes(key)) {
      throw new DomainError("assembly-incompatible", `宿主固定端口 ${key} 不在 ${realm} realm 的固定端口契约内`, {
        details: { realm, port: key, allowed: [...allowed] },
      });
    }
  }
  return { ...fixedPorts };
}

/**
 * 一个模块可见的端口：本 realm 宿主固定端口加 requires 声明的能力端口；视图另含模块自身 provides 的端口。
 * 已声明但当前没有提供者的能力也保留键（值为 undefined），让取用处能区分「未声明」与「已声明但未注册」。
 */
export function declaredModulePorts(
  definition: ModuleDefinition,
  hostPorts: Readonly<Record<string, unknown>>,
  available: Readonly<Record<string, unknown>>,
  includeProvides: boolean,
): Readonly<Record<string, unknown>> {
  const ports: Record<string, unknown> = { ...hostPorts };
  const declared = includeProvides ? [...definition.requires, ...definition.provides] : definition.requires;
  for (const reference of declared) {
    ports[reference.capability] = available[reference.capability];
  }
  return ports;
}
