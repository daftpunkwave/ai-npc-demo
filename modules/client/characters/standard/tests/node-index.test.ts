/**
 * 覆盖地点页签的按节点分组索引：一次遍历分组、保持原序、缺失节点返回空。
 * 依赖纯分组函数与最小条目形状；不渲染组件、不启动浏览器或网络。
 * 禁止把不同节点的条目混入同一桶，或为未出现节点预建空数组。
 */
import { describe, expect, it } from "vitest";
import { groupByNodeId } from "../src/node-index";

describe("groupByNodeId", () => {
  it("按节点分组并保持输入顺序", () => {
    const grouped = groupByNodeId([
      { nodeId: "nd-1", label: "a" },
      { nodeId: "nd-2", label: "b" },
      { nodeId: "nd-1", label: "c" },
    ]);

    expect(grouped.get("nd-1")?.map((item) => item.label)).toEqual(["a", "c"]);
    expect(grouped.get("nd-2")?.map((item) => item.label)).toEqual(["b"]);
    expect(grouped.size).toBe(2);
  });

  it("未出现的节点不预建空桶，查找侧按空数组兜底", () => {
    const grouped = groupByNodeId([{ nodeId: "nd-1" }]);

    expect(grouped.has("nd-2")).toBe(false);
    expect(grouped.get("nd-2") ?? []).toEqual([]);
  });

  it("空集合得到空索引", () => {
    expect(groupByNodeId([]).size).toBe(0);
  });

  it("同一节点的条目数量与分组结果一致，不丢条目也不重复", () => {
    const items = [
      { nodeId: "nd-1", id: "s-1" },
      { nodeId: "nd-1", id: "s-2" },
      { nodeId: "nd-1", id: "s-2" },
      { nodeId: "nd-2", id: "s-3" },
    ];
    const grouped = groupByNodeId(items);

    // 分组只负责归类，不去重：重复条目仍按原样保留在下游的输入顺序里。
    expect(grouped.get("nd-1")).toHaveLength(3);
    const total = [...grouped.values()].reduce((count, bucket) => count + bucket.length, 0);
    expect(total).toBe(items.length);
  });
});
