/**
 * 验证世界端口章节评估的触发权限、未初始化与惰性计数契约。
 * 依赖内存事务夹具、公共契约的 DomainError 与最小内容索引桩。
 * 禁止在这里绕过权限校验构造评估结果或访问真实存储。
 */
import { DomainError } from "@ai-npc/contracts";
import type { AgreementCounts, GameContent } from "@ai-npc/module-sdk";
import { describe, expect, it } from "vitest";
import { createWorldPort } from "../src/port";
import { TestWorldTx, createTestHost } from "./support";

/** 评估的权限与时机判定不读取实体内容，最小桩只补端口实现访问的集合字段。 */
const emptyContent = {
  nodes: new Map(),
  factions: new Map(),
  characters: new Map(),
  stockpiles: new Map(),
  evidence: new Map(),
} as unknown as GameContent;

const noCounts = (): AgreementCounts => ({ fulfilled: 0, breached: 0 });

describe("章节评估权限与惰性计数", () => {
  it("未授权调用方触发章节评估时立即失败", () => {
    const port = createWorldPort(() => new TestWorldTx(0), emptyContent, createTestHost().ids, {
      chapterLengthTicks: 168,
      allowChapterEvaluation: false,
    });
    expect(() => port.evaluateChapter(noCounts)).toThrow(DomainError);
    expect(() => port.evaluateChapter(noCounts)).toThrow(
      "章节评估只能由协议模块的章节终点时钟步骤或宿主触发",
    );
  });

  it("无 campaign 状态时不评估也不读取协议计数", () => {
    let countsRead = false;
    const port = createWorldPort(() => new TestWorldTx(0), emptyContent, createTestHost().ids);
    expect(
      port.evaluateChapter(() => {
        countsRead = true;
        return noCounts();
      }),
    ).toBeUndefined();
    expect(countsRead).toBe(false);
  });

  it("未到章节长度时不评估也不读取协议计数", () => {
    let countsRead = false;
    const tx = new TestWorldTx(100);
    tx.put("campaign", "campaign", {
      campaignId: "cmp-000000000001",
      factionId: "human-neutral",
      playerId: "player-1",
      chapterId: "ch-000000000001",
      startTick: 0,
      status: "running",
      outcome: null,
    });
    const port = createWorldPort(() => tx, emptyContent, createTestHost().ids);
    expect(
      port.evaluateChapter(() => {
        countsRead = true;
        return noCounts();
      }),
    ).toBeUndefined();
    expect(countsRead).toBe(false);
  });
});
