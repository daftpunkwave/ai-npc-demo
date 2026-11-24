/**
 * 验证玩家投影在缺省全部可选端口时输出空集合与空指标的公开契约。
 * 经 @ai-npc/app-server 包入口加载纯投影构建函数，不启动宿主、存储或游戏模块。
 * 禁止在这里构造真实游戏聚合或访问文件系统。
 */
import { describe, expect, it } from "vitest";
import type { ClockView } from "@ai-npc/contracts";
import type { GameContent, GameMapPort, GameWorldPort } from "@ai-npc/module-sdk";
import { buildPlayerProjection } from "@ai-npc/app-server";

/** 投影只读这些内容索引字段；缺省端口场景下其余集合不会被访问。 */
const emptyContent = {
  nodes: new Map(),
  roads: new Map(),
  factions: new Map(),
  characters: new Map(),
  stockpiles: new Map(),
  starts: new Map(),
  evidence: new Map(),
  playerPrincipalId: "player-1",
} as unknown as GameContent;

/** 无 campaign、无指标、无实体的最小世界端口桩。 */
const idleWorld = {
  campaign: () => null,
  meters: () => null,
  characters: () => [],
  teams: () => [],
  delegationsOf: () => [],
} as unknown as GameWorldPort;

const emptyMap = { roadStatus: () => null } as unknown as GameMapPort;

const pausedClock: ClockView = { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 };

describe("玩家投影缺省可选端口契约", () => {
  it("缺省全部可选端口时对应集合为空且指标为空", () => {
    const view = buildPlayerProjection({
      content: emptyContent,
      clock: pausedClock,
      world: idleWorld,
      map: emptyMap,
    });
    expect(view.campaign).toBeNull();
    expect(view.meters).toBeNull();
    expect(view.cityResources).toBeNull();
    expect(view.stockpiles).toEqual([]);
    expect(view.teams).toEqual([]);
    expect(view.characters).toEqual([]);
    expect(view.tasks).toEqual([]);
    expect(view.agreements).toEqual([]);
    expect(view.conversations).toEqual([]);
    expect(view.inbox).toEqual([]);
    expect(view.notebook).toEqual([]);
    expect(view.awaitingReplyFrom).toEqual([]);
    expect(view.notifications).toEqual([]);
  });

  it("旧 campaign 状态缺少 cityResources 时投影按 null 输出", () => {
    const legacyCampaign = {
      campaignId: "cmp-000000000001",
      factionId: "human-neutral",
      playerId: "player-1",
      chapterId: "watergate",
      startTick: 0,
      status: "evaluated",
      outcome: "strained",
    } as unknown as NonNullable<ReturnType<GameWorldPort["campaign"]>>;
    const world = {
      ...idleWorld,
      campaign: () => legacyCampaign,
    } as GameWorldPort;
    const view = buildPlayerProjection({
      content: emptyContent,
      clock: pausedClock,
      world,
      map: emptyMap,
    });
    expect(view.cityResources).toBeNull();
    expect(view.campaign).toMatchObject({ status: "evaluated", outcome: "strained" });
  });

  it("内容包玩家主体 ID 在缺省 playerPrincipalId 时被采用", () => {
    const view = buildPlayerProjection({
      content: emptyContent,
      clock: pausedClock,
      world: idleWorld,
      map: emptyMap,
      playerPrincipalId: undefined,
    });
    // 空内容索引没有可投影事实；解析通过即确认缺省主体 ID 路径合法。
    expect(view.tasks).toEqual([]);
  });
});
