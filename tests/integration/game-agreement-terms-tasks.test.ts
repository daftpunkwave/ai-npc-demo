/**
 * 验证由任务推进的四类协议条款（交付、护送、救援、中继修复）的履约与违约路径。
 * 依赖真实 SQLite、世界/地图/行动/通信/协议模块与 authority；任务与期限都经 job 推进，履约证据经消费者处理。
 * 禁止直接修改协议聚合、绕过命令网关或放宽条款校验。
 */
import type { Json } from "@world-prism/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptAgreement,
  acceptTaskInvitation,
  advanceTicks,
  advanceToWithConsumers,
  dispatchTask,
  expectAgreement,
  expectTermBreached,
  expectTermFulfilled,
  PARTIAL_SUPPLY_TRANSPORT,
  playerAuth,
  proposeAgreement,
  proposeAsPlayer,
  readGameAggregate,
  strategicAuth,
  taskView,
  useStartedGameHarnesses,
  type GameHarness,
} from "./game-agreement-support";

const harness = useStartedGameHarnesses();

/** 玩家提出护送 r-gh-ps 的协议，由 human-independent 接受。 */
function proposeEscort(value: GameHarness, byTick: number): string {
  return proposeAsPlayer(value, "human-independent", ["player-1", "human-independent"], [
    { kind: "escort", obligorId: "human-independent", roadId: "r-gh-ps", byTick },
  ]);
}

/** 玩家提出群体救援协议，由 human-pacifist 接受。 */
function proposeRescue(value: GameHarness, byTick: number): string {
  return proposeAsPlayer(value, "human-pacifist", ["player-1", "human-pacifist"], [
    { kind: "rescue", obligorId: "human-pacifist", groupId: "grp-injured-migrants", byTick },
  ]);
}

/** 玩家提出中继修复协议，由 human-neutral 接受。 */
function proposeRepair(value: GameHarness, byTick: number): string {
  return proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
    { kind: "repair-relay", obligorId: "human-neutral", byTick },
  ]);
}

/** 玩家提出 10 点供给从 sp-commons 运到 sp-earth 的交付条款；其余当事人依次接受。 */
function proposeSupplyDelivery(
  value: GameHarness,
  obligorId: string,
  parties: readonly string[],
  byTick = 20,
): string {
  const agreementId = proposeAgreement(value, playerAuth(value), parties, [
    {
      kind: "deliver",
      obligorId,
      resource: "supply",
      amount: 10,
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      byTick,
    },
  ]);
  for (const party of parties) {
    if (party !== "player-1") {
      acceptAgreement(value, strategicAuth(value, party), agreementId);
    }
  }
  return agreementId;
}

/** 从 sp-commons 向 sp-earth 运送 10 点供给的标准任务载荷。 */
const SUPPLY_TRANSPORT: Json = {
  taskType: "transport",
  teamId: "team-commons",
  params: {
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    cargo: { supply: 10, energy: 0, medical: 0 },
  },
};

