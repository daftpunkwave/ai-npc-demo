/**
 * 验证服务端世界核心：campaign 初始化、暂停策略、每日结算、群体期限与章节评估。
 * 依赖真实 SQLite、内容包、游戏模块端口与 authority；测试不启动网络或 Agent。
 * 禁止用失真的夹具替代内容包，也不把未执行 job 的 tick 当作已结算。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, type Json } from "@ai-npc/contracts";
import { Authority, createSystemAuth } from "@ai-npc/authority";
import type { GameModulePorts, GameResourcesPort, ModuleBinder } from "@ai-npc/module-sdk";
import { createActionsContributor, createActionsPort } from "@ai-npc/mod-game-actions-standard";
import { createAgreementsContributor, createAgreementsPort } from "@ai-npc/mod-game-agreements-standard";
import { createCommsContributor, createCommsPort } from "@ai-npc/mod-game-comms-standard";
import { createMapContributor, createMapPort } from "@ai-npc/mod-game-map-six-nodes";
import { createResourcesContributor, createResourcesPort } from "@ai-npc/mod-game-resources-light";
import { createScenarioContributor, createScenarioPort } from "@ai-npc/mod-game-scenario-watergate";
import { createWorldContributor, createWorldPort } from "@ai-npc/mod-game-world-slg-light";
import {
  createGameHarness,
  createMemoryTx,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
  readGameEventTypes,
  setGameClock,
  strategicAuth,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (harness) => harness.dispose()));
});

async function harness(): Promise<GameHarness> {
  const created = await createGameHarness();
  active.push(created);
  return created;
}

function start(harnessValue: GameHarness): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return harnessValue.authority.commands.execute(
    playerAuth(harnessValue),
    gameCommandEnvelope(
      "campaign.start",
      { factionId: "human-neutral" },
      harnessValue.host.ids("cmd"),
    ),
  );
}

/**
 * 在同一测试存储上重建 authority，并包装资源端口以注入每日供给扣减失败。
 * 只用于让时钟步骤走可预测的失败路径；命令仍由主 harness 的 authority 提交。
 */
function authorityWithFailingDailyConsume(value: GameHarness, control: { fail: boolean }): Authority {
  const binder: ModuleBinder = (txFor) => {
    const resources = createResourcesPort(txFor, { scarceRatio: 0.3, surplusRatio: 1.2 });
    const failingResources = Object.assign(Object.create(resources) as GameResourcesPort, {
      consume: (input: Parameters<GameResourcesPort["consume"]>[0]) => {
        if (control.fail && input.reason === "daily-consumption") {
          return { ok: false as const, reasonCode: "insufficient-resource" as const };
        }
        return resources.consume(input);
      },
    });
    return {
      "game.map": createMapPort(txFor, value.gameContent, value.host.ids),
      "game.resources": failingResources,
      "game.world": createWorldPort(txFor, value.gameContent, value.host.ids),
      "game.comms": createCommsPort(txFor, value.gameContent, value.host.ids),
      "game.actions": createActionsPort(txFor),
      "game.agreements": createAgreementsPort(txFor),
      "game.scenario": createScenarioPort(txFor),
    } satisfies GameModulePorts;
  };
  const authority = new Authority({
    storage: value.storage,
    host: value.host,
    content: value.gameContent,
    moduleBinder: binder,
    allowDirectAgentCommands: true,
  });
  authority.registerModule(createMapContributor());
  authority.registerModule(createResourcesContributor());
  authority.registerModule(createWorldContributor());
  authority.registerModule(createCommsContributor());
  authority.registerModule(createActionsContributor());
  authority.registerModule(createAgreementsContributor());
  authority.registerModule(createScenarioContributor({ escalating: false }));
  return authority;
}

