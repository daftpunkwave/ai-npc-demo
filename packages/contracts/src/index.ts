/**
 * 公共 DTO、Zod schema、领域类型与 capability port 契约的唯一定义处。
 * 依赖纯校验与规范化工具，不依赖宿主机制或任何功能实现。
 * 禁止 import Node/DOM 专有 API，保证 server 与 browser 两份 tsconfig 都能编译。
 */
export const packageName = "@ai-npc/contracts";
