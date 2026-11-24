/**
 * 覆盖地点页签的取数结果：每个节点拿到属于自己的人员数量与库存条目。
 * 依赖真实玩家投影 schema 构造夹具；不渲染组件、不启动浏览器或网络。
 * 禁止把其它节点的人员或库存算到当前节点上，也不得因建索引而丢条目。
 */
import { describe, expect, it } from "vitest";
import { playerProjectionSchema, type PlayerProjection } from "@ai-npc/contracts";
import { placeRows } from "../src/place-rows";

function stockpile(stockpileId: string, nodeId: string, supply: "scarce" | "adequate" | "surplus"): PlayerProjection["stockpiles"][number] {
  return {
    stockpileId,
    nodeId,
    ownerFactionId: "human-neutral",
    supplyLevel: supply,
    energyLevel: "adequate",
    medicalLevel: "scarce",
    amounts: null,
    delegation: null,
  };
}

function character(agentId: string, nodeId: string): PlayerProjection["characters"][number] {
  return {
    agentId,
    name: agentId,
    factionId: "human-neutral",
    role: "信使",
    nodeId,
    injured: false,
    injuredUntilTick: null,
    publicClaim: null,
  };
}

/** 两个节点：tn-a 有 2 人 1 库存，tn-b 有 1 人 0 库存，tn-c 无人无库存。 */
function projection(): PlayerProjection {
  return playerProjectionSchema.parse({
    campaign: null,
    clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
    map: {
      nodes: [
        { nodeId: "tn-a", name: "灰港", x: 0, y: 0, facilities: ["水闸"] },
        { nodeId: "tn-b", name: "旧仓", x: 1, y: 1, facilities: [] },
        { nodeId: "tn-c", name: "空站", x: 2, y: 2, facilities: [] },
      ],
      roads: [],
    },
    meters: null,
    stockpiles: [stockpile("sp-commons", "tn-a", "surplus")],
    teams: [],
    characters: [
      character("npc-cenyan", "tn-a"),
      character("npc-wenyuan", "tn-a"),
      character("npc-independent", "tn-b"),
    ],
    tasks: [],
    agreements: [],
    invitations: [],
    conversations: [],
    inbox: [],
    notebook: [],
    awaitingReplyFrom: [],
    notifications: [],
  });
}

describe("placeRows", () => {
  it("每个节点只拿到属于自己的人员与库存", () => {
    const rows = placeRows(projection());
    const byNode = new Map(rows.map((row) => [row.nodeId, row]));

    // tn-a：两人在场，一条库存。
    expect(byNode.get("tn-a")?.people.map((person) => person.agentId)).toEqual([
      "npc-cenyan",
      "npc-wenyuan",
    ]);
    expect(byNode.get("tn-a")?.people).toHaveLength(2);
    expect(byNode.get("tn-a")?.stockpiles.map((item) => item.stockpileId)).toEqual(["sp-commons"]);

    // tn-b：一人，无库存（沿用空数组而不是借用 tn-a 的库存）。
    expect(byNode.get("tn-b")?.people).toHaveLength(1);
    expect(byNode.get("tn-b")?.stockpiles).toEqual([]);

    // tn-c：两者都为空。
    expect(byNode.get("tn-c")?.people).toEqual([]);
    expect(byNode.get("tn-c")?.stockpiles).toEqual([]);
  });

  it("结果行与投影节点同序，人数与库存总数不丢不重复", () => {
    const source = projection();
    const rows = placeRows(source);

    expect(rows.map((row) => row.nodeId)).toEqual(source.map.nodes.map((node) => node.nodeId));
    const peopleTotal = rows.reduce((count, row) => count + row.people.length, 0);
    const stockpileTotal = rows.reduce((count, row) => count + row.stockpiles.length, 0);
    expect(peopleTotal).toBe(source.characters.length);
    expect(stockpileTotal).toBe(source.stockpiles.length);
  });

  it("保留节点名称与设施，库存等级随条目原样带出", () => {
    const rows = placeRows(projection());
    const first = rows[0];

    expect(first?.name).toBe("灰港");
    expect(first?.facilities).toEqual(["水闸"]);
    expect(first?.stockpiles[0]?.supplyLevel).toBe("surplus");
    expect(first?.stockpiles[0]?.energyLevel).toBe("adequate");
  });

  it("同一节点有多条库存时全部展示", () => {
    const source = projection();
    source.stockpiles.push(stockpile("sp-earth", "tn-a", "scarce"));
    const rows = placeRows(source);

    expect(rows.find((row) => row.nodeId === "tn-a")?.stockpiles.map((item) => item.stockpileId)).toEqual([
      "sp-commons",
      "sp-earth",
    ]);
  });

  it("没有节点时返回空结果", () => {
    const source = projection();
    source.map.nodes = [];
    expect(placeRows(source)).toEqual([]);
  });
});