describe("世界核心", () => {
  it("campaign.start 初始化世界、库存与九份委托", async () => {
    const value = await harness();
    const receipt = start(value);
    expect(receipt.commandStatus).toBe("accepted");
    const events = readGameEventTypes(value);
    expect(events[0]).toBe("CampaignStarted");
    expect(events.filter((event) => event === "DelegationCreated")).toHaveLength(9);
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({
      factionId: "human-neutral",
      playerId: "player-1",
      status: "running",
    });
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({
      nodeId: "grayharbor",
      status: "idle",
    });
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({
      injured: 6,
      status: "waiting",
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      nodeId: "grayharbor",
      amount: { supply: 60, energy: 12, medical: 8 },
    });
  });

  it("暂停时拒绝政策命令但接受 campaign.start", async () => {
    const value = await harness();
    setGameClock(value, { worldTick: 0, mode: "paused" });
    const startReceipt = start(value);
    expect(startReceipt.commandStatus).toBe("accepted");
    const policyReceipt = value.authority.commands.execute(
      strategicAuth(value),
      gameCommandEnvelope(
        "policy.set",
        { key: "watergate.allocation", value: "rotation" },
        value.host.ids("cmd"),
      ),
    );
    expect(policyReceipt.commandStatus).toBe("rejected");
    expect(policyReceipt.reasonCode).toBe("paused");
  });

  it("每日结算按分配扣减指标与公共供给", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    const policy = value.authority.commands.execute(
      strategicAuth(value),
      gameCommandEnvelope(
        "policy.set",
        { key: "watergate.allocation", value: "rotation" },
        value.host.ids("cmd"),
      ),
    );
    expect(policy.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 24, mode: "running" });
    value.authority.clock.run(value.branchId);
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({
      "relay.stability": 40,
      "orchard.water": 48,
      "migration.safety": 50,
      "watergate.allocation": "rotation",
      lastDailyTick: 24,
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 54, energy: 12, medical: 8 },
    });
    expect(readGameEventTypes(value)).toContain("DayPassed");
  });

  it("每日供给扣减失败时回滚整次结算，重试成功后恰好提交一次 DayPassed", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const control = { fail: true };
    const authority = authorityWithFailingDailyConsume(value, control);
    setGameClock(value, { worldTick: 24, mode: "running" });

    expect(() => authority.clock.run(value.branchId)).toThrow(DomainError);
    expect(readGameEventTypes(value)).not.toContain("DayPassed");
    expect(readGameEventTypes(value)).not.toContain("MetersChanged");
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ lastDailyTick: null });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ amount: { supply: 60 } });

    // 修复注入条件后重试同一 tick：结算成功且只提交一次 DayPassed。
    control.fail = false;
    expect(authority.clock.run(value.branchId)).toBe(2);
    expect(readGameEventTypes(value).filter((type) => type === "DayPassed")).toHaveLength(1);
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ lastDailyTick: 24 });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ amount: { supply: 54 } });

    authority.clock.run(value.branchId);
    expect(readGameEventTypes(value).filter((type) => type === "DayPassed")).toHaveLength(1);
  });

  it("群体期限 job 将伤员标记为恶化并降低迁徙安全", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 48, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 48);
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({
      status: "worsened",
    });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({
      "migration.safety": 40,
    });
    expect(readGameEventTypes(value)).toContain("GroupWorsened");
  });

  it("章节评估写入 campaign 结果", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 168, mode: "running" });
    value.authority.clock.run(value.branchId);
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({
      status: "evaluated",
      outcome: "equilibrium",
    });
    expect(readGameEventTypes(value)).toContain("ChapterStageEvaluated");
  });

  it("非零启动 tick 时按 startTick 计算每日与章节边界", async () => {
    const value = await harness();
    setGameClock(value, { worldTick: 5, mode: "running" });
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 173, mode: "running" });
    value.authority.clock.run(value.branchId);
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({
      startTick: 5,
      status: "evaluated",
    });
    expect(readGameEventTypes(value)).toContain("DayPassed");
  });

  it("控制方可以通过政策命令关闭道路", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    const receipt = value.authority.commands.execute(
      strategicAuth(value, "human-independent"),
      gameCommandEnvelope(
        "policy.set",
        { key: "road.status:r-gh-ps", value: "closed" },
        value.host.ids("cmd"),
      ),
    );
    expect(receipt.commandStatus).toBe("accepted");
    expect(readGameEventTypes(value)).toContain("PolicyChanged");
  });

  it("七次每日结算后章节进入紧张状态", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    expect(value.authority.commands.execute(
      strategicAuth(value),
      gameCommandEnvelope(
        "policy.set",
        { key: "watergate.allocation", value: "rotation" },
        value.host.ids("cmd"),
      ),
    ).commandStatus).toBe("accepted");
    for (let day = 1; day <= 7; day += 1) {
      setGameClock(value, { worldTick: day * 24, mode: "running" });
      value.authority.clock.run(value.branchId);
    }
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({
      "relay.stability": 10,
      "orchard.water": 36,
      "migration.safety": 42,
      lastDailyTick: 168,
    });
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({
      status: "evaluated",
      outcome: "strained",
    });
    expect(readGameEventTypes(value).filter((event) => event === "DayPassed")).toHaveLength(7);
  });

  it("绑定端口写入的事件与版本进入命令回执", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    value.authority.registerModule({
      moduleId: "test.binder-accept",
      ownsAggregates: [],
      commands: [
        {
          type: "probe.ask",
          handler: (context) => {
            const ports = context.modules as {
              readonly "game.world": { moveCharacter(agentId: string, nodeId: string): unknown };
            };
            ports["game.world"].moveCharacter("npc-cenyan", "grayharbor");
            return { kind: "accepted" };
          },
        },
      ],
    });
    const receipt = value.authority.commands.execute(
      createSystemAuth(value.worldId, value.branchId),
      gameCommandEnvelope("probe.ask", { probeId: "prb-000000000001", agentId: "npc-cenyan", askedBy: "player-1", question: "测试" }, value.host.ids("cmd")),
    );
    expect(receipt.commandStatus).toBe("accepted");
    expect(receipt.acceptedEventIds.length).toBeGreaterThan(0);
    expect(receipt.resultingVersions["character:npc-cenyan"]).toBeGreaterThan(0);
    expect(readGameAggregate(value, "character", "npc-cenyan")).toMatchObject({ nodeId: "grayharbor" });
  });

  it("绑定端口在同一事务内写入，拒绝时整体回滚", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    value.authority.registerModule({
      moduleId: "test.binder",
      ownsAggregates: [],
      commands: [
        {
          type: "probe.ask",
          handler: (context) => {
            const ports = context.modules as {
              readonly "game.world": { moveCharacter(agentId: string, nodeId: string): unknown };
            };
            ports["game.world"].moveCharacter("npc-cenyan", "grayharbor");
            return { kind: "rejected", reasonCode: "task-not-cancellable", safeMessage: "回滚测试" };
          },
        },
      ],
    });
    const before = readGameAggregate(value, "character", "npc-cenyan");
    const receipt = value.authority.commands.execute(
      createSystemAuth(value.worldId, value.branchId),
      gameCommandEnvelope("probe.ask", { probeId: "prb-000000000002", agentId: "npc-cenyan", askedBy: "player-1", question: "测试" }, value.host.ids("cmd")),
    );
    expect(receipt.commandStatus).toBe("rejected");
    expect(readGameAggregate(value, "character", "npc-cenyan")).toEqual(before);
    expect(readGameEventTypes(value)).not.toContain("CharacterMoved");
  });
});

