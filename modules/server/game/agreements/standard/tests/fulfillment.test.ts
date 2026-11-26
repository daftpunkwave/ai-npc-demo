/**
 * 核心职责：验证协议主体到派系的统一映射，以及「实际行为人是否代表义务人」的判定边界。
 * 交互契约：直接调用履约判定纯函数，注入派系 ID 集合与 campaign 快照，不依赖存储、端口或事务。
 * 约束与禁忌：禁止放宽普通角色的自身主体语义，也不得让普通角色代表其所属派系。
 */
import type { CampaignView } from "@world-prism/module-sdk";
import { describe, expect, it } from "vitest";
import { actorRepresentsObligor, resolvePrincipalFaction } from "../src/fulfillment";

const factions = new Map<string, unknown>([
  ["human-neutral", {}],
  ["human-independent", {}],
]);

const campaign: CampaignView = {
  campaignId: "cmp-000000000001",
  factionId: "human-neutral",
  playerId: "player-1",
  chapterId: "watergate",
  startTick: 0,
  status: "running",
  outcome: null,
  cityResources: null,
};

const factionOfPrincipal = (principalId: string): string | null =>
  resolvePrincipalFaction(principalId, factions, campaign);

describe("协议主体派系映射", () => {
  it("派系主体归属自身派系", () => {
    expect(factionOfPrincipal("human-neutral")).toBe("human-neutral");
    expect(factionOfPrincipal("human-independent")).toBe("human-independent");
  });

  it("当前 campaign 玩家归属 campaign.factionId", () => {
    expect(factionOfPrincipal("player-1")).toBe("human-neutral");
  });

  it("普通角色与未知主体不映射派系", () => {
    expect(factionOfPrincipal("npc-wenyuan")).toBeNull();
    expect(factionOfPrincipal("ghost-principal")).toBeNull();
  });

  it("campaign 未开局时玩家不映射派系", () => {
    expect(resolvePrincipalFaction("player-1", factions, null)).toBeNull();
  });
});

describe("行为人代表义务人的判定", () => {
  it("同一主体始终代表义务人", () => {
    expect(actorRepresentsObligor("npc-wenyuan", "npc-wenyuan", factionOfPrincipal)).toBe(true);
    expect(actorRepresentsObligor("human-neutral", "human-neutral", factionOfPrincipal)).toBe(true);
  });

  it("派系主体与当前 campaign 玩家互相代表", () => {
    expect(actorRepresentsObligor("player-1", "human-neutral", factionOfPrincipal)).toBe(true);
    expect(actorRepresentsObligor("human-neutral", "player-1", factionOfPrincipal)).toBe(true);
  });

  it("普通角色不能代表其所属派系，派系主体也不能代表普通角色", () => {
    expect(actorRepresentsObligor("npc-wenyuan", "human-neutral", factionOfPrincipal)).toBe(false);
    expect(actorRepresentsObligor("human-neutral", "npc-wenyuan", factionOfPrincipal)).toBe(false);
  });

  it("不同派系与未知主体之间互不代表", () => {
    expect(actorRepresentsObligor("human-independent", "human-neutral", factionOfPrincipal)).toBe(false);
    expect(actorRepresentsObligor("ghost-principal", "player-1", factionOfPrincipal)).toBe(false);
    expect(actorRepresentsObligor("ghost-principal", "ghost-principal", factionOfPrincipal)).toBe(true);
  });
});
