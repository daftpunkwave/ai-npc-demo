/**
 * 提供游戏模块共用主体解析与公开受众构造：席位代发折算与 public/principals/faction 受众。
 * 依赖公共契约的认证上下文与受众类型；只做纯函数构造，不校验主体存在性。
 * 禁止在这里读写世界状态或替代命令网关的身份校验。
 */
import type { AudienceSpec, AuthContext } from "@world-prism/contracts";

/** 授权上下文中的有效行动主体：真人席位代发时按被代发的 Agent 计算。 */
export function effectivePrincipalId(auth: AuthContext): string {
  return auth.actingAsAgentId ?? auth.principalId;
}

/** 公开受众。 */
export function publicAudience(): readonly AudienceSpec[] {
  return [{ kind: "public" }];
}

/** 指定主体受众；空名单返回空数组，由调用方决定是否允许。 */
export function principalsAudience(ids: readonly string[]): readonly AudienceSpec[] {
  const unique = [...new Set(ids)];
  return unique.length === 0 ? [] : [{ kind: "principals", ids: unique }];
}

/** 派系受众。 */
export function factionAudience(factionId: string): AudienceSpec {
  return { kind: "faction", factionId };
}
