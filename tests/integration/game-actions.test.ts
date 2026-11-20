/**
 * 验证任务派遣、邀请、运输完成、救援、修复、侦察与取消回滚。
 * 依赖真实 SQLite、世界/通信/行动/协议模块、内容包与 authority；不启动网络。
 * 禁止用固定任务状态替代规则结算。
 */
import type { AuthContext, Json } from "@ai-npc/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptTaskInvitation,
  advanceTo,
  cancelTask,
  dispatchTask,
  executeCommand,
  gameEventsOf,
  operatorAuth,
  PARTIAL_SUPPLY_TRANSPORT,
  playerAuth,
  proposeAndAccept,
  readGameAggregate,
  readGameEventAudience,
  readGameEvents,
  setGameClock,
  strategicAuth,
  taskView,
  useStartedGameHarnesses,
  type GameHarness,
  type Receipt,
} from "./game-agreement-support";

const harness = useStartedGameHarnesses();

/** 以指定主体提交 task.dispatch；返回回执，由调用方断言接受或拒绝。 */
function dispatchAs(value: GameHarness, auth: AuthContext, payload: Json): Receipt {
  return executeCommand(value, auth, "task.dispatch", payload);
}

/** 玩家从灰港向果园运输 10 点供给的标准载荷。 */
const SUPPLY_TRANSPORT: Json = {
  taskType: "transport",
  teamId: "team-commons",
  params: {
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    cargo: { supply: 10, energy: 0, medical: 0 },
  },
};

/** 以星际势力派遣 team-star 修复中继；不需要供给库存点。 */
function dispatchStarRepair(value: GameHarness): string {
  return dispatchTask(value, strategicAuth(value, "species-extraterrestrial"), {
    taskType: "repair",
    teamId: "team-star",
    departAfterTicks: 1,
    params: { target: "relay", energyStockpileId: "sp-star", supplyStockpileId: null },
  });
}

/** 读取分支事件时间线（类型与提交 tick），用于断言事件顺序与同一提交。 */
function eventTimeline(value: GameHarness): readonly { readonly type: string; readonly worldTick: number }[] {
  return value.storage.transact((tx) =>
    tx
      .all("SELECT type, world_tick FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC", [value.branchId])
      .map((row) => ({ type: String(row["type"]), worldTick: Number(row["world_tick"]) })),
  );
}

/** 任务相关的 ResourcesConsumed 事件。 */
function consumedOf(value: GameHarness, taskId: string): ReturnType<typeof readGameEvents> {
  return gameEventsOf(value, "ResourcesConsumed").filter(
    (event) => (event.payload as { readonly taskId?: string }).taskId === taskId,
  );
}

type ResourceTriple = { readonly supply: number; readonly energy: number; readonly medical: number };

/**
 * 直接改写库存预留明细，用于注入可预测的第二个扣减或释放失败。
 * 只改测试分支的聚合状态，仍由规则处理器决定是否提交或回滚。
 */
function injectReservation(
  value: GameHarness,
  stockpileId: string,
  reserved: ResourceTriple,
  reservations: readonly { readonly taskId: string; readonly amount: ResourceTriple }[],
): void {
  value.storage.transact((tx) => {
    const table = tx.branch(value.branchId).table("aggregate_state");
    const row = table.get({ aggregate_type: "stockpile", aggregate_id: stockpileId });
    if (row === null) {
      throw new Error(`库存 ${stockpileId} 不存在`);
    }
    const state = row["state_json"] as Record<string, unknown>;
    const details = reservations.map((entry) => ({
      taskId: entry.taskId,
      amount: { supply: entry.amount.supply, energy: entry.amount.energy, medical: entry.amount.medical },
    }));
    table.put({ ...row, state_json: { ...state, reserved, reservations: details } });
  });
}

/** 取消指定前缀的已调度 job，用于把修复材料留到完成 job 再结算。 */
function cancelScheduledJobs(value: GameHarness, prefix: string): void {
  value.storage.transact((tx) => {
    const table = tx.branch(value.branchId).table("jobs");
    for (const row of table.list({ status: "scheduled" })) {
      if (String(row["idempotency_key"]).startsWith(prefix)) {
        table.put({ ...row, status: "cancelled" });
      }
    }
  });
}

/** 读取分支 job 的幂等键、状态与到期 tick。 */
function jobStates(value: GameHarness): readonly {
  readonly idempotencyKey: string;
  readonly status: string;
  readonly dueTick: number;
}[] {
  return value.storage.transact((tx) =>
    tx
      .branch(value.branchId)
      .table("jobs")
      .list({})
      .map((row) => ({
        idempotencyKey: String(row["idempotency_key"]),
        status: String(row["status"]),
        dueTick: Number(row["due_tick"]),
      })),
  );
}

