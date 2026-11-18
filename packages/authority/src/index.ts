/**
 * 服务端固定的命令网关、事务边界、幂等、版本与 fencing 机制。
 * 依赖 contracts 与 kernel 的公开契约，通过注入的 storage/world 端口工作。
 * 禁止包含水闸、资源或协议等具体游戏规则，也不得吞掉领域拒绝。
 */
export const packageName = "@ai-npc/authority";
