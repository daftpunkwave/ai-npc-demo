/**
 * 核心职责：集中登记跨域契约版本：模块 apiVersion、命令信封与领域事件 schemaVersion、HTTP/WS 协议版本。
 * 交互契约：装配解析、命令网关、事件写入与浏览器握手只从本文件取得受支持版本，不各自写死字面量。
 * 约束与禁忌：新增兼容版本时同时登记支持集合与迁移策略；禁止把模块版本、内容版本或状态版本混入本文件。
 */

/** 当前模块契约版本；模块描述符的 apiVersion 必须属于受支持集合。 */
export const moduleApiVersion = "1";

/** 受支持的模块契约版本；装配解析发现其他值时拒绝启动。 */
export const supportedModuleApiVersions = [moduleApiVersion] as const;

export type ModuleApiVersion = (typeof supportedModuleApiVersions)[number];

/** 判断模块 apiVersion 是否受当前宿主支持。 */
export function isSupportedModuleApiVersion(value: string): boolean {
  return (supportedModuleApiVersions as readonly string[]).includes(value);
}

/** 当前命令信封 schemaVersion；命令网关只接受受支持集合中的版本。 */
export const commandEnvelopeSchemaVersion = 1;

/** 受支持的命令信封 schemaVersion。 */
export const supportedCommandEnvelopeSchemaVersions = [commandEnvelopeSchemaVersion] as const;

/** 判断命令信封 schemaVersion 是否受支持。 */
export function isSupportedCommandEnvelopeSchemaVersion(value: number): boolean {
  return (supportedCommandEnvelopeSchemaVersions as readonly number[]).includes(value);
}

/** 当前领域事件 schemaVersion；新写入事件使用该版本。 */
export const domainEventSchemaVersion = 1;

/** 受支持的领域事件 schemaVersion；读取旧事件时按此集合判定是否需要迁移。 */
export const supportedDomainEventSchemaVersions = [domainEventSchemaVersion] as const;

/** 当前 HTTP/WS 协议版本；握手两侧必须一致。 */
export const protocolVersion = "1";

/** 受支持的 HTTP/WS 协议版本。 */
export const supportedProtocolVersions = [protocolVersion] as const;

/** 判断客户端或服务端声明的协议版本是否受支持。 */
export function isSupportedProtocolVersion(value: string): boolean {
  return (supportedProtocolVersions as readonly string[]).includes(value);
}