/** 读取委托聚合的余额与上限。 */
function delegationBalance(
  value: GameHarness,
  delegationId: string,
): { readonly remaining: ResourceTriple; readonly limit: ResourceTriple } {
  const state = readGameAggregate(value, "delegation", delegationId);
  if (state === null) {
    throw new Error(`委托 ${delegationId} 不存在`);
  }
  return state as unknown as { readonly remaining: ResourceTriple; readonly limit: ResourceTriple };
}

describe("任务行动", () => {
  it("玩家运输 10 供给：预留、路线、完成转移与委托扣减", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, playerAuth(value), SUPPLY_TRANSPORT);
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ reserved: { supply: 10 } });
    expect(readGameEventAudience(value, "TaskDispatched")).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
    ]);
    const dispatchedAudience = JSON.stringify(readGameEventAudience(value, "TaskDispatched"));
    expect(dispatchedAudience).not.toContain("public");
    expect(dispatchedAudience).not.toContain("human-independent");
    advanceTo(value, 1);
    expect(taskView(value, taskId)).toMatchObject({ status: "running", departTick: 1 });
    const departed = gameEventsOf(value, "TaskDeparted");
    expect(departed).toHaveLength(1);
    expect(departed[0]?.payload).toMatchObject({ route: ["r-gh-or"], nominalCompletionTick: 7 });
    expect(departed[0]?.audience).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
      { kind: "node", nodeId: "grayharbor" },
    ]);
    advanceTo(value, 7);
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ amount: { supply: 50 } });
    expect(readGameAggregate(value, "stockpile", "sp-earth")).toMatchObject({ amount: { supply: 30 } });
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ nodeId: "orchard", status: "idle" });
    expect(gameEventsOf(value, "TaskCompleted")).toHaveLength(1);
    expect(readGameEventAudience(value, "TaskCompleted")).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
      { kind: "node", nodeId: "orchard" },
    ]);
  });

  it("侦察任务按道路风险抽样，延误时先通知再完成", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, strategicAuth(value, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      params: { nodeId: "archive" },
    });
    advanceTo(value, 1);
    advanceTo(value, 20);
    expect(taskView(value, taskId)).toMatchObject({ status: "completed" });
    const delayed = gameEventsOf(value, "TaskDelayed");
    if (delayed.length > 0) {
      expect(delayed[0]?.payload).toMatchObject({ taskId, cause: "road-risk" });
    }
    expect(readGameAggregate(value, "team", "team-rubble")).toMatchObject({ nodeId: "archive", status: "idle" });
  });

  it("任务取消释放预留并恢复委托与队伍", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, playerAuth(value), SUPPLY_TRANSPORT);
    const cancel = cancelTask(value, playerAuth(value), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "cancelled" });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ reserved: { supply: 0 } });
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ status: "idle" });
    expect(readGameEventAudience(value, "TaskCancelled")).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
    ]);
  });

  it("救援邀请穆枝、预留医疗并在完成时救出群体", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, strategicAuth(value, "human-pacifist"), {
      taskType: "rescue",
      teamId: "team-truce",
      invitees: ["npc-muzhi"],
      params: { groupId: "grp-injured-migrants", toNodeId: "grayharbor", medicalStockpileId: "sp-truce" },
    });
    expect(readGameAggregate(value, "stockpile", "sp-truce")).toMatchObject({ reserved: { medical: 6 } });
    expect(readGameEventAudience(value, "TaskDispatched")).toEqual([
      { kind: "principals", ids: ["human-pacifist", "npc-muzhi"] },
      { kind: "faction", factionId: "human-pacifist" },
    ]);
    expect(readGameEventAudience(value, "TaskInvitationIssued")).toEqual([
      { kind: "principals", ids: ["npc-muzhi", "human-pacifist"] },
    ]);
    expect(gameEventsOf(value, "TaskInvitationIssued")).toHaveLength(1);
    acceptTaskInvitation(value, "npc-muzhi", taskId);
    expect(readGameEventAudience(value, "TaskInvitationAnswered")).toEqual([
      { kind: "principals", ids: ["human-pacifist", "npc-muzhi"] },
    ]);
    advanceTo(value, 2);
    expect(readGameEventAudience(value, "TaskDeparted")).toEqual([
      { kind: "principals", ids: ["human-pacifist", "npc-muzhi"] },
      { kind: "faction", factionId: "human-pacifist" },
      { kind: "node", nodeId: "pass" },
    ]);
    advanceTo(value, 20);
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({
      status: "rescued",
      injured: 0,
      nodeId: "grayharbor",
    });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "migration.safety": 60 });
    expect(readGameAggregate(value, "stockpile", "sp-truce")).toMatchObject({ amount: { medical: 4 } });
  });

  it("未应答的邀请在出发时过期，受众只含受邀者与派遣者", async () => {
    const value = await harness();
    dispatchTask(value, strategicAuth(value, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      invitees: ["species-fauna"],
      params: { nodeId: "archive" },
    });
    advanceTo(value, 2);
    expect(readGameEventAudience(value, "TaskInvitationExpired")).toEqual([
      { kind: "principals", ids: ["species-fauna", "human-independent"] },
    ]);
  });

  it("出发路线失效时任务失败，受众只含派遣者与队伍派系", async () => {
    const value = await harness();
    dispatchTask(value, strategicAuth(value, "species-flora"), {
      taskType: "rescue",
      teamId: "team-flora",
      params: { groupId: "grp-injured-migrants", toNodeId: "orchard", medicalStockpileId: "sp-flora" },
    });
    const override = executeCommand(value, operatorAuth(value), "scenario.override", {
      effects: [
        { kind: "road-status-set", roadId: "r-gh-or", status: "closed" },
        { kind: "road-status-set", roadId: "r-wg-or", status: "closed" },
      ],
      note: "阻断果园对外路线",
    });
    expect(override.commandStatus).toBe("accepted");
    advanceTo(value, 1);
    expect(readGameEventAudience(value, "TaskFailed")).toEqual([
      { kind: "principals", ids: ["species-flora"] },
      { kind: "faction", factionId: "species-flora" },
    ]);
  });
});

