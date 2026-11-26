/**
 * 浏览器与服务端之间的类型化 HTTP/WS 传输、命令幂等重试与授权投影 reducer 协议。
 * 依赖 contracts 中的公共 DTO 与版本化协议定义。
 * 禁止拼装第二份世界状态、直接访问数据库或绕过授权投影。
 */
export const packageName = "@world-prism/client-protocol";

export { ApiClient, jsonBody, takeHashToken } from "./http";
export type { ApiClientOptions, RequestOptions } from "./http";

export { CommandClient, randomCommandId } from "./command-client";
export type { CommandClientOptions } from "./command-client";

export { ProjectionStore } from "./projection-store";
export type { ProjectionApplyResult, ProjectionState } from "./projection-store";

export { StreamClient } from "./stream-client";
export type { StreamClientOptions } from "./stream-client";
