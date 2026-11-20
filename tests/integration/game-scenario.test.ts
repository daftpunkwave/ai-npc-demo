/**
 * 验证首章剧情卡草稿、发布、触发、撤回、补偿、覆盖与污染标记。
 * 依赖真实 SQLite、内容包、世界/通信/剧情模块与 authority；不启动网络。
 * 禁止直接写卡片聚合代替领域命令，也不跳过 scenario.card job。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, CommandType, Json, ModuleCreateInput, StoragePort } from "@ai-npc/contracts";
import { scenarioRunStateSchema, type ScenarioRunState } from "@ai-npc/mod-game-scenario-watergate";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { createFakeHost } from "./authority-support";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  operatorAuth,
  readGameAggregate,
  readGameEvents,
  readGameEventAudience,
  setGameClock,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

/** 运营草稿卡 ID 与广播效果；内容包不包含该卡片，只经 scenario.draft 登记。 */
const DRAFT_CARD = "card-operator-brief";
const DRAFT_BROADCAST: Json = {
  kind: "broadcast",
  speakerId: "npc-shenli",
  text: "运营公告：中继检修提前完成。",
};
const SCENARIO_ID = "watergate-v1";

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

async function harness(escalating = false): Promise<GameHarness> {
  return createTrackedGameHarness(active, { scenarioEscalating: escalating });
}

function types(value: GameHarness): readonly string[] {
  return readGameEvents(value).map((event) => event.type);
}

function scenarioEvent(
  value: GameHarness,
  type: string,
  cardId: string,
): { readonly type: string; readonly payload: Json; readonly audience: Json } | undefined {
  return readGameEvents(value).find(
    (event) => event.type === type && (event.payload as { readonly cardId?: string }).cardId === cardId,
  );
}

function execute(value: GameHarness, type: CommandType, payload: Json): CommandReceipt {
  return value.authority.commands.execute(
    operatorAuth(value),
    gameCommandEnvelope(type, payload, value.host.ids("cmd")),
  );
}

function draftCommand(
  value: GameHarness,
  options: {
    readonly cardId?: string;
    readonly version?: number;
    readonly triggerAtTick?: number;
    readonly effects?: readonly Json[];
    readonly note?: string;
  } = {},
): CommandReceipt {
  return execute(value, "scenario.draft", {
    cardId: options.cardId ?? DRAFT_CARD,
    version: options.version ?? 1,
    triggerAtTick: options.triggerAtTick ?? 4,
    effects: [...(options.effects ?? [DRAFT_BROADCAST])],
    note: options.note ?? "运营草稿",
  });
}

function publishCommand(
  value: GameHarness,
  triggerAtTick: number,
  cardId: string = DRAFT_CARD,
  version = 1,
): CommandReceipt {
  return execute(value, "scenario.publish", { cardId, version, triggerAtTick });
}

function withdrawCommand(value: GameHarness, cardId: string = DRAFT_CARD): CommandReceipt {
  return execute(value, "scenario.withdraw", { cardId });
}

function compensateCommand(value: GameHarness, cardId: string, effects: readonly Json[]): CommandReceipt {
  return execute(value, "scenario.compensate", { cardId, effects: [...effects], note: "补偿" });
}

function overrideCommand(value: GameHarness, effects: readonly Json[], note = "调试覆盖"): CommandReceipt {
  return execute(value, "scenario.override", { effects: [...effects], note });
}

function stockpileSupply(value: GameHarness, stockpileId: string): number {
  const state = readGameAggregate(value, "stockpile", stockpileId) as { readonly amount?: { readonly supply?: number } } | null;
  if (state?.amount?.supply === undefined) {
    throw new Error(`库存点 ${stockpileId} 没有 supply`);
  }
  return state.amount.supply;
}

/** 直接改写库存聚合的供给字段，用于构造可用量与预留的边界；同时写一条等额预留明细，保持聚合自身的预留校验成立。 */
function setStockpileSupply(
  value: GameHarness,
  stockpileId: string,
  next: { readonly amount: number; readonly reserved: number },
): void {
  value.storage.transact((tx) => {
    const table = tx.branch(value.branchId).table("aggregate_state");
    const row = table.get({ aggregate_type: "stockpile", aggregate_id: stockpileId });
    if (row === null) {
      throw new Error(`测试缺少库存聚合 ${stockpileId}`);
    }
    const state = row["state_json"] as Record<string, Json>;
    const amount = state["amount"] as Record<string, Json> | undefined;
    const reserved = state["reserved"] as Record<string, Json> | undefined;
    if (amount === undefined || reserved === undefined) {
      throw new Error(`库存点 ${stockpileId} 缺少 amount 或 reserved`);
    }
    amount["supply"] = next.amount;
    reserved["supply"] = next.reserved;
    state["reservations"] =
      next.reserved === 0 ? [] : [{ taskId: "task-fixture", amount: { supply: next.reserved, energy: 0, medical: 0 } }];
    table.put({ ...row, state_json: state, version: Number(row["version"]) + 1 });
  });
}