describe("派遣校验顺序", () => {
  it("队伍忙且无授权时先报 no-authority", async () => {
    const value = await harness();
    expect(dispatchAs(value, playerAuth(value), SUPPLY_TRANSPORT).commandStatus).toBe("accepted");
    const unauthorized = dispatchAs(value, strategicAuth(value, "human-independent"), SUPPLY_TRANSPORT);
    expect(unauthorized.commandStatus).toBe("rejected");
    expect(unauthorized.reasonCode).toBe("no-authority");
    const busy = dispatchAs(value, playerAuth(value), SUPPLY_TRANSPORT);
    expect(busy.commandStatus).toBe("rejected");
    expect(busy.reasonCode).toBe("team-busy");
  });

  it("缺参数且队伍忙时先报 invalid-params", async () => {
    const value = await harness();
    expect(dispatchAs(value, playerAuth(value), SUPPLY_TRANSPORT).commandStatus).toBe("accepted");
    const missingStockpile = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      params: { fromStockpileId: "sp-commons", toStockpileId: "sp-nowhere", cargo: { supply: 10, energy: 0, medical: 0 } },
    });
    expect(missingStockpile.commandStatus).toBe("rejected");
    expect(missingStockpile.reasonCode).toBe("invalid-params");
    const zeroCargo = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      params: { fromStockpileId: "sp-commons", toStockpileId: "sp-earth", cargo: { supply: 0, energy: 0, medical: 0 } },
    });
    expect(zeroCargo.commandStatus).toBe("rejected");
    expect(zeroCargo.reasonCode).toBe("invalid-params");
  });

  it("缺参数且受邀者不可用时先报 invalid-params", async () => {
    const value = await harness();
    const missingStockpile = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      invitees: ["species-flora"],
      params: { fromStockpileId: "sp-commons", toStockpileId: "sp-nowhere", cargo: { supply: 10, energy: 0, medical: 0 } },
    });
    expect(missingStockpile.commandStatus).toBe("rejected");
    expect(missingStockpile.reasonCode).toBe("invalid-params");
    // 参数齐全后才轮到受邀者可用性：青枝在果园，不在运输出发节点，属于 participant-unavailable。
    const unavailable = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      invitees: ["species-flora"],
      params: { fromStockpileId: "sp-commons", toStockpileId: "sp-earth", cargo: { supply: 10, energy: 0, medical: 0 } },
    });
    expect(unavailable.commandStatus).toBe("rejected");
    expect(unavailable.reasonCode).toBe("participant-unavailable");
  });

  it("受邀者不可用且路线不可达时先报 participant-unavailable", async () => {
    const value = await harness();
    const override = executeCommand(value, operatorAuth(value), "scenario.override", {
      effects: [
        { kind: "road-status-set", roadId: "r-ps-ar", status: "closed" },
        { kind: "road-status-set", roadId: "r-gh-ar", status: "closed" },
      ],
      note: "封锁档案库对外路线",
    });
    expect(override.commandStatus).toBe("accepted");
    const unavailable = dispatchAs(value, strategicAuth(value, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      invitees: ["npc-wenyuan"],
      params: { nodeId: "archive" },
    });
    expect(unavailable.commandStatus).toBe("rejected");
    expect(unavailable.reasonCode).toBe("participant-unavailable");
    const unreachable = dispatchAs(value, strategicAuth(value, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      params: { nodeId: "archive" },
    });
    expect(unreachable.commandStatus).toBe("rejected");
    expect(unreachable.reasonCode).toBe("route-unavailable");
  });
});

