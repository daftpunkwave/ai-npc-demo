/**
 * 验证投递名单的生成顺序：主体按 comparePrincipalIds 的码元序排列并去重，生成结果能通过契约的投递名单校验，
 * 不随宿主 locale 改变。
 * 依赖投递路由纯函数与公共契约的投递名单 schema；不启动存储或世界事务。
 * 禁止用 localeCompare 构造期望顺序，或只断言条数而不核对顺序。
 */
import { describe, expect, it } from "vitest";
import { deliveryListSchema } from "@world-prism/contracts";
import { deliveries, type DeliveryRoutingInput } from "../src/delivery-routing";

const sameNodeRouting: DeliveryRoutingInput = {
  worldTick: () => 7,
  relayState: () => "normal",
  principalNode: () => "grayharbor",
  sameNode: () => true,
};

describe("投递名单生成顺序", () => {
  it("大小写与标点混排的主体按码元序排列并去重，结果通过契约校验", () => {
    const routes = deliveries(sameNodeRouting, "dialogue", "npc_x", ["player-1", "NPC-1", "npc1", "npc_x"]);
    expect(routes?.map((route) => route.principalId)).toEqual(["NPC-1", "npc1", "npc_x", "player-1"]);
    expect(deliveryListSchema.safeParse(routes).success).toBe(true);
  });
});
