/**
 * 验证多份委托的稳定排序、逐份扣减与失败时不留下部分余额。
 * 依赖世界端口、委托状态 schema 与确定性内存事务。
 * 禁止依赖存储插入顺序，也禁止让失败扣减留下部分余额。
 */
import { describe, expect, it } from "vitest";
import type { ResourceAmounts } from "@ai-npc/contracts";
import type { GameContent, GameWorldPort } from "@ai-npc/module-sdk";
import { createWorldPort } from "../src/port";
import { createTestHost, TestWorldTx } from "./support";

function amounts(supply: number): ResourceAmounts {
  return { supply, energy: 0, medical: 0 };
}

function testContent(): GameContent {
  return {
    factions: new Map(),
    stockpiles: new Map([
      ["sp-commons", { stockpileId: "sp-commons", ownerFactionId: "human-neutral" }],
    ]),
  } as unknown as GameContent;
}

function seedDelegation(tx: TestWorldTx, delegationId: string, supply: number): void {
  tx.put("delegation", delegationId, {
    delegationId,
    grantorFactionId: "human-neutral",
    granteeId: "player-1",
    teamIds: [],
    stockpileId: "sp-commons",
    remaining: amounts(supply),
    limit: amounts(supply),
    untilTick: 100,
  });
}

function drawInOrder(order: readonly string[]) {
  const tx = new TestWorldTx(0);
  const supplies = new Map([
    ["del-a", 3],
    ["del-b", 4],
  ]);
  for (const delegationId of order) {
    seedDelegation(tx, delegationId, supplies.get(delegationId) ?? 0);
  }
  const port = createWorldPort(
    () => tx,
    testContent(),
    createTestHost().ids,
  );
  const result = port.drawDelegation("player-1", "sp-commons", amounts(5));
  if (!result.ok) {
    throw new Error(`Expected delegation draw to succeed: ${result.reasonCode}`);
  }
  return {
    result,
    authority: port.drawAuthority("player-1", "sp-commons"),
    delegations: port.delegationsOf("player-1"),
    balances: {
      a: tx.get<unknown>("delegation", "del-a")?.state,
      b: tx.get<unknown>("delegation", "del-b")?.state,
    },
  };
}

describe("delegation draws", () => {
  it("keeps the single-allocation result compatible with existing providers", () => {
    const legacyPort: Pick<GameWorldPort, "drawDelegation"> = {
      drawDelegation: () => ({ ok: true, delegationId: "del-legacy" }),
    };

    expect(legacyPort.drawDelegation("player-1", "sp-commons", amounts(1))).toEqual({
      ok: true,
      delegationId: "del-legacy",
    });
  });

  it("sorts grants by ID and consumes each balance across multiple grants", () => {
    const forward = drawInOrder(["del-b", "del-a"]);
    const reverse = drawInOrder(["del-a", "del-b"]);

    expect(forward.result.allocations).toEqual([
      { delegationId: "del-a", amount: amounts(3) },
      { delegationId: "del-b", amount: amounts(2) },
    ]);
    expect(reverse.result).toEqual(forward.result);
    expect(forward.delegations.map((view) => view.delegationId)).toEqual(["del-a", "del-b"]);
    expect(forward.authority).toMatchObject({
      kind: "delegation",
      delegationId: "del-a",
      remaining: amounts(2),
      untilTick: 100,
    });
    expect(forward.balances).toEqual(reverse.balances);
    expect(forward.balances).toMatchObject({
      a: { remaining: amounts(0) },
      b: { remaining: amounts(2) },
    });
  });

  it("does not mutate any grant when the combined balance is insufficient", () => {
    const tx = new TestWorldTx(0);
    seedDelegation(tx, "del-b", 1);
    seedDelegation(tx, "del-a", 2);
    const before = {
      a: tx.get<unknown>("delegation", "del-a")?.state,
      b: tx.get<unknown>("delegation", "del-b")?.state,
    };
    const port = createWorldPort(() => tx, testContent(), createTestHost().ids);

    expect(port.drawDelegation("player-1", "sp-commons", amounts(4))).toEqual({
      ok: false,
      reasonCode: "draw-limit-exceeded",
    });
    expect({
      a: tx.get<unknown>("delegation", "del-a")?.state,
      b: tx.get<unknown>("delegation", "del-b")?.state,
    }).toEqual(before);
  });
});