describe("任务用时与参与者", () => {
  it("救援同一条路线：穆枝参与总用时减 2", async () => {
    const invited = await harness();
    const helperTaskId = dispatchTask(invited, strategicAuth(invited, "human-pacifist"), {
      taskType: "rescue",
      teamId: "team-truce",
      invitees: ["npc-muzhi"],
      departAfterTicks: 1,
      params: { groupId: "grp-injured-migrants", toNodeId: "grayharbor", medicalStockpileId: "sp-truce" },
    });
    acceptTaskInvitation(invited, "npc-muzhi", helperTaskId);
    advanceTo(invited, 1);
    const helperTask = taskView(invited, helperTaskId);
    expect(helperTask).toMatchObject({ status: "running", departTick: 1, route: ["r-gh-ps"] });
    expect(helperTask.nominalCompletionTick - 1).toBe(4);

    const plain = await harness();
    const plainTaskId = dispatchTask(plain, strategicAuth(plain, "human-pacifist"), {
      taskType: "rescue",
      teamId: "team-truce",
      departAfterTicks: 1,
      params: { groupId: "grp-injured-migrants", toNodeId: "grayharbor", medicalStockpileId: "sp-truce" },
    });
    advanceTo(plain, 1);
    const plainTask = taskView(plain, plainTaskId);
    expect(plainTask).toMatchObject({ status: "running", departTick: 1, route: ["r-gh-ps"] });
    expect(plainTask.nominalCompletionTick - 1).toBe(6);
  });

  it("侦察同一条路线：追风参与时每条道路减 1", async () => {
    const guided = await harness();
    const guidedTaskId = dispatchTask(guided, strategicAuth(guided, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      invitees: ["species-fauna"],
      departAfterTicks: 1,
      params: { nodeId: "orchard" },
    });
    acceptTaskInvitation(guided, "species-fauna", guidedTaskId);
    advanceTo(guided, 1);
    const guidedTask = taskView(guided, guidedTaskId);
    // 两条道路 r-wg-ps 与 r-wg-or 各减 1：行程 8，加观察 2，合计 10。
    expect(guidedTask).toMatchObject({ status: "running", route: ["r-wg-ps", "r-wg-or"] });
    expect(guidedTask.nominalCompletionTick - 1).toBe(10);

    const plain = await harness();
    const plainTaskId = dispatchTask(plain, strategicAuth(plain, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      departAfterTicks: 1,
      params: { nodeId: "orchard" },
    });
    advanceTo(plain, 1);
    const plainTask = taskView(plain, plainTaskId);
    expect(plainTask).toMatchObject({ status: "running", route: ["r-wg-ps", "r-wg-or"] });
    expect(plainTask.nominalCompletionTick - 1).toBe(12);
  });

  it("受邀角色不在任务工作节点时拒绝派遣", async () => {
    const value = await harness();
    const unavailable = dispatchAs(value, strategicAuth(value, "species-fauna"), {
      taskType: "scout",
      teamId: "team-fauna",
      invitees: ["npc-qilu"],
      departAfterTicks: 1,
      params: { nodeId: "watergate" },
    });
    expect(unavailable.commandStatus).toBe("rejected");
    expect(unavailable.reasonCode).toBe("participant-unavailable");
  });
});

