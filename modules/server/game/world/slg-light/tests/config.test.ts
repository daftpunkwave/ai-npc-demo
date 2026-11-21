/**
 * 验证世界模块配置解析及其对章节评估边界的影响。
 * 依赖公开模块定义、解析后的配置、模块端口绑定与确定性测试事务。
 * 禁止绕过模块创建过程断言配置后的章节边界，或让非协议调用方触发章节评估。
 */
import { describe, expect, it } from "vitest";
import type { GameContent, GameWorldPort, GamePortBindContext } from "@ai-npc/module-sdk";
import { DomainError } from "@ai-npc/contracts";
import { campaignStateSchema, metersStateSchema } from "../src/state";
import { worldConfigSchema, worldModuleDefinition } from "../src/definition";
import { createTestHost, createWorldModuleInput, TestWorldTx } from "./support";

type WorldModulePort = {
  readonly bind: (
    txFor: () => unknown,
    content: GameContent,
    ids: (prefix: string) => string,
    context: GamePortBindContext,
  ) => unknown;
};

/** 写入可评估的 campaign 与指标状态，返回对应事务。 */
function seededTransaction(worldTick: number): TestWorldTx {
  const tx = new TestWorldTx(worldTick);
  tx.put("campaign", "campaign", campaignStateSchema.parse({
    campaignId: "cmp-000000000001",
    factionId: "human-neutral",
    playerId: "player-1",
    chapterId: "chapter-watergate",
    startTick: 0,
    status: "running",
    outcome: null,
  }));
  tx.put("meters", "meters", metersStateSchema.parse({
    "relay.stability": 50,
    "orchard.water": 50,
    "migration.safety": 50,
    "watergate.allocation": "harbor-first",
    triggered: [],
    lastDailyTick: null,
  }));
  return tx;
}

async function worldPortFor(
  chapterLengthTicks: number,
  tx: TestWorldTx,
  caller: { readonly moduleId: string | null; readonly provides: readonly string[] },
): Promise<GameWorldPort> {
  const instance = await worldModuleDefinition.create(
    createWorldModuleInput({ chapterLengthTicks }),
  );
  const port = instance.port as WorldModulePort;
  return port.bind(
    () => tx,
    {} as unknown as GameContent,
    createTestHost().ids,
    { ports: {}, callerModuleId: caller.moduleId, callerProvides: caller.provides },
  ) as GameWorldPort;
}

const agreementsCaller = { moduleId: "game.agreements.standard", provides: ["game.agreements"] };

describe("world module configuration", () => {
  it("applies the default and rejects invalid chapter lengths", async () => {
    expect(worldConfigSchema.parse({})).toEqual({ chapterLengthTicks: 168 });
    await expect(worldModuleDefinition.create(createWorldModuleInput({ chapterLengthTicks: 0 }))).rejects.toThrow();
  });

  it("uses the configured chapter length for evaluation", async () => {
    const tx = seededTransaction(5);
    const world = await worldPortFor(5, tx, agreementsCaller);

    expect(world.evaluateChapter(() => ({ fulfilled: 0, breached: 0 }))).toEqual({ stopClock: true });
    expect(tx.get<unknown>("campaign", "campaign")?.state).toMatchObject({
      status: "evaluated",
    });
  });

  it("rejects chapter evaluation from callers other than the agreements provider or host", async () => {
    const tx = seededTransaction(5);
    const world = await worldPortFor(5, tx, {
      moduleId: "game.actions.standard",
      provides: ["game.actions"],
    });

    expect(() => world.evaluateChapter(() => ({ fulfilled: 0, breached: 0 }))).toThrow(DomainError);
    expect(tx.get<unknown>("campaign", "campaign")?.state).toMatchObject({ status: "running" });
  });
});