describe("协议条款履约", () => {
  it("deliver 只完成部分运输：byTick+1 记违约并保留已记进度", async () => {
    const value = await harness();
    const agreementId = proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
      {
        kind: "deliver",
        obligorId: "player-1",
        resource: "supply",
        amount: 10,
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        byTick: 20,
      },
    ]);
    const taskId = dispatchTask(value, playerAuth(value), PARTIAL_SUPPLY_TRANSPORT);
    // 含货物运输每经过一条道路 +1 tick，r-gh-or 行程 6 tick，出发 tick 1、完成 tick 7。
    advanceTicks(value, 1, 7, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    // 只记录部分进度，数量未达标前条款不履约。
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [], progress: [5] });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "player-1", progress: [5] });
  });

  it("escort 完成道路护送后条款履约、整份协议 fulfilled", async () => {
    const value = await harness();
    const agreementId = proposeEscort(value, 20);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [] });
    const taskId = dispatchTask(value, strategicAuth(value, "human-independent"), {
      taskType: "escort",
      teamId: "team-rubble",
      params: { roadId: "r-gh-ps" },
    });
    // team-rubble 已在道路端点，出发 tick 1、巡护 12 tick，名义完成 tick 13。
    advanceTicks(value, 1, 20, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 13 });
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "human-independent" });
  });

  it("escort 未在 byTick 前完成护送时 byTick+1 违约", async () => {
    const value = await harness();
    const agreementId = proposeEscort(value, 20);
    expectAgreement(value, agreementId, { status: "active" });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "human-independent" });
  });

  it("rescue 完成群体救援后条款履约、整份协议 fulfilled", async () => {
    const value = await harness();
    const agreementId = proposeRescue(value, 100);
    const taskId = dispatchTask(value, strategicAuth(value, "human-pacifist"), {
      taskType: "rescue",
      teamId: "team-truce",
      invitees: ["npc-muzhi"],
      params: {
        groupId: "grp-injured-migrants",
        toNodeId: "grayharbor",
        medicalStockpileId: "sp-truce",
      },
    });
    acceptTaskInvitation(value, "npc-muzhi", taskId);

    // 出发 tick 2，行程 4 tick（穆枝参与减 2），道路风险可能再延误 2 tick。
    advanceTicks(value, 1, 20, { consumers: true });
    const task = taskView(value, taskId);
    expect(task.status).toBe("completed");
    expect(task.completedAtTick).not.toBeNull();
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({ status: "rescued" });
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "human-pacifist" });
  });

  it("rescue 未在 byTick 前救援时 byTick+1 违约", async () => {
    const value = await harness();
    const agreementId = proposeRescue(value, 20);
    expectAgreement(value, agreementId, { status: "active" });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "human-pacifist" });
  });

  it("repair-relay 完成中继修复后条款履约、整份协议 fulfilled", async () => {
    const value = await harness();
    const agreementId = proposeRepair(value, 20);
    const taskId = dispatchTask(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      params: {
        target: "relay",
        energyStockpileId: "sp-commons",
        supplyStockpileId: "sp-commons",
      },
    });
    // team-commons 已在 grayharbor：出发 tick 1 即开始工作，6 tick 后完成。
    advanceTicks(value, 1, 7, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "human-neutral" });
  });

  it("repair-relay 未在 byTick 前完成修复时 byTick+1 违约", async () => {
    const value = await harness();
    const agreementId = proposeRepair(value, 20);
    expectAgreement(value, agreementId, { status: "active" });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "human-neutral" });
  });

  it("玩家为义务人时，其 campaign 派系队伍完成的有效运输计入履约", async () => {
    const value = await harness();
    const agreementId = proposeSupplyDelivery(value, "player-1", ["player-1", "human-neutral"]);
    // 派遣者是公社党魁而不是玩家本人，队伍属于 campaign 的 human-neutral 派系。
    const taskId = dispatchTask(value, strategicAuth(value, "human-neutral"), SUPPLY_TRANSPORT);
    advanceTicks(value, 1, 7, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "player-1" });
  });

  it("派系为义务人时，玩家派遣其派系队伍完成的有效运输计入履约", async () => {
    const value = await harness();
    const agreementId = proposeSupplyDelivery(value, "human-neutral", ["player-1", "human-neutral"]);
    const taskId = dispatchTask(value, playerAuth(value), SUPPLY_TRANSPORT);
    advanceTicks(value, 1, 7, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "human-neutral" });
  });

  it("普通角色为义务人时，本人派遣并完成的有效运输计入履约", async () => {
    const value = await harness();
    const agreementId = proposeSupplyDelivery(value, "npc-wenyuan", [
      "player-1",
      "npc-wenyuan",
      "human-neutral",
    ]);
    // 职责角色凭开局委托派遣本派系队伍，派遣者与义务人是同一主体。
    const taskId = dispatchTask(value, strategicAuth(value, "npc-wenyuan"), SUPPLY_TRANSPORT);
    advanceTicks(value, 1, 7, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "npc-wenyuan" });
  });

  it("普通角色为义务人时，派系主体派遣的任务不计入履约", async () => {
    const value = await harness();
    const agreementId = proposeSupplyDelivery(value, "npc-wenyuan", [
      "player-1",
      "npc-wenyuan",
      "human-neutral",
    ]);
    const taskId = dispatchTask(value, strategicAuth(value, "human-neutral"), SUPPLY_TRANSPORT);
    advanceTicks(value, 1, 20, { consumers: true });
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    // 普通角色不映射到所属派系，派系主体的派遣与执行不构成该角色的履约。
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [] });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "npc-wenyuan" });
  });
});