describe("修复材料结算", () => {
  it("非 team-star 修复缺少供给库存点被拒，team-star 允许 null 并完成", async () => {
    const value = await harness();
    const missingSupply = dispatchAs(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-commons", supplyStockpileId: null },
    });
    expect(missingSupply.commandStatus).toBe("rejected");
    expect(missingSupply.reasonCode).toBe("invalid-params");

    const taskId = dispatchStarRepair(value);
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ reserved: { energy: 10 } });
    advanceTo(value, 1);
    expect(taskView(value, taskId)).toMatchObject({ status: "running", workStartTick: 6, materialsConsumed: false });
    advanceTo(value, 6);
    expect(taskView(value, taskId)).toMatchObject({ materialsConsumed: true });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({
      amount: { energy: 30 },
      reserved: { energy: 0 },
    });
    advanceTo(value, 12);
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 12 });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "relay.stability": 85 });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ amount: { energy: 30 } });
    expect(consumedOf(value, taskId)).toHaveLength(1);
  });

  it("非 team-star 修复预留能源 10 与供给 5，出发即在工作节点时当次结算一次", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-commons", supplyStockpileId: "sp-commons" },
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      reserved: { supply: 5, energy: 10 },
    });
    advanceTo(value, 1);
    expect(taskView(value, taskId)).toMatchObject({
      status: "running",
      workStartTick: 1,
      materialsConsumed: true,
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 55, energy: 2 },
      reserved: { supply: 0, energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(2);
    advanceTo(value, 7);
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 55, energy: 2 },
    });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "relay.stability": 70 });
    expect(consumedOf(value, taskId)).toHaveLength(2);
  });

  it("修复到达 grayharbor 前取消：释放预留且不消耗", async () => {
    const value = await harness();
    const taskId = dispatchStarRepair(value);
    advanceTo(value, 1);
    expect(taskView(value, taskId)).toMatchObject({ status: "running", workStartTick: 6 });
    setGameClock(value, { worldTick: 3, mode: "running" });
    const cancel = cancelTask(value, strategicAuth(value, "species-extraterrestrial"), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(taskView(value, taskId)).toMatchObject({ status: "cancelled", materialsConsumed: false });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({
      amount: { energy: 40 },
      reserved: { energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(0);
    advanceTo(value, 20);
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ amount: { energy: 40 } });
    expect(consumedOf(value, taskId)).toHaveLength(0);
  });

  it("修复开始工作后取消：材料恰好消耗一次且不退还，重试取消被拒", async () => {
    const value = await harness();
    const taskId = dispatchStarRepair(value);
    advanceTo(value, 1);
    advanceTo(value, 6);
    expect(taskView(value, taskId)).toMatchObject({ materialsConsumed: true });
    expect(consumedOf(value, taskId)).toHaveLength(1);

    setGameClock(value, { worldTick: 7, mode: "running" });
    const cancel = cancelTask(value, strategicAuth(value, "species-extraterrestrial"), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(taskView(value, taskId)).toMatchObject({ status: "cancelled" });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({
      amount: { energy: 30 },
      reserved: { energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(1);

    const retry = cancelTask(value, strategicAuth(value, "species-extraterrestrial"), taskId);
    expect(retry.commandStatus).toBe("rejected");
    expect(retry.reasonCode).toBe("task-not-cancellable");
    advanceTo(value, 20);
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ amount: { energy: 30 } });
    expect(consumedOf(value, taskId)).toHaveLength(1);
  });
});

describe("风险结果的公布时机", () => {
  const delayInjuryTransport = {
    taskType: "transport",
    teamId: "team-star",
    params: {
      fromStockpileId: "sp-star",
      toStockpileId: "sp-flora",
      cargo: { supply: 0, energy: 1, medical: 0 },
    },
  } as const;

  it("受伤只在完成事务内公布，延误通知只出现一次且完成 tick 正确", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, strategicAuth(value, "species-extraterrestrial"), {
      ...delayInjuryTransport,
      invitees: ["species-extraterrestrial"],
      departAfterTicks: 4,
    });
    acceptTaskInvitation(value, "species-extraterrestrial", taskId);

    advanceTo(value, 4);
    expect(taskView(value, taskId)).toMatchObject({
      status: "running",
      departTick: 4,
      nominalCompletionTick: 11,
      riskOutcome: { delayTicks: 2, injuredAgentIds: ["species-extraterrestrial"], teamInjured: false },
    });
    // 出发只写内部风险：不改变角色伤势，也不发 CharacterInjured。
    expect(readGameAggregate(value, "character", "species-extraterrestrial")).toMatchObject({ injuredUntilTick: null });
    expect(gameEventsOf(value, "TaskDeparted")).toHaveLength(1);
    expect(gameEventsOf(value, "CharacterInjured")).toHaveLength(0);

    advanceTo(value, 11);
    expect(taskView(value, taskId)).toMatchObject({ status: "running", delayNoticeSent: true });
    const delayed = gameEventsOf(value, "TaskDelayed");
    expect(delayed).toHaveLength(1);
    expect(delayed[0]?.payload).toMatchObject({ taskId, newCompletionTick: 13, cause: "road-risk" });
    expect(gameEventsOf(value, "CharacterInjured")).toHaveLength(0);

    advanceTo(value, 13);
    expect(gameEventsOf(value, "TaskDelayed")).toHaveLength(1);
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 13 });
    const injured = gameEventsOf(value, "CharacterInjured");
    expect(injured).toHaveLength(1);
    expect(injured[0]?.payload).toMatchObject({ agentId: "species-extraterrestrial", untilTick: 61, cause: "road-risk" });
    expect(readGameAggregate(value, "character", "species-extraterrestrial")).toMatchObject({ injuredUntilTick: 61 });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ amount: { energy: 39 } });
    expect(readGameAggregate(value, "stockpile", "sp-flora")).toMatchObject({ amount: { energy: 1 } });

    const timeline = eventTimeline(value);
    const departedIndex = timeline.findIndex((entry) => entry.type === "TaskDeparted");
    const injuredIndex = timeline.findIndex((entry) => entry.type === "CharacterInjured");
    const completedIndex = timeline.findIndex((entry) => entry.type === "TaskCompleted");
    expect(departedIndex).toBeGreaterThanOrEqual(0);
    expect(injuredIndex).toBeGreaterThan(departedIndex);
    expect(injuredIndex).toBeLessThan(completedIndex);
    expect(timeline[injuredIndex]?.worldTick).toBe(13);
    expect(timeline[completedIndex]?.worldTick).toBe(13);
  });

  it("队伍受伤时完成后进入 recovering，休整到完成 tick + 24", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, strategicAuth(value, "species-extraterrestrial"), {
      ...delayInjuryTransport,
      departAfterTicks: 4,
    });
    advanceTo(value, 4);
    expect(taskView(value, taskId)).toMatchObject({
      status: "running",
      riskOutcome: { delayTicks: 2, injuredAgentIds: [], teamInjured: true },
    });
    expect(readGameAggregate(value, "team", "team-star")).toMatchObject({ status: "traveling" });
    advanceTo(value, 11);
    expect(gameEventsOf(value, "TaskDelayed")).toHaveLength(1);
    advanceTo(value, 13);
    expect(taskView(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 13 });
    expect(readGameAggregate(value, "team", "team-star")).toMatchObject({
      status: "recovering",
      busyUntilTick: 37,
    });
    expect(gameEventsOf(value, "CharacterInjured")).toHaveLength(0);
  });
});

