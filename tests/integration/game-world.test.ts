/**
 * 验证服务端世界核心：campaign 初始化、暂停策略、每日结算、群体期限与章节评估。
 * 依赖真实 SQLite、内容包、游戏模块端口与 authority；测试不启动网络或 Agent。
 * 禁止用失真的夹具替代内容包，也不把未执行 job 的 tick 当作已结算。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, type Json } from "@world-prism/contracts";
import { Authority, createScopedWorldTxFactory, createSystemAuth } from "@world-prism/authority";
import { gameModuleIds, type GameModulePorts, type GameResourcesPort, type ModuleBinder } from "@world-prism/module-sdk";
import { createActionsContributor, createActionsPort } from "@world-prism/mod-game-actions-standard";
import { createAgreementsContributor, createAgreementsPort } from "@world-prism/mod-game-agreements-standard";
import { createCommsContributor, createCommsPort } from "@world-prism/mod-game-comms-standard";
import { createMapContributor, createMapPort } from "@world-prism/mod-game-map-six-nodes";
import { createResourcesContributor, createResourcesPort } from "@world-prism/mod-game-resources-light";
import { createScenarioContributor, createScenarioPort } from "@world-prism/mod-game-scenario-watergate";
import { createWorldContributor, createWorldPort } from "@world-prism/mod-game-world-slg-light";
import {
  createGameHarness,
  createMemoryTx,
  gameCommandEnvelope,
  playerAuth,
  readAggregateOnBranch,
  readGameAggregate,
  readGameEvents,
  readGameEventTypes,
  seedEmptySandboxBranch,
  seedSandboxBranch,
  setGameClock,
  strategicAuth,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (harness) => harness.dispose()));
});

async function harness(options: Parameters<typeof createGameHarness>[0] = {}): Promise<GameHarness> {
  const created = await createGameHarness(options);
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
    const map = createMapPort(txFor, value.gameContent, value.host.ids);
    const world = createWorldPort(txFor, value.gameContent, value.host.ids);
    const comms = createCommsPort(
      () => txFor(gameModuleIds.comms),
      value.gameContent,
      value.host.ids,
      world,
    );
    const actions = createActionsPort(txFor);
    return {
      "game.map": map,
      "game.resources": failingResources,
      "game.world": world,
      "game.comms": comms,
      "game.actions": actions,
      "game.agreements": createAgreementsPort(
        () => txFor(gameModuleIds.agreements),
        { actions, comms, world, map },
        value.gameContent.factions,
      ),
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
      playerAuth(value),
      gameCommandEnvelope(
        "policy.set",
        { key: "watergate.allocation", value: "rotation" },
        value.host.ids("cmd"),
      ),
    );
    expect(policyReceipt.commandStatus).toBe("rejected");
    expect(policyReceipt.reasonCode).toBe("paused");
    // 内容包只启用公社席；其余四个开局不进入 campaign.start。
    const disabledStart = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("campaign.start", { factionId: "human-pacifist" }, value.host.ids("cmd")),
    );
    expect(disabledStart.commandStatus).toBe("rejected");
    expect(disabledStart.reasonCode).toBe("unknown-faction");
    // 其他派系党魁没有公社水闸授权；即使世界已开局也按 no-authority 拒绝。
    setGameClock(value, { worldTick: 0, mode: "running" });
    const otherReceipt = value.authority.commands.execute(
      strategicAuth(value, "human-pacifist"),
      gameCommandEnvelope(
        "policy.set",
        { key: "watergate.allocation", value: "rotation" },
        value.host.ids("cmd"),
      ),
    );
    expect(otherReceipt.commandStatus).toBe("rejected");
    expect(otherReceipt.reasonCode).toBe("no-authority");
  });

  it("每日结算按分配扣减指标与公共供给", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    const policy = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "policy.set",
        { key: "watergate.allocation", value: "rotation" },
        value.host.ids("cmd"),
      ),
    );
    expect(policy.commandStatus).toBe("accepted");
    expect(policy.result).toEqual({ oldValue: "harbor-first", newValue: "rotation" });
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

  it("章节评估按已提交事实统计协议，同协议多条款只计一次违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const propose = (terms: readonly Json[]): ReturnType<GameHarness["authority"]["commands"]["execute"]> =>
      value.authority.commands.execute(
        playerAuth(value),
        gameCommandEnvelope("agreement.propose", { parties: ["player-1", "human-neutral"], terms: [...terms] }, value.host.ids("cmd")),
      );
    const acceptByNeutral = (agreementId: string): ReturnType<GameHarness["authority"]["commands"]["execute"]> =>
      value.authority.commands.execute(
        strategicAuth(value, "human-neutral"),
        gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
      );
    const deliverTerm = (resource: "supply" | "energy", byTick: number): Json => ({
      kind: "deliver",
      obligorId: "player-1",
      resource,
      amount: resource === "supply" ? 10 : 5,
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      byTick,
    });

    // 履约：tick 168 完成的运输；事件消费者尚未追平也要计入。
    const delivered = propose([deliverTerm("supply", 168)]);
    expect(delivered.commandStatus).toBe("accepted");
    const deliveredId = (delivered.result as { readonly agreementId: string }).agreementId;
    expect(acceptByNeutral(deliveredId).commandStatus).toBe("accepted");

    // 违约：同一协议两条水闸条款被一次政策变更命中，按协议只计 1 份违约。
    const watered = propose([
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 20 },
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 40 },
    ]);
    expect(watered.commandStatus).toBe("accepted");
    const wateredId = (watered.result as { readonly agreementId: string }).agreementId;
    expect(acceptByNeutral(wateredId).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 5, mode: "running" });
    const policy = value.authority.commands.execute(
      strategicAuth(value),
      gameCommandEnvelope("policy.set", { key: "watergate.allocation", value: "rotation" }, value.host.ids("cmd")),
    );
    expect(policy.commandStatus).toBe("accepted");
    value.authority.consumers.run(value.branchId);
    expect(readGameAggregate(value, "agreement", wateredId)).toMatchObject({ status: "breached", breachedTerms: [0, 1] });

    // 未满足：条款期限未到且没有履约事实，不计。
    setGameClock(value, { worldTick: 12, mode: "running" });
    const pending = propose([deliverTerm("energy", 180)]);
    expect(pending.commandStatus).toBe("accepted");
    const pendingId = (pending.result as { readonly agreementId: string }).agreementId;
    expect(acceptByNeutral(pendingId).commandStatus).toBe("accepted");
    // 未生效：只提出、未接受，不计。
    expect(propose([deliverTerm("energy", 180)]).commandStatus).toBe("accepted");

    // 运输在 tick 168 抵达；出发 job 按到期 tick 执行，完成 job 与章节评估同一 tick。
    setGameClock(value, { worldTick: 161, mode: "running" });
    const dispatch = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "task.dispatch",
        {
          taskType: "transport",
          teamId: "team-commons",
          params: { fromStockpileId: "sp-commons", toStockpileId: "sp-earth", cargo: { supply: 10, energy: 0, medical: 0 } },
        },
        value.host.ids("cmd"),
      ),
    );
    expect(dispatch.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 162, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 162);
    setGameClock(value, { worldTick: 168, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 168);
    value.authority.clock.run(value.branchId);

    const chapters = readGameEvents(value).filter((event) => event.type === "ChapterStageEvaluated");
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.payload).toMatchObject({ fulfilledCount: 1, breachedCount: 1 });
    // 两份计数只来自协议模块的同步统计，世界不再保留事件累计副本。
    expect(
      value.storage.transact((tx) =>
        tx.branch(value.branchId).table("aggregate_state").count({ aggregate_type: "chapter-stats" }),
      ),
    ).toBe(0);
  });

  it("开局前已推进时钟时 campaign.start 被拒且不写入 campaign", async () => {
    const value = await harness();
    setGameClock(value, { worldTick: 5, mode: "running" });
    const receipt = start(value);
    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("world-tick-not-zero");
    expect(readGameAggregate(value, "campaign", "campaign")).toBeNull();
    expect(readGameEventTypes(value)).not.toContain("CampaignStarted");
  });

  it("t0 开局后日结与章节评估落在绝对 tick 24 与 168", async () => {
    const value = await harness();
    const started = start(value);
    expect(started.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "campaign", "campaign")).toMatchObject({ startTick: 0 });
    setGameClock(value, { worldTick: 24, mode: "running" });
    value.authority.clock.run(value.branchId);
    setGameClock(value, { worldTick: 168, mode: "running" });
    value.authority.clock.run(value.branchId);
    const events = readGameEvents(value);
    // tick 168 按规则先做第七笔日结，再做序章评估。
    expect(events.filter((event) => event.type === "DayPassed").map((event) => event.worldTick)).toEqual([24, 168]);
    expect(
      events.filter((event) => event.type === "ChapterStageEvaluated").map((event) => event.worldTick),
    ).toEqual([168]);
    const chapter = events.find((event) => event.type === "ChapterStageEvaluated");
    // t168 交接按内容初值重建六种城市资源，序章已发生的消耗不回写。
    expect(chapter?.payload).toMatchObject({
      cityResources: {
        energy: 140,
        materials: 160,
        food: 120,
        supply: 60,
        medical: 40,
        water: 72,
      },
    });
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
    expect(receipt.result).toEqual({ oldValue: "open", newValue: "closed" });
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
    // 通信贡献已注册真实 probe.ask，且该命令只允许沙盒分支；这里用无通信贡献的装配 +
    // 沙盒分支演示模块绑定器自身的写入路径，命令处理器由本用例提供。
    const value = await harness({ withCommsContributor: false });
    expect(start(value).commandStatus).toBe("accepted");
    const sandboxBranchId = seedSandboxBranch(value);
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
            ports["game.world"].moveCharacter("npc-wenzhao", "pass");
            return { kind: "accepted" };
          },
        },
      ],
    });
    const receipt = value.authority.commands.execute(
      createSystemAuth(value.worldId, sandboxBranchId),
      gameCommandEnvelope("probe.ask", { probeId: "p-probe-1", agentId: "npc-wenzhao", askedBy: "player-1", question: "测试" }, value.host.ids("cmd")),
    );
    expect(receipt.commandStatus).toBe("accepted");
    expect(receipt.acceptedEventIds.length).toBeGreaterThan(0);
    expect(receipt.resultingVersions["character:npc-wenzhao"]).toBeGreaterThan(0);
    expect(readAggregateOnBranch(value, sandboxBranchId, "character", "npc-wenzhao")).toMatchObject({ nodeId: "pass" });
  });

  it("绑定端口在同一事务内写入，拒绝时整体回滚", async () => {
    const value = await harness({ withCommsContributor: false });
    expect(start(value).commandStatus).toBe("accepted");
    const sandboxBranchId = seedSandboxBranch(value);
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
            ports["game.world"].moveCharacter("npc-wenzhao", "pass");
            return { kind: "rejected", reasonCode: "task-not-cancellable", safeMessage: "回滚测试" };
          },
        },
      ],
    });
    const before = readGameAggregate(value, "character", "npc-wenzhao");
    const receipt = value.authority.commands.execute(
      createSystemAuth(value.worldId, sandboxBranchId),
      gameCommandEnvelope("probe.ask", { probeId: "p-probe-2", agentId: "npc-wenzhao", askedBy: "player-1", question: "测试" }, value.host.ids("cmd")),
    );
    expect(receipt.commandStatus).toBe("rejected");
    expect(readGameAggregate(value, "character", "npc-wenzhao")).toEqual(before);
    expect(readGameEventTypes(value)).not.toContain("CharacterMoved");
  });

  it("模块越权写入未声明的聚合被拒绝，且不留下回执或部分状态", async () => {
    const value = await harness({ withCommsContributor: false });
    expect(start(value).commandStatus).toBe("accepted");
    const sandboxBranchId = seedEmptySandboxBranch(value);
    value.authority.registerModule({
      moduleId: "test.scope",
      ownsAggregates: [],
      commands: [
        {
          type: "probe.ask",
          handler: (context) => {
            // 该模块没有声明 character，WorldTx 必须拒绝这次写入。
            context.tx.put("character", "npc-wenzhao", { agentId: "npc-wenzhao" });
            return { kind: "accepted" };
          },
        },
      ],
    });
    const characterBefore = readGameAggregate(value, "character", "npc-wenzhao");
    const receiptCount = () =>
      value.storage.transact((tx) => tx.branch(sandboxBranchId).table("command_receipts").list()).length;
    const receiptsBefore = receiptCount();
    expect(() =>
      value.authority.commands.execute(
        createSystemAuth(value.worldId, sandboxBranchId),
        gameCommandEnvelope(
          "probe.ask",
          { probeId: "p-probe-3", agentId: "npc-wenzhao", askedBy: "player-1", question: "越权写入" },
          value.host.ids("cmd"),
        ),
      ),
    ).toThrowError(/不能写入聚合类型 character/);
    expect(readGameAggregate(value, "character", "npc-wenzhao")).toEqual(characterBefore);
    expect(receiptCount()).toBe(receiptsBefore);
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
      capture.push(world.character("npc-wenzhao") as unknown as Json);
      capture.push(world.team("team-commons") as unknown as Json);
      capture.push(world.drawAuthority("player-1", "sp-commons") as unknown as Json);
      capture.push(world.drawAuthority("human-neutral", "sp-commons") as unknown as Json);
    });
    expect(capture[0]).toMatchObject({ agentId: "npc-wenzhao", nodeId: "grayharbor" });
    expect(capture[1]).toMatchObject({ teamId: "team-commons", status: "idle" });
    expect(capture[2]).toMatchObject({ kind: "delegation" });
    expect(capture[3]).toMatchObject({ kind: "owner" });
  });

  it("绑定作用域按模块声明的 ownsAggregates 授予，未注册模块明确失败", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    value.storage.transact((tx) => {
      const txFor = createScopedWorldTxFactory({
        registry: value.authority.registry,
        storageTx: tx,
        worldId: value.worldId,
        branchId: value.branchId,
        worldTick: 0,
        principalId: "system",
        correlationId: (moduleId) => `test:${moduleId}`,
        host: value.host,
      });
      // 世界模块读取自己声明的角色聚合。
      expect(txFor(gameModuleIds.world).get("character", "npc-wenzhao")).not.toBeNull();
      // 通信模块没有声明 character，越权读取直接失败。
      expect(() => txFor(gameModuleIds.comms).get("character", "npc-wenzhao")).toThrowError(DomainError);
      // 未注册模块没有作用域声明，必须明确失败而不是获得默认权限。
      expect(() => txFor("game.missing")).toThrowError(/未注册/);
    });
  });
});