describe("世界端口", () => {
  it("能读取初始化后的角色与队伍", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const content = value.gameContent;
    const capture: Json[] = [];
    value.storage.transact((tx) => {
      const world = createWorldPort(() => ({
        ...createMemoryTx(),
        worldTick: 0,
        get: (type, id) => {
          const row = tx.branch(value.branchId).table("aggregate_state").get({ aggregate_type: type, aggregate_id: id });
          return row === null ? null : { version: Number(row["version"]), state: row["state_json"] as never };
        },
        list: (type) =>
          tx.branch(value.branchId).table("aggregate_state").list({ aggregate_type: type }).map((row) => ({
            id: String(row["aggregate_id"]),
            version: Number(row["version"]),
            state: row["state_json"] as never,
          })),
      }), content, value.host.ids);
      capture.push(world.character("npc-cenyan") as unknown as Json);
      capture.push(world.team("team-commons") as unknown as Json);
      capture.push(world.drawAuthority("player-1", "sp-commons") as unknown as Json);
      capture.push(world.drawAuthority("human-neutral", "sp-commons") as unknown as Json);
    });
    expect(capture[0]).toMatchObject({ agentId: "npc-cenyan", nodeId: "pass" });
    expect(capture[1]).toMatchObject({ teamId: "team-commons", status: "idle" });
    expect(capture[2]).toMatchObject({ kind: "delegation" });
    expect(capture[3]).toMatchObject({ kind: "owner" });
  });
});