describe("任务资源写入失败的事务边界", () => {
  it("修复完成时第二个扣减失败：job 回滚、任务可重试，不提交 TaskFailed 或部分扣减", async () => {
    const value = await harness();
    // 先让 team-commons 运货到隘口，使修复需要先赶回灰港，工作与完成落在不同 job。
    dispatchTask(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-rubble",
        cargo: { supply: 1, energy: 0, medical: 0 },
      },
    });
    advanceTo(value, 1);
    advanceTo(value, 20);
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ nodeId: "pass", status: "idle" });

    const taskId = dispatchTask(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-commons", supplyStockpileId: "sp-commons" },
    });
    advanceTo(value, 21);
    const departed = readGameAggregate(value, "task", taskId) as unknown as {
      readonly status: string;
      readonly nominalCompletionTick: number;
      readonly riskOutcome: { readonly delayTicks: number };
    };
    expect(departed.status).toBe("running");
    const completionTick = departed.nominalCompletionTick + departed.riskOutcome.delayTicks;

    // 取消工作 job，让材料留到完成 job 结算；把供给预留挂到另一任务，
    // 使能源先扣成功、供给第二个扣减失败。预留总量与明细保持一致。
    cancelScheduledJobs(value, `task-work:${taskId}`);
    injectReservation(value, "sp-commons", { supply: 5, energy: 10, medical: 0 }, [
      { taskId, amount: { supply: 0, energy: 10, medical: 0 } },
      { taskId: "task-supply-blocker", amount: { supply: 5, energy: 0, medical: 0 } },
    ]);
    // 先跑完 tick 26、30 的剧情卡 job，让失败调用只包含完成 job。
    advanceTo(value, 27);
    advanceTo(value, 31);
    if (departed.riskOutcome.delayTicks > 0) {
      advanceTo(value, departed.nominalCompletionTick);
      expect(gameEventsOf(value, "TaskDelayed")).toHaveLength(1);
    }

    const taskBefore = readGameAggregate(value, "task", taskId);
    const stockBefore = readGameAggregate(value, "stockpile", "sp-commons");
    const teamBefore = readGameAggregate(value, "team", "team-commons");
    const eventsBefore = readGameEvents(value).length;

    setGameClock(value, { worldTick: completionTick, mode: "running" });
    expect(() => value.authority.jobs.runDue(value.branchId, completionTick)).toThrow();

    expect(readGameAggregate(value, "task", taskId)).toEqual(taskBefore);
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toEqual(stockBefore);
    expect(readGameAggregate(value, "team", "team-commons")).toEqual(teamBefore);
    expect(readGameEvents(value)).toHaveLength(eventsBefore);
    expect(gameEventsOf(value, "TaskFailed")).toHaveLength(0);
    expect(consumedOf(value, taskId)).toHaveLength(0);
    expect(
      gameEventsOf(value, "TaskCompleted").filter(
        (event) => (event.payload as { readonly taskId?: string }).taskId === taskId,
      ),
    ).toHaveLength(0);
    expect(
      jobStates(value).some(
        (job) => job.idempotencyKey.startsWith(`task-complete:${taskId}`) && job.status === "scheduled",
      ),
    ).toBe(true);

    // 恢复正确的预留后重试同一完成 job：材料恰好扣一次，任务完成且没有 TaskFailed。
    injectReservation(value, "sp-commons", { supply: 5, energy: 10, medical: 0 }, [
      { taskId, amount: { supply: 5, energy: 10, medical: 0 } },
    ]);
    expect(value.authority.jobs.runDue(value.branchId, completionTick)).toBeGreaterThan(0);
    expect(taskView(value, taskId)).toMatchObject({
      status: "completed",
      materialsConsumed: true,
      completedAtTick: completionTick,
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 54, energy: 2 },
      reserved: { supply: 0, energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(2);
    expect(gameEventsOf(value, "TaskFailed")).toHaveLength(0);
    expect(
      gameEventsOf(value, "TaskCompleted").filter(
        (event) => (event.payload as { readonly taskId?: string }).taskId === taskId,
      ),
    ).toHaveLength(1);
  });

  it("取消时释放预留失败：命令 rejected，任务与库存保持原状态", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, playerAuth(value), SUPPLY_TRANSPORT);
    const draws = (readGameAggregate(value, "task", taskId) as unknown as {
      readonly delegationDraws: readonly { readonly delegationId: string }[];
    }).delegationDraws;
    expect(draws).toHaveLength(1);
    const delegationId = draws[0]!.delegationId;
    // 清空预留明细：释放 10 时找不到对应预留，资源端口返回 invalid-params。
    injectReservation(value, "sp-commons", { supply: 0, energy: 0, medical: 0 }, []);
    const taskBefore = readGameAggregate(value, "task", taskId);
    const stockBefore = readGameAggregate(value, "stockpile", "sp-commons");
    const balanceBefore = delegationBalance(value, delegationId).remaining;
    const eventsBefore = readGameEvents(value).length;

    const cancel = cancelTask(value, playerAuth(value), taskId);
    expect(cancel.commandStatus).toBe("rejected");
    expect(cancel.reasonCode).toBe("invalid-params");
    expect(readGameAggregate(value, "task", taskId)).toEqual(taskBefore);
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toEqual(stockBefore);
    expect(delegationBalance(value, delegationId).remaining).toEqual(balanceBefore);
    expect(readGameEvents(value)).toHaveLength(eventsBefore);
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ status: "assigned" });
  });

  it("取消时委托回补失败：命令 rejected，预留与任务保持原状态", async () => {
    const value = await harness();
    const taskId = dispatchTask(value, playerAuth(value), SUPPLY_TRANSPORT);
    const draws = (readGameAggregate(value, "task", taskId) as unknown as {
      readonly delegationDraws: readonly { readonly delegationId: string }[];
    }).delegationDraws;
    expect(draws).toHaveLength(1);
    // 删除记录中的委托：释放成功、回补失败，命令必须整体回滚。
    value.storage.transact((tx) =>
      tx
        .branch(value.branchId)
        .table("aggregate_state")
        .delete({ aggregate_type: "delegation", aggregate_id: draws[0]!.delegationId }),
    );
    const stockBefore = readGameAggregate(value, "stockpile", "sp-commons");
    const eventsBefore = readGameEvents(value).length;

    const cancel = cancelTask(value, playerAuth(value), taskId);
    expect(cancel.commandStatus).toBe("rejected");
    expect(cancel.reasonCode).toBe("invalid-params");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "pending" });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toEqual(stockBefore);
    expect(readGameEvents(value)).toHaveLength(eventsBefore);
  });

  it("委托回补只退回实际扣减的那笔，不按主体与库存点重选", async () => {
    const value = await harness();
    proposeAndAccept(
      value,
      strategicAuth(value, "human-neutral"),
      playerAuth(value),
      ["human-neutral", "player-1"],
      [
        {
          kind: "delegate",
          obligorId: "human-neutral",
          granteeId: "player-1",
          teamIds: ["team-commons"],
          stockpileId: "sp-commons",
          maxDraw: { supply: 7, energy: 0, medical: 0 },
          untilTick: 100,
        },
      ],
    );
    const playerDelegations = gameEventsOf(value, "DelegationCreated")
      .map((event) => event.payload as {
        readonly delegationId: string;
        readonly granteeId: string;
        readonly stockpileId: string | null;
      })
      .filter((payload) => payload.granteeId === "player-1" && payload.stockpileId === "sp-commons");
    expect(playerDelegations).toHaveLength(2);

    const taskId = dispatchTask(value, playerAuth(value), PARTIAL_SUPPLY_TRANSPORT);
    const draws = (readGameAggregate(value, "task", taskId) as unknown as {
      readonly delegationDraws: readonly {
        readonly delegationId: string;
        readonly stockpileId: string;
        readonly amount: ResourceTriple;
      }[];
    }).delegationDraws;
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ stockpileId: "sp-commons", amount: { supply: 5 } });
    const drawnId = draws[0]!.delegationId;
    const other = playerDelegations.find((payload) => payload.delegationId !== drawnId);
    expect(other).toBeDefined();
    const drawnBefore = delegationBalance(value, drawnId);
    expect(drawnBefore.remaining.supply).toBe(drawnBefore.limit.supply - 5);

    // 让另一笔同主体同库存委托的余额低于上限；旧实现按主体重查时可能退到它。
    const otherBefore = delegationBalance(value, other!.delegationId);
    value.storage.transact((tx) => {
      const table = tx.branch(value.branchId).table("aggregate_state");
      const row = table.get({ aggregate_type: "delegation", aggregate_id: other!.delegationId });
      if (row === null) {
        throw new Error("另一笔委托不存在");
      }
      const state = row["state_json"] as Record<string, unknown>;
      const remaining = state["remaining"] as ResourceTriple;
      table.put({
        ...row,
        state_json: {
          ...state,
          remaining: { ...remaining, supply: Math.max(0, remaining.supply - 3) },
        },
      });
    });
    const otherBalance = delegationBalance(value, other!.delegationId);

    // 取消前让被扣减的委托过期：旧实现会按主体与库存点重选到另一笔，新实现按记录回补。
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.storage.transact((tx) => {
      const table = tx.branch(value.branchId).table("aggregate_state");
      const row = table.get({ aggregate_type: "delegation", aggregate_id: drawnId });
      if (row === null) {
        throw new Error("被扣减的委托不存在");
      }
      table.put({
        ...row,
        state_json: { ...(row["state_json"] as Record<string, unknown>), untilTick: 0 },
      });
    });

    const cancel = cancelTask(value, playerAuth(value), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "cancelled" });
    expect(delegationBalance(value, drawnId).remaining.supply).toBe(drawnBefore.limit.supply);
    expect(delegationBalance(value, other!.delegationId).remaining).toEqual(otherBalance.remaining);
  });

  it("一笔任务可以按稳定顺序扣减多份委托并在取消时逐笔回补", async () => {
    const value = await harness();
    proposeAndAccept(
      value,
      strategicAuth(value, "human-neutral"),
      playerAuth(value),
      ["human-neutral", "player-1"],
      [
        {
          kind: "delegate",
          obligorId: "human-neutral",
          granteeId: "player-1",
          teamIds: ["team-commons"],
          stockpileId: "sp-commons",
          maxDraw: { supply: 3, energy: 0, medical: 0 },
          untilTick: 100,
        },
      ],
    );
    const delegationIds = gameEventsOf(value, "DelegationCreated")
      .map((event) => event.payload as {
        readonly delegationId: string;
        readonly granteeId: string;
        readonly stockpileId: string | null;
      })
      .filter((payload) => payload.granteeId === "player-1" && payload.stockpileId === "sp-commons")
      .map((payload) => payload.delegationId)
      .sort();
    expect(delegationIds).toHaveLength(2);

    const caps = new Map([
      [delegationIds[0]!, 2],
      [delegationIds[1]!, 3],
    ]);
    value.storage.transact((tx) => {
      const table = tx.branch(value.branchId).table("aggregate_state");
      for (const [delegationId, cap] of caps) {
        const row = table.get({ aggregate_type: "delegation", aggregate_id: delegationId });
        if (row === null) {
          throw new Error(`委托不存在: ${delegationId}`);
        }
        const state = row["state_json"] as Record<string, unknown>;
        table.put({
          ...row,
          state_json: {
            ...state,
            remaining: { supply: cap, energy: 0, medical: 0 },
            limit: { supply: cap, energy: 0, medical: 0 },
          },
        });
      }
    });

    const taskId = dispatchTask(value, playerAuth(value), PARTIAL_SUPPLY_TRANSPORT);
    const draws = (readGameAggregate(value, "task", taskId) as unknown as {
      readonly delegationDraws: readonly {
        readonly delegationId: string;
        readonly amount: ResourceTriple;
      }[];
    }).delegationDraws;
    expect(draws.map((draw) => draw.delegationId)).toEqual(delegationIds);
    expect(draws.reduce((total, draw) => total + draw.amount.supply, 0)).toBe(5);
    for (const delegationId of delegationIds) {
      expect(delegationBalance(value, delegationId).remaining.supply).toBe(0);
    }

    expect(cancelTask(value, playerAuth(value), taskId).commandStatus).toBe("accepted");
    for (const delegationId of delegationIds) {
      expect(delegationBalance(value, delegationId).remaining.supply).toBe(caps.get(delegationId));
    }
  });
});