/** 最近一条 StockpileAdjusted 的 payload，用于断言实际扣减量。 */
function lastStockpileAdjustment(value: GameHarness): Json | undefined {
  const events = readGameEvents(value).filter((event) => event.type === "StockpileAdjusted");
  return events[events.length - 1]?.payload;
}

/** 用同一 dataDir 上的新存储连接读取持久化剧情运行状态，作为进程重启后读取的证据。 */
async function readPersistedRunState(dataDir: string, branchId: string, scenarioId: string): Promise<ScenarioRunState> {
  const host = createFakeHost();
  const signal = new AbortController().signal;
  const input: ModuleCreateInput = {
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal,
  };
  const instance = await storageModuleDefinition.create(input);
  await instance.start(signal);
  try {
    if (instance.port === undefined) {
      throw new Error("存储模块实例没有暴露端口");
    }
    const storage = instance.port as StoragePort;
    return storage.transact((tx) => {
      const row = tx.branch(branchId).table("aggregate_state").get({
        aggregate_type: "scenario-run",
        aggregate_id: scenarioId,
      });
      if (row === null) {
        throw new Error("持久化的剧情运行状态缺失");
      }
      return scenarioRunStateSchema.parse(row["state_json"]);
    });
  } finally {
    await instance.dispose();
  }
}

