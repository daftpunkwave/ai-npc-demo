/**
 * 验证内容视图辅助的结构断言（含不是 Map 实例的 ReadonlyMap 实现）、运营席判定与水闸控制权判定。
 * 依赖合成的最小内容视图；不加载真实内容包，也不访问世界状态。
 * 禁止在本文件复制内容 schema 或写死具体内容包的 ID。
 */
import { describe, expect, it } from "vitest";
import type { GameContent } from "@world-prism/module-sdk";
import { controlsWatergate, holdsOperationalSeat, requireGameContent } from "../src/content-view";

/** 只实现 ReadonlyMap 接口、不继承 Map 的只读映射；代表内容索引的其他合法实现。 */
class DelegatingReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = new Map(entries);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void {
    this.#entries.forEach((value, key) => callback(value, key, this));
  }

  keys() {
    return this.#entries.keys();
  }

  values() {
    return this.#entries.values();
  }

  entries() {
    return this.#entries.entries();
  }

  [Symbol.iterator]() {
    return this.#entries[Symbol.iterator]();
  }
}

/** 具备全部 ReadonlyMap 成员的空集合普通对象；用例逐项删改以验证单项能力缺失。 */
function emptyMapLike(): Record<PropertyKey, unknown> {
  const empty: readonly never[] = [];
  return {
    size: 0,
    get: () => undefined,
    has: () => false,
    keys: () => empty.values(),
    values: () => empty.values(),
    entries: () => empty.values(),
    forEach: () => undefined,
    [Symbol.iterator]: () => empty.values(),
  };
}

/** 不经类型断言构造的完整内容视图；全部集合都是 DelegatingReadonlyMap。 */
function readonlyMapContent(): GameContent {
  return {
    nodes: new DelegatingReadonlyMap([["node-a", { nodeId: "node-a", name: "节点甲", x: 0, y: 0, facilities: [] }]]),
    roads: new DelegatingReadonlyMap([]),
    factions: new DelegatingReadonlyMap([
      ["faction-seat", { factionId: "faction-seat", name: "持席派系", kind: "human", playerSeat: "seat.commune" }],
    ]),
    characters: new DelegatingReadonlyMap([]),
    stockpiles: new DelegatingReadonlyMap([]),
    teams: new DelegatingReadonlyMap([]),
    groups: new DelegatingReadonlyMap([]),
    evidence: new DelegatingReadonlyMap([]),
    secrets: new DelegatingReadonlyMap([]),
    starts: new DelegatingReadonlyMap([]),
    scenarios: new DelegatingReadonlyMap([]),
    defaultScenario: "scenario-test",
    rules: {
      tasks: {
        capacitySupporter: { agentId: "supporter", capacityBonus: 5 },
        repairSupporter: { agentId: "supporter", stabilityBonus: 10 },
        rescueSupporter: { agentId: "supporter", durationDiscountTicks: 2 },
        scoutSupporter: { agentId: "supporter", travelDiscountPerRoad: 1 },
        escortSupporter: { agentId: "supporter", safetyBonus: 4 },
        universalGuide: { agentId: "guide", travelDiscountPerRoad: 1 },
        universalRepairer: { agentId: "repairer", stabilityBonus: 15, excludedTeamIds: [] },
        repairWorkNodeId: "node-a",
        energyOnlyRepairTeamIds: [],
        repairBaseStability: { standard: 25, energyOnly: 40 },
      },
      settlement: {
        dailySupplyStockpileId: "sp-test",
        dailySupplyAmount: 6,
        orchardMedicalStockpileId: "sp-test",
        orchardMedicalAmount: 5,
        migrationRoadId: "r-test",
        migrationPassageFactionId: "faction-seat",
      },
      watergateSeatId: "seat.commune",
    },
    notificationTexts: { invite: "邀请", deadline: "{window} 内到期", failedTask: "任务失败", crisis: "危急" },
    migrationRoads: [],
    medicalFacilities: [],
    playerNodeId: "node-a",
    playerPrincipalId: "player-1",
    chapterId: "chapter-test",
    initialMeters: {
      "relay.stability": 0,
      "orchard.water": 0,
      "migration.safety": 0,
      "watergate.allocation": "harbor-first",
    },
    dutyDelegations: [],
  };
}

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

  it("集合不是 Map 实例但实现 ReadonlyMap 时通过断言，读取辅助照常工作", () => {
    const content = readonlyMapContent();
    expect(content.factions).not.toBeInstanceOf(Map);
    expect(requireGameContent(content)).toBe(content);
    expect(holdsOperationalSeat(content, "faction-seat")).toBe(true);
    expect(controlsWatergate(content, { playerId: "player-1", factionId: "faction-seat" }, "player-1")).toBe(true);
    expect(controlsWatergate(content, null, "player-1")).toBe(false);
  });

  it("按键存值的普通对象不是 ReadonlyMap，被拒绝", () => {
    const content = readonlyMapContent();
    expect(() => requireGameContent({ ...content, factions: { "faction-seat": { factionId: "faction-seat" } } })).toThrow(
      /固定索引/,
    );
  });

  it("具备完整 ReadonlyMap 成员的普通对象通过断言", () => {
    expect(() => requireGameContent({ ...readonlyMapContent(), roads: emptyMapLike() })).not.toThrow();
  });

  it.each(["size", "get", "has", "keys", "values", "entries", "forEach", Symbol.iterator] as const)(
    "缺少 ReadonlyMap 成员 %s 的集合被拒绝",
    (member) => {
      const incomplete = emptyMapLike();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 用例逐项删除接口成员。
      delete incomplete[member];
      expect(() => requireGameContent({ ...readonlyMapContent(), roads: incomplete })).toThrow(/固定索引/);
    },
  );

  it("size 不是数字的集合被拒绝", () => {
    expect(() => requireGameContent({ ...readonlyMapContent(), roads: { ...emptyMapLike(), size: "0" } })).toThrow(
      /固定索引/,
    );
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
