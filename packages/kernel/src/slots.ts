/**
 * 汇总 slot 贡献并按 order 稳定排序，检测同一 slot 内扩展 ID 冲突与非法 order。
 * 依赖公共契约的 ContributionRef 与 DomainError；不执行任何 UI 或模块实现。
 * 禁止让注册顺序无声明地决定排序，或静默接受重复扩展 ID、非整数顺序值。
 */
import { DomainError, type ContributionRef } from "@ai-npc/contracts";

interface OrderedContribution<T extends ContributionRef> {
  readonly value: T;
  readonly registrationIndex: number;
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function compareContribution<T extends ContributionRef>(left: OrderedContribution<T>, right: OrderedContribution<T>): number {
  if (left.value.order !== right.value.order) {
    return left.value.order < right.value.order ? -1 : 1;
  }
  return left.registrationIndex - right.registrationIndex;
}

/**
 * 把贡献按 slot 分组并在组内按 order 稳定排序；相同 order 保持输入（注册）顺序。
 * 返回对象的 slot 键按名称排序，组内顺序即最终展示顺序。
 */
export function orderSlotContributions<T extends ContributionRef>(
  contributions: readonly T[],
): Readonly<Record<string, readonly T[]>> {
  const groups = new Map<string, OrderedContribution<T>[]>();
  const seen = new Set<string>();

  contributions.forEach((contribution, registrationIndex) => {
    if (!Number.isSafeInteger(contribution.order)) {
      throw new DomainError("assembly-incompatible", `贡献 ${contribution.extensionId} 的 order 必须是安全整数`, {
        details: { extensionId: contribution.extensionId, slot: contribution.slot, order: String(contribution.order) },
      });
    }
    const conflictKey = `${contribution.slot}\u0000${contribution.extensionId}`;
    if (seen.has(conflictKey)) {
      throw new DomainError("assembly-incompatible", `slot ${contribution.slot} 中的扩展 ID ${contribution.extensionId} 重复`, {
        details: { extensionId: contribution.extensionId, slot: contribution.slot },
      });
    }
    seen.add(conflictKey);
    const group = groups.get(contribution.slot);
    const ordered: OrderedContribution<T> = { value: contribution, registrationIndex };
    if (group === undefined) {
      groups.set(contribution.slot, [ordered]);
    } else {
      group.push(ordered);
    }
  });

  const result: Record<string, readonly T[]> = {};
  for (const slot of [...groups.keys()].sort(compareText)) {
    const group = groups.get(slot) ?? [];
    // eslint-disable-next-line security/detect-object-injection -- 槽位来自本函数遍历的 groups 键。
    result[slot] = Object.freeze([...group].sort(compareContribution).map((item) => item.value));
  }
  return result;
}
