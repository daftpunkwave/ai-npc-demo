/**
 * 唯一的 Agent turn 管线、调度协调、工具网关与受控对白提交。
 * 依赖 contracts、kernel 与注入的端口，不直接持有具体认知模块实现。
 * 禁止复制第二套 loop，或让模块绕过证据、预算与 fencing 边界。
 */
export const packageName = "@ai-npc/agent-runtime";
