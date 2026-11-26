/**
 * 提供游戏模块共用的三资源数量运算：加减、截断、覆盖判断与总量。
 * 依赖公共契约的资源量与资源增减类型；全部为纯函数，不读写世界状态。
 * 禁止在这里引入库存聚合、生成事件或替代各模块自己的资源校验。
 */
import type { ResourceAmounts, ResourceDelta, ResourceId } from "@world-prism/contracts";

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