describe("剧情卡", () => {
  it("标准节奏在 atTick 2 触发中继警报并写入广播", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({ status: "published", triggerAtTick: 2 });
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({ status: "triggered" });
    const events = readGameEvents(value);
    expect(events.filter((event) => event.type === "ScenarioCardTriggered")).toHaveLength(1);
    expect(events.some((event) => event.type === "MessageSent")).toBe(true);
    expect(readGameEventAudience(value, "ScenarioCardTriggered")).toEqual([{ kind: "system" }]);
    expect(types(value)).not.toContain("ScenarioCardPublished");
  });

  it("升级版把 atTick 2 压缩为 tick 1", async () => {
    const value = await harness(true);
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({ triggerAtTick: 1 });
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({ status: "triggered" });
  });

  it("运营经草稿、发布命令登记卡片，到 tick 后触发并应用草稿效果", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const draft = draftCommand(value);
    expect(draft.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({
      cardId: DRAFT_CARD,
      version: 1,
      status: "draft",
      triggerAtTick: 4,
      note: "运营草稿",
    });
    expect(types(value)).not.toContain("ScenarioCardPublished");
    expect(publishCommand(value, 4, DRAFT_CARD, 2)).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "version-conflict",
    });
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({ status: "draft" });
    const publish = publishCommand(value, 4);
    expect(publish.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({ status: "published", triggerAtTick: 4 });
    expect(readGameEventAudience(value, "ScenarioCardPublished")).toEqual([{ kind: "system" }]);
    setGameClock(value, { worldTick: 4, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 4);
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({ status: "triggered" });
    expect(scenarioEvent(value, "ScenarioCardTriggered", DRAFT_CARD)).toBeDefined();
    const broadcast = readGameEvents(value).find(
      (event) =>
        event.type === "MessageSent" &&
        (event.payload as { readonly text?: string }).text === "运营公告：中继检修提前完成。",
    );
    expect(broadcast).toBeDefined();
    expect(broadcast?.audience).toEqual([{ kind: "public" }]);
  });

  it("拒绝非法草稿并保持零写入", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    expect(draftCommand(value, { triggerAtTick: 0 })).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "deadline-out-of-range",
    });
    expect(
      draftCommand(value, {
        effects: [{ kind: "stockpile-adjust", stockpileId: "sp-nowhere", delta: { supply: -1 }, reason: "无效引用" }],
      }),
    ).toMatchObject({ commandStatus: "rejected", reasonCode: "invalid-effect" });
    expect(draftCommand(value, { effects: [] })).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "invalid-params",
    });
    expect(draftCommand(value, { note: "" })).toMatchObject({ commandStatus: "rejected", reasonCode: "invalid-params" });
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toBeNull();
    expect(types(value)).not.toContain("ScenarioCardPublished");

    expect(draftCommand(value).commandStatus).toBe("accepted");
    expect(draftCommand(value, { version: 2 })).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "version-conflict",
    });
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({ version: 1, status: "draft" });

    const researcher = { ...operatorAuth(value), principalId: "researcher-1", kind: "researcher" as const, roles: ["researcher"] };
    expect(
      value.authority.commands.execute(
        researcher,
        gameCommandEnvelope(
          "scenario.draft",
          {
            cardId: "card-researcher-draft",
            version: 1,
            triggerAtTick: 6,
            effects: [DRAFT_BROADCAST],
            note: "研究员草稿",
          },
          value.host.ids("cmd"),
        ),
      ),
    ).toMatchObject({ commandStatus: "rejected", reasonCode: "no-authority" });
    expect(readGameAggregate(value, "scenario-card", "card-researcher-draft")).toBeNull();
  });

  it("拒绝重复发布与已触发发布，撤回后不再触发", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    expect(draftCommand(value, { triggerAtTick: 5 }).commandStatus).toBe("accepted");
    expect(publishCommand(value, 5).commandStatus).toBe("accepted");
    expect(publishCommand(value, 6)).toMatchObject({ commandStatus: "rejected", reasonCode: "card-not-draft" });
    expect(withdrawCommand(value).commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({ status: "withdrawn" });
    expect(publishCommand(value, 6)).toMatchObject({ commandStatus: "rejected", reasonCode: "card-not-draft" });

    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({ status: "triggered" });
    expect(publishCommand(value, 3, "card-relay-alarm")).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "card-not-draft",
    });

    setGameClock(value, { worldTick: 6, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 6);
    expect(readGameAggregate(value, "scenario-card", DRAFT_CARD)).toMatchObject({ status: "withdrawn" });
    const published = readGameEvents(value).filter(
      (event) =>
        event.type === "ScenarioCardPublished" &&
        (event.payload as { readonly cardId?: string }).cardId === DRAFT_CARD,
    );
    expect(published).toHaveLength(1);
    expect(scenarioEvent(value, "ScenarioCardTriggered", DRAFT_CARD)).toBeUndefined();
  });

  it("未触发或未登记的卡片补偿被拒且零写入", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    expect(draftCommand(value, { cardId: DRAFT_CARD, triggerAtTick: 5 }).commandStatus).toBe("accepted");
    const supplyBefore = stockpileSupply(value, "sp-commons");
    const compensationEffect: Json = {
      kind: "stockpile-adjust",
      stockpileId: "sp-commons",
      delta: { supply: -1 },
      reason: "补偿",
    };
    expect(compensateCommand(value, DRAFT_CARD, [compensationEffect])).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "invalid-effect",
    });
    expect(compensateCommand(value, "card-unknown", [compensationEffect])).toMatchObject({
      commandStatus: "rejected",
      reasonCode: "invalid-effect",
    });
    expect(stockpileSupply(value, "sp-commons")).toBe(supplyBefore);
    expect(types(value)).not.toContain("ScenarioCompensationApplied");
  });

  it("补偿已触发卡片时记录真实卡片版本并应用效果", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const supplyBefore = stockpileSupply(value, "sp-commons");
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({
      status: "triggered",
      version: 1,
    });
    const compensate = compensateCommand(value, "card-relay-alarm", [
      { kind: "stockpile-adjust", stockpileId: "sp-commons", delta: { supply: -1 }, reason: "补偿" },
    ]);
    expect(compensate.commandStatus).toBe("accepted");
    const event = scenarioEvent(value, "ScenarioCompensationApplied", "card-relay-alarm");
    expect(event?.payload).toEqual({ cardId: "card-relay-alarm", version: 1, note: "补偿" });
    expect(readGameEventAudience(value, "ScenarioCompensationApplied")).toEqual([{ kind: "system" }]);
    expect(stockpileSupply(value, "sp-commons")).toBe(supplyBefore - 1);
  });

  it("剧情卡定向消息投给玩家主体", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 26, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 26);

    const message = readGameEvents(value).find(
      (event) =>
        event.type === "MessageSent" &&
        (event.payload as { readonly fromId?: string }).fromId === "npc-guxun",
    );
    expect(message?.payload).toMatchObject({ to: ["player-1"], channel: "message", intentKind: "scenario" });
    const deliveries = (message?.payload as { readonly deliveries?: readonly { readonly principalId: string }[] })
      ?.deliveries;
    expect(deliveries?.map((delivery) => delivery.principalId)).toContain("player-1");
  });

  it("库存调整只扣可用量，预留不被击穿", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameAggregate(value, "scenario-card", "card-relay-alarm")).toMatchObject({ status: "triggered" });

    // 可用量 2（amount 5、reserved 3）：-10 的调整只扣 2，预留保持 3。
    setStockpileSupply(value, "sp-commons", { amount: 5, reserved: 3 });
    const partial = compensateCommand(value, "card-relay-alarm", [
      { kind: "stockpile-adjust", stockpileId: "sp-commons", delta: { supply: -10 }, reason: "受潮" },
    ]);
    expect(partial.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 3 },
      reserved: { supply: 3 },
    });
    expect(lastStockpileAdjustment(value)).toMatchObject({ stockpileId: "sp-commons", delta: { supply: -2 } });

    // 可用量为 0：效果按空操作完成，不提交零额调整事件。
    setStockpileSupply(value, "sp-commons", { amount: 3, reserved: 3 });
    const adjustedBefore = readGameEvents(value).filter((event) => event.type === "StockpileAdjusted").length;
    const empty = compensateCommand(value, "card-relay-alarm", [
      { kind: "stockpile-adjust", stockpileId: "sp-commons", delta: { supply: -10 }, reason: "受潮" },
    ]);
    expect(empty.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 3 },
      reserved: { supply: 3 },
    });
    expect(readGameEvents(value).filter((event) => event.type === "StockpileAdjusted")).toHaveLength(adjustedBefore);
  });

  it("覆盖成功后在同一事务标记污染，重启读取仍可见", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const override = overrideCommand(value, [{ kind: "meter-set", meter: "relay.stability", value: 20 }]);
    expect(override.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "relay.stability": 20 });
    const run = readGameAggregate(value, "scenario-run", SCENARIO_ID) as {
      readonly contaminated?: boolean;
      readonly contaminations?: readonly Json[];
    } | null;
    expect(run?.contaminated).toBe(true);
    expect(run?.contaminations).toHaveLength(1);
    expect(run?.contaminations?.[0]).toEqual({
      source: "scenario.override",
      note: "调试覆盖",
      tick: 0,
      effects: [{ kind: "meter-set", meter: "relay.stability", value: 20 }],
    });
    expect(readGameEventAudience(value, "ScenarioOverrideApplied")).toEqual([{ kind: "system" }]);

    const persisted = await readPersistedRunState(value.dataDir, value.branchId, SCENARIO_ID);
    expect(persisted.contaminated).toBe(true);
    expect(persisted.contaminations).toHaveLength(1);
    expect(persisted.contaminations[0]).toMatchObject({ source: "scenario.override", note: "调试覆盖", tick: 0 });
  });

  it("覆盖效果失败时回滚指标、事件与污染标记", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const metersBefore = readGameAggregate(value, "meters", "meters");
    const runBefore = readGameAggregate(value, "scenario-run", SCENARIO_ID);
    expect(() =>
      overrideCommand(value, [
        { kind: "meter-set", meter: "relay.stability", value: 20 },
        { kind: "road-status-set", roadId: "r-gh-void", status: "closed" },
      ]),
    ).toThrow(/覆盖道路/);
    expect(readGameAggregate(value, "meters", "meters")).toEqual(metersBefore);
    expect(readGameAggregate(value, "scenario-run", SCENARIO_ID)).toEqual(runBefore);
    expect(readGameAggregate(value, "road", "r-gh-void")).toBeNull();
    expect(types(value)).not.toContain("ScenarioOverrideApplied");
    expect(readGameEventAudience(value, "ScenarioOverrideApplied")).toBeNull();
  });

  it("卡片效果按事件字典公布世界事实与唤醒名单", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 144, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 144);
    const events = readGameEvents(value);
    const triggered = events.filter((event) => event.type === "ScenarioCardTriggered");
    expect(triggered).toHaveLength(9);
    for (const event of triggered) {
      expect(event.audience).toEqual([{ kind: "system" }]);
    }
    expect(readGameEventAudience(value, "WorldFactRecorded")).toEqual([{ kind: "node", nodeId: "watergate" }]);
    expect(readGameEventAudience(value, "RumorSpread")).toEqual([{ kind: "public" }]);
    expect(readGameEventAudience(value, "AgentsSummoned")).toEqual([
      {
        kind: "principals",
        ids: [
          "human-independent",
          "human-earth-alliance",
          "human-pacifist",
          "human-alien-accord",
          "human-neutral",
          "species-fauna",
          "species-flora",
          "species-extraterrestrial",
        ],
      },
    ]);
    const broadcasts = events.filter(
      (event) =>
        event.type === "MessageSent" &&
        (event.payload as { readonly channel?: string }).channel === "broadcast",
    );
    expect(broadcasts.length).toBeGreaterThan(0);
    for (const event of broadcasts) {
      expect(event.audience).toEqual([{ kind: "public" }]);
    }
  });
});
