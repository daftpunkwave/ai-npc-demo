/**
 * 验证首章剧情卡调度、触发、效果与升级版节奏。
 * 依赖真实 SQLite、内容包、世界/通信/剧情模块与 authority；不启动网络。
 * 禁止直接调用卡片效果或跳过 scenario.card job。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  operatorAuth,
  readGameAggregate,
  readGameEvents,
  setGameClock,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

async function harness(escalating = false): Promise<GameHarness> {
  return createTrackedGameHarness(active, { scenarioEscalating: escalating });
}

function types(value: GameHarness): readonly string[] {
  return readGameEvents(value).map((event) => event.type);
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

  it("运营可发布草稿、撤回并应用覆盖与补偿", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    value.storage.transact((tx) => {
      tx.branch(value.branchId).table("aggregate_state").put({
        aggregate_type: "scenario-card",
        aggregate_id: "card-draft",
        version: 0,
        state_json: { cardId: "card-draft", version: 1, status: "draft", triggerAtTick: 0, note: "draft" },
      });
    });
    const publish = value.authority.commands.execute(
      operatorAuth(value),
      gameCommandEnvelope("scenario.publish", { cardId: "card-draft", version: 1, triggerAtTick: 5 }, value.host.ids("cmd")),
    );
    expect(publish.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", "card-draft")).toMatchObject({ status: "published", triggerAtTick: 5 });
    const withdraw = value.authority.commands.execute(
      operatorAuth(value),
      gameCommandEnvelope("scenario.withdraw", { cardId: "card-draft" }, value.host.ids("cmd")),
    );
    expect(withdraw.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "scenario-card", "card-draft")).toMatchObject({ status: "withdrawn" });
    const override = value.authority.commands.execute(
      operatorAuth(value),
      gameCommandEnvelope(
        "scenario.override",
        { effects: [{ kind: "meter-set", meter: "relay.stability", value: 20 }], note: "调试覆盖" },
        value.host.ids("cmd"),
      ),
    );
    expect(override.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "relay.stability": 20 });
    const compensate = value.authority.commands.execute(
      operatorAuth(value),
      gameCommandEnvelope(
        "scenario.compensate",
        { cardId: "card-relay-alarm", effects: [{ kind: "stockpile-adjust", stockpileId: "sp-commons", delta: { supply: -1 }, reason: "补偿" }], note: "补偿" },
        value.host.ids("cmd"),
      ),
    );
    expect(compensate.commandStatus).toBe("accepted");
    expect(readGameEvents(value).some((event) => event.type === "ScenarioCompensationApplied")).toBe(true);
  });
});
