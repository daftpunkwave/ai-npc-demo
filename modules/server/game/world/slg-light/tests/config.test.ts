/**
 * 验证世界模块配置解析及其对章节评估边界的影响。
 * 依赖公开模块定义、解析后的配置与确定性测试事务。
 * 禁止绕过模块创建过程断言配置后的章节边界。
 */
import { describe, expect, it } from "vitest";
import type { GameModulePorts, GameRuleContributor, HandlerContext } from "@ai-npc/module-sdk";
import { campaignStateSchema, metersStateSchema } from "../src/state";
import { worldConfigSchema, worldModuleDefinition } from "../src/definition";
import { createWorldModuleInput, TestWorldTx } from "./support";

describe("world module configuration", () => {
  it("applies the default and rejects invalid chapter lengths", async () => {
    expect(worldConfigSchema.parse({})).toEqual({ chapterLengthTicks: 168 });
    await expect(worldModuleDefinition.create(createWorldModuleInput({ chapterLengthTicks: 0 }))).rejects.toThrow();
  });

  it("uses the configured chapter length for evaluation", async () => {
    const instance = await worldModuleDefinition.create(
      createWorldModuleInput({ chapterLengthTicks: 5 }),
    );
    const port = instance.port as {
      readonly contributor: GameRuleContributor<GameModulePorts, unknown>;
    };
    const chapterStep = port.contributor.clockSteps?.find(
      (step) => step.stepId === "world.chapter-evaluation",
    );
    expect(chapterStep).toBeDefined();

    const tx = new TestWorldTx(5);
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
    const result = chapterStep?.handler(
      {
        tx,
        modules: {
          "game.agreements": {
            countsAsOf: () => ({ fulfilled: 0, breached: 0 }),
          },
        },
      } as unknown as HandlerContext<GameModulePorts, unknown>,
      5,
    );

    expect(result).toEqual({ stopClock: true });
    expect(tx.get<unknown>("campaign", "campaign")?.state).toMatchObject({
      status: "evaluated",
    });
  });
});
