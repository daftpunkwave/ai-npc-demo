/**
 * 核心职责：把带 nodeId 的投影集合按节点一次性建成索引，供地点页签逐节点查找。
 * 交互契约：输入任意带只读 nodeId 的条目数组，返回 nodeId 到条目数组的映射；条目顺序与输入一致。
 * 约束与禁忌：只做分组，不筛选、不去重、不改写条目；禁止在此读取世界状态或产生副作用。
 */

/** 按 nodeId 分组；每个条目只被遍历一次，查找复杂度从逐节点重扫降为常数级。 */
export function groupByNodeId<T extends { readonly nodeId: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(item.nodeId);
    if (bucket === undefined) {
      grouped.set(item.nodeId, [item]);
    } else {
      bucket.push(item);
    }
  }
  return grouped;
}
