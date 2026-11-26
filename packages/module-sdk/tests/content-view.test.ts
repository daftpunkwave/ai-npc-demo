/**
 * 验证内容视图辅助的结构断言、运营席判定与水闸控制权判定。
 * 依赖合成的最小内容视图；不加载真实内容包，也不访问世界状态。
 * 禁止在本文件复制内容 schema 或写死具体内容包的 ID。
 */
import { describe, expect, it } from "vitest";
import type { GameContent } from "@world-prism/module-sdk";
import { controlsWatergate, holdsOperationalSeat, requireGameContent } from "../src/content-view";

/** 构造通过结构断言的最小内容视图；派系表与公社席规则可定制。 */
function contentWith(options: {
  readonly seatId: string;
  readonly factions?: readonly { readonly factionId: string; readonly playerSeat?: string }[];
}): GameContent {
  const factions = new Map(
    (options.factions ?? []).map((faction) => [faction.factionId, faction]),
  );
  return {
    nodes: new Map(),
    roads: new Map(),
    factions,
    characters: new Map(),
    stockpiles: new Map(),
    teams: new Map(),
    groups: new Map(),
    evidence: new Map(),
    starts: new Map(),
    rules: { watergateSeatId: options.seatId },
  } as unknown as GameContent;
}

describe("requireGameContent", () => {
  it("缺少固定索引的内容视图被拒绝", () => {
    expect(() => requireGameContent(null)).toThrow(TypeError);
    expect(() => requireGameContent({ nodes: new Map() })).toThrow(/固定索引/);
  });

  it("通过结构断言的内容视图原样返回", () => {
    const content = contentWith({ seatId: "seat.test", factions: [] });
    expect(requireGameContent(content)).toBe(content);
  });
});

describe("holdsOperationalSeat", () => {
  it("派系的 playerSeat 匹配规则声明的席位时判定持有", () => {
    const content = contentWith({
      seatId: "seat.commune",
      factions: [{ factionId: "faction-a", playerSeat: "seat.commune" }],
    });
    expect(holdsOperationalSeat(content, "faction-a")).toBe(true);
  });

  it("席位不同、无席位声明或主体不存在时判定不持有", () => {
    const content = contentWith({
      seatId: "seat.commune",
      factions: [
        { factionId: "faction-a", playerSeat: "seat.other" },
        { factionId: "faction-b" },
      ],
    });
    expect(holdsOperationalSeat(content, "faction-a")).toBe(false);
    expect(holdsOperationalSeat(content, "faction-b")).toBe(false);
    expect(holdsOperationalSeat(content, "faction-missing")).toBe(false);
  });

  it("判定跟随规则声明的席位 ID 而不是固定字面量", () => {
    const content = contentWith({
      seatId: "seat.relocated",
      factions: [{ factionId: "faction-a", playerSeat: "seat.relocated" }],
    });
    expect(holdsOperationalSeat(content, "faction-a")).toBe(true);
  });
});

describe("controlsWatergate", () => {
  const content = contentWith({
    seatId: "seat.commune",
    factions: [
      { factionId: "faction-seat", playerSeat: "seat.commune" },
      { factionId: "faction-other" },
    ],
  });

  it("持有公社席的派系主体不依赖 campaign 即掌握水闸", () => {
    expect(controlsWatergate(content, null, "faction-seat")).toBe(true);
    expect(controlsWatergate(content, { playerId: "player-1", factionId: "faction-other" }, "faction-seat")).toBe(true);
  });

  it("campaign 玩家只在其派系持有公社席时掌握水闸", () => {
    expect(controlsWatergate(content, { playerId: "player-1", factionId: "faction-seat" }, "player-1")).toBe(true);
    expect(controlsWatergate(content, { playerId: "player-1", factionId: "faction-other" }, "player-1")).toBe(false);
  });

  it("既不持席也不是 campaign 玩家的主体不掌握水闸，未开局时玩家也不掌握", () => {
    expect(controlsWatergate(content, { playerId: "player-1", factionId: "faction-seat" }, "faction-other")).toBe(false);
    expect(controlsWatergate(content, { playerId: "player-1", factionId: "faction-seat" }, "player-2")).toBe(false);
    expect(controlsWatergate(content, null, "player-1")).toBe(false);
  });
});
