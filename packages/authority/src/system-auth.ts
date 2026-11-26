/**
 * 构造规则 job、时钟步骤与事件消费者的系统认证上下文。
 * 依赖公共契约的认证上下文类型；只表达 system:world 身份，不携带租约或 turn。
 * 禁止用系统上下文冒充玩家、运营或 Agent，也禁止把它传给需要 fencing 的命令入口。
 */
import type { AuthContext } from "@world-prism/contracts";

/** 系统主体 ID；规则 job、时钟步骤与订阅使用同一身份。 */
export const systemPrincipalId = "system:world";

/** 构造一个分支内的系统认证上下文。 */
export function createSystemAuth(worldId: string, branchId: string): AuthContext {
  return {
    principalId: systemPrincipalId,
    kind: "system",
    roles: [],
    worldId,
    branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
  };
}
