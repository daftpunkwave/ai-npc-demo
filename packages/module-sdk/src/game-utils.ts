/**
 * 提供游戏模块共用的资源数量运算、主体解析与内容视图断言。
 * 依赖公共契约的认证上下文、资源量、受众与模块 SDK 的内容视图类型。
 * 禁止在这里读写世界状态、生成事件或替代各模块自己的业务校验。
 */
import type { AudienceSpec, AuthContext, ResourceAmounts, ResourceDelta, ResourceId } from "@ai-npc/contracts";
import type { GameContent } from "./game-ports";

/** 三种资源的固定顺序，供遍历与稳定投影使用。 */
export const resourceIds: readonly ResourceId[] = ["supply", "energy", "medical"];

/** 全零资源量。 */
export const zeroResources: ResourceAmounts = { supply: 0, energy: 0, medical: 0 };

/** 构造资源量，未给出的字段填 0。 */
export function amounts(partial: Partial<ResourceAmounts>): ResourceAmounts {
  return {
    supply: partial.supply ?? 0,
    energy: partial.energy ?? 0,
    medical: partial.medical ?? 0,
  };
}

/** 逐字段相加。 */
export function addAmounts(left: ResourceAmounts, right: ResourceAmounts): ResourceAmounts {
  return {
    supply: left.supply + right.supply,
    energy: left.energy + right.energy,
    medical: left.medical + right.medical,
  };
}

/** 逐字段相减；结果允许临时为负，由调用方决定是否拒绝。 */
export function subtractAmounts(left: ResourceAmounts, right: ResourceAmounts): ResourceAmounts {
  return {
    supply: left.supply - right.supply,
    energy: left.energy - right.energy,
    medical: left.medical - right.medical,
  };
}

/** 把资源增减量应用到完整数量上，并把每个字段截断到非负。 */
export function applyDelta(base: ResourceAmounts, delta: ResourceDelta): ResourceAmounts {
  return {
    supply: Math.max(0, base.supply + (delta.supply ?? 0)),
    energy: Math.max(0, base.energy + (delta.energy ?? 0)),
    medical: Math.max(0, base.medical + (delta.medical ?? 0)),
  };
}

/** 判断 left 是否在每个字段上都不小于 right。 */
export function coversAmounts(left: ResourceAmounts, right: ResourceAmounts): boolean {
  return left.supply >= right.supply && left.energy >= right.energy && left.medical >= right.medical;
}

/** 判断资源量是否全为零。 */
export function isZeroAmounts(value: ResourceAmounts): boolean {
  return value.supply === 0 && value.energy === 0 && value.medical === 0;
}

/** 计算资源量的总和，用于运力校验。 */
export function totalAmount(value: ResourceAmounts): number {
  return value.supply + value.energy + value.medical;
}

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

/**
 * 把宿主注入的内容索引收窄为游戏端口视图；调用方必须在启动时完成真实内容校验。
 * 这里只做结构断言，不重新解析 YAML 或修补缺失字段。
 */
export function requireGameContent(content: unknown): GameContent {
  if (typeof content !== "object" || content === null) {
    throw new TypeError("游戏模块需要内容索引");
  }
  const candidate = content as Partial<GameContent>;
  if (
    !(candidate.nodes instanceof Map) ||
    !(candidate.roads instanceof Map) ||
    !(candidate.factions instanceof Map) ||
    !(candidate.characters instanceof Map) ||
    !(candidate.stockpiles instanceof Map) ||
    !(candidate.teams instanceof Map) ||
    !(candidate.groups instanceof Map) ||
    !(candidate.evidence instanceof Map) ||
    !(candidate.starts instanceof Map)
  ) {
    throw new TypeError("内容索引缺少游戏模块所需的固定索引");
  }
  return candidate as GameContent;
}
