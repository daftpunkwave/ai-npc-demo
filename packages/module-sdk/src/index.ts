/**
 * 服务端模块的作者辅助：defineModule、受控 port 类型与生命周期辅助。
 * 依赖 contracts 与 kernel 的公开入口，不直接加载任何模块实现。
 * 禁止提供万能上下文或绕过 descriptor 校验的注册通道。
 */
export const packageName = "@ai-npc/module-sdk";
