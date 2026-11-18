/**
 * 解析宿主提供的 slot 贡献：先按 slot 过滤，再复用 kernel 的稳定 order 排序与冲突检测。
 * 依赖公共契约的贡献引用与 kernel 的 slot 排序机制；不执行任何视图代码，也不读取宿主状态。
 * 禁止把注册顺序当作排序依据，或静默接受同一 slot 内重复的扩展 ID。
 */
import { orderSlotContributions } from "@ai-npc/kernel";
import type { ContributionRef } from "@ai-npc/contracts";
import type { ReactNode } from "react";

/** 宿主解析后的 slot 贡献：契约里的贡献记录加上已绑定到具体视图的渲染入口。 */
export interface SlotContribution extends ContributionRef {
  /** 渲染该贡献的视图；由宿主在装配模块时绑定，只能读取已授权数据。 */
  render(): ReactNode;
}

const EMPTY_SLOT_CONTRIBUTIONS: readonly never[] = Object.freeze([]);

/**
 * 选出指定 slot 的贡献并按 order 升序稳定排序：相同 order 保持宿主注册顺序，未注册 slot 返回空数组。
 * 同一 slot 内扩展 ID 重复时由 kernel 抛领域错误，交给宿主按装配错误处理。
 */
export function selectSlotContributions<T extends ContributionRef>(
  contributions: readonly T[],
  slot: string,
): readonly T[] {
  const forSlot = contributions.filter((contribution) => contribution.slot === slot);
  if (forSlot.length === 0) {
    return EMPTY_SLOT_CONTRIBUTIONS;
  }
  const ordered = orderSlotContributions(forSlot);
  return ordered[slot] ?? EMPTY_SLOT_CONTRIBUTIONS;
}
