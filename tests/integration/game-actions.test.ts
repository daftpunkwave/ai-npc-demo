/**
 * 验证任务派遣、邀请、运输完成、救援、修复、侦察与取消回滚。
 * 依赖真实 SQLite、世界/通信/行动/协议模块、内容包与 authority；不启动网络。
 * 禁止用固定任务状态替代规则结算。
 */
import type { AuthContext, Json } from "@ai-npc/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGameHarness,
  gameCommandEnvelope,
  operatorAuth,
  playerAuth,
  readGameAggregate,
  readGameEvents,
  readGameEventAudience,
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

type CommandResult = ReturnType<GameHarness["authority"]["commands"]["execute"]>;

/** 以指定主体提交 task.dispatch。 */
function dispatchAs(value: GameHarness, auth: AuthContext, payload: Json): CommandResult {
  return value.authority.commands.execute(
    auth,
    gameCommandEnvelope("task.dispatch", payload, value.host.ids("cmd")),
  );
}

/** 以指定角色回复任务邀请。 */
function respondAs(value: GameHarness, agentId: string, taskId: string, response: "accept" | "decline"): CommandResult {
  return value.authority.commands.execute(
    strategicAuth(value, agentId),
    gameCommandEnvelope("task.respond", { taskId, response }, value.host.ids("cmd")),
  );
}

/** 以指定主体取消任务。 */
function cancelAs(value: GameHarness, auth: AuthContext, taskId: string): CommandResult {
  return value.authority.commands.execute(
    auth,
    gameCommandEnvelope("task.cancel", { taskId }, value.host.ids("cmd")),
  );
}

/** 读取分支事件时间线（类型与提交 tick），用于断言事件顺序与同一提交。 */
function eventTimeline(value: GameHarness): readonly { readonly type: string; readonly worldTick: number }[] {
  return value.storage.transact((tx) =>
    tx
      .all("SELECT type, world_tick FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC", [value.branchId])
      .map((row) => ({ type: String(row["type"]), worldTick: Number(row["world_tick"]) })),
  );
}

/** 读取任务的名义完成 tick。 */
function nominalTick(aggregate: Json | null): number {
  return (aggregate as { readonly nominalCompletionTick: number }).nominalCompletionTick;
}

/** 任务相关的 ResourcesConsumed 事件。 */
function consumedOf(value: GameHarness, taskId: string): ReturnType<typeof readGameEvents> {
  return eventsOf(value, "ResourcesConsumed").filter(
    (event) => (event.payload as { readonly taskId?: string }).taskId === taskId,
  );
}

function start(value: GameHarness): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return value.authority.commands.execute(
    playerAuth(value),
    gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd")),
  );
}

function eventsOf(value: GameHarness, type: string): ReturnType<typeof readGameEvents> {
  return readGameEvents(value).filter((event) => event.type === type);
}

function dispatchTransport(value: GameHarness): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return value.authority.commands.execute(
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
}

describe("任务行动", () => {
  it("玩家运输 10 供给：预留、路线、完成转移与委托扣减", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchTransport(value);
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ reserved: { supply: 10 } });
    expect(readGameEventAudience(value, "TaskDispatched")).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
    ]);
    const dispatchedAudience = JSON.stringify(readGameEventAudience(value, "TaskDispatched"));
    expect(dispatchedAudience).not.toContain("public");
    expect(dispatchedAudience).not.toContain("human-independent");
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "running", departTick: 1 });
    const departed = eventsOf(value, "TaskDeparted");
    expect(departed).toHaveLength(1);
    expect(departed[0]?.payload).toMatchObject({ route: ["r-gh-or"], nominalCompletionTick: 7 });
    expect(departed[0]?.audience).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
      { kind: "node", nodeId: "grayharbor" },
    ]);
    setGameClock(value, { worldTick: 7, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 7);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ amount: { supply: 50 } });
    expect(readGameAggregate(value, "stockpile", "sp-earth")).toMatchObject({ amount: { supply: 30 } });
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ nodeId: "orchard", status: "idle" });
    expect(eventsOf(value, "TaskCompleted")).toHaveLength(1);
    expect(readGameEventAudience(value, "TaskCompleted")).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
      { kind: "node", nodeId: "orchard" },
    ]);
  });

  it("侦察任务按道路风险抽样，延误时先通知再完成", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = value.authority.commands.execute(
      strategicAuth(value, "human-independent"),
      gameCommandEnvelope(
        "task.dispatch",
        {
          taskType: "scout",
          teamId: "team-rubble",
          params: { nodeId: "archive" },
        },
        value.host.ids("cmd"),
      ),
    );
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    setGameClock(value, { worldTick: 20, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 20);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed" });
    const delayed = eventsOf(value, "TaskDelayed");
    if (delayed.length > 0) {
      expect(delayed[0]?.payload).toMatchObject({ taskId, cause: "road-risk" });
    }
    expect(readGameAggregate(value, "team", "team-rubble")).toMatchObject({ nodeId: "archive", status: "idle" });
  });

  it("任务取消释放预留并恢复委托与队伍", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchTransport(value);
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    const cancel = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("task.cancel", { taskId }, value.host.ids("cmd")),
    );
    expect(cancel.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "cancelled" });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ reserved: { supply: 0 } });
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ status: "idle" });
    expect(readGameEventAudience(value, "TaskCancelled")).toEqual([
      { kind: "principals", ids: ["player-1"] },
      { kind: "faction", factionId: "human-neutral" },
    ]);
  });

  it("救援邀请苏回、预留医疗并在完成时救出群体", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = value.authority.commands.execute(
      strategicAuth(value, "human-pacifist"),
      gameCommandEnvelope(
        "task.dispatch",
        {
          taskType: "rescue",
          teamId: "team-truce",
          invitees: ["npc-suhui"],
          params: { groupId: "grp-injured-migrants", toNodeId: "grayharbor", medicalStockpileId: "sp-truce" },
        },
        value.host.ids("cmd"),
      ),
    );
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    expect(readGameAggregate(value, "stockpile", "sp-truce")).toMatchObject({ reserved: { medical: 6 } });
    expect(readGameEventAudience(value, "TaskDispatched")).toEqual([
      { kind: "principals", ids: ["human-pacifist", "npc-suhui"] },
      { kind: "faction", factionId: "human-pacifist" },
    ]);
    expect(readGameEventAudience(value, "TaskInvitationIssued")).toEqual([
      { kind: "principals", ids: ["npc-suhui", "human-pacifist"] },
    ]);
    const invitations = readGameEvents(value).filter((event) => event.type === "TaskInvitationIssued");
    expect(invitations).toHaveLength(1);
    const accept = value.authority.commands.execute(
      strategicAuth(value, "npc-suhui"),
      gameCommandEnvelope("task.respond", { taskId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(accept.commandStatus).toBe("accepted");
    expect(readGameEventAudience(value, "TaskInvitationAnswered")).toEqual([
      { kind: "principals", ids: ["human-pacifist", "npc-suhui"] },
    ]);
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameEventAudience(value, "TaskDeparted")).toEqual([
      { kind: "principals", ids: ["human-pacifist", "npc-suhui"] },
      { kind: "faction", factionId: "human-pacifist" },
      { kind: "node", nodeId: "pass" },
    ]);
    setGameClock(value, { worldTick: 20, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 20);
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({ status: "rescued", injured: 0, nodeId: "grayharbor" });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "migration.safety": 60 });
    expect(readGameAggregate(value, "stockpile", "sp-truce")).toMatchObject({ amount: { medical: 4 } });
  });

  it("未应答的邀请在出发时过期，受众只含受邀者与派遣者", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = value.authority.commands.execute(
      strategicAuth(value, "human-independent"),
      gameCommandEnvelope(
        "task.dispatch",
        { taskType: "scout", teamId: "team-rubble", invitees: ["npc-cenyan"], params: { nodeId: "archive" } },
        value.host.ids("cmd"),
      ),
    );
    expect(dispatch.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameEventAudience(value, "TaskInvitationExpired")).toEqual([
      { kind: "principals", ids: ["npc-cenyan", "human-independent"] },
    ]);
  });

  it("出发路线失效时任务失败，受众只含派遣者与队伍派系", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = value.authority.commands.execute(
      strategicAuth(value, "species-flora"),
      gameCommandEnvelope(
        "task.dispatch",
        {
          taskType: "rescue",
          teamId: "team-flora",
          params: { groupId: "grp-injured-migrants", toNodeId: "orchard", medicalStockpileId: "sp-flora" },
        },
        value.host.ids("cmd"),
      ),
    );
    expect(dispatch.commandStatus).toBe("accepted");
    const override = value.authority.commands.execute(
      operatorAuth(value),
      gameCommandEnvelope(
        "scenario.override",
        {
          effects: [
            { kind: "road-status-set", roadId: "r-gh-or", status: "closed" },
            { kind: "road-status-set", roadId: "r-wg-or", status: "closed" },
          ],
          note: "阻断果园对外路线",
        },
        value.host.ids("cmd"),
      ),
    );
    expect(override.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameEventAudience(value, "TaskFailed")).toEqual([
      { kind: "principals", ids: ["species-flora"] },
      { kind: "faction", factionId: "species-flora" },
    ]);
  });
});

describe("派遣校验顺序", () => {
  const transportPayload = {
    taskType: "transport",
    teamId: "team-commons",
    params: { fromStockpileId: "sp-commons", toStockpileId: "sp-earth", cargo: { supply: 10, energy: 0, medical: 0 } },
  } as const;

  it("队伍忙且无授权时先报 no-authority", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    expect(dispatchTransport(value).commandStatus).toBe("accepted");
    const unauthorized = dispatchAs(value, strategicAuth(value, "human-independent"), transportPayload);
    expect(unauthorized.commandStatus).toBe("rejected");
    expect(unauthorized.reasonCode).toBe("no-authority");
    const busy = dispatchTransport(value);
    expect(busy.commandStatus).toBe("rejected");
    expect(busy.reasonCode).toBe("team-busy");
  });

  it("缺参数且队伍忙时先报 invalid-params", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    expect(dispatchTransport(value).commandStatus).toBe("accepted");
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
    expect(start(value).commandStatus).toBe("accepted");
    const missingStockpile = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      invitees: ["npc-suhui"],
      params: { fromStockpileId: "sp-commons", toStockpileId: "sp-nowhere", cargo: { supply: 10, energy: 0, medical: 0 } },
    });
    expect(missingStockpile.commandStatus).toBe("rejected");
    expect(missingStockpile.reasonCode).toBe("invalid-params");
    // 参数齐全后才轮到受邀者可用性：苏回不在灰港，属于 participant-unavailable。
    const unavailable = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      invitees: ["npc-suhui"],
      params: { fromStockpileId: "sp-commons", toStockpileId: "sp-earth", cargo: { supply: 10, energy: 0, medical: 0 } },
    });
    expect(unavailable.commandStatus).toBe("rejected");
    expect(unavailable.reasonCode).toBe("participant-unavailable");
  });

  it("受邀者不可用且路线不可达时先报 participant-unavailable", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const override = value.authority.commands.execute(
      operatorAuth(value),
      gameCommandEnvelope(
        "scenario.override",
        {
          effects: [
            { kind: "road-status-set", roadId: "r-ps-ar", status: "closed" },
            { kind: "road-status-set", roadId: "r-gh-ar", status: "closed" },
          ],
          note: "封锁档案库对外路线",
        },
        value.host.ids("cmd"),
      ),
    );
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
  it("救援同一条路线：苏回参与总用时减 2", async () => {
    const invited = await harness();
    expect(start(invited).commandStatus).toBe("accepted");
    const withHelper = dispatchAs(invited, strategicAuth(invited, "human-pacifist"), {
      taskType: "rescue",
      teamId: "team-truce",
      invitees: ["npc-suhui"],
      departAfterTicks: 1,
      params: { groupId: "grp-injured-migrants", toNodeId: "grayharbor", medicalStockpileId: "sp-truce" },
    });
    expect(withHelper.commandStatus).toBe("accepted");
    const helperTaskId = (withHelper.result as { readonly taskId: string }).taskId;
    expect(respondAs(invited, "npc-suhui", helperTaskId, "accept").commandStatus).toBe("accepted");
    setGameClock(invited, { worldTick: 1, mode: "running" });
    invited.authority.jobs.runDue(invited.branchId, 1);
    const helperTask = readGameAggregate(invited, "task", helperTaskId);
    expect(helperTask).toMatchObject({ status: "running", departTick: 1, route: ["r-gh-ps"] });
    expect(nominalTick(helperTask) - 1).toBe(4);

    const plain = await harness();
    expect(start(plain).commandStatus).toBe("accepted");
    const withoutHelper = dispatchAs(plain, strategicAuth(plain, "human-pacifist"), {
      taskType: "rescue",
      teamId: "team-truce",
      departAfterTicks: 1,
      params: { groupId: "grp-injured-migrants", toNodeId: "grayharbor", medicalStockpileId: "sp-truce" },
    });
    expect(withoutHelper.commandStatus).toBe("accepted");
    const plainTaskId = (withoutHelper.result as { readonly taskId: string }).taskId;
    setGameClock(plain, { worldTick: 1, mode: "running" });
    plain.authority.jobs.runDue(plain.branchId, 1);
    const plainTask = readGameAggregate(plain, "task", plainTaskId);
    expect(plainTask).toMatchObject({ status: "running", departTick: 1, route: ["r-gh-ps"] });
    expect(nominalTick(plainTask) - 1).toBe(6);
  });

  it("侦察同一条路线：追风参与时每条道路减 1", async () => {
    const guided = await harness();
    expect(start(guided).commandStatus).toBe("accepted");
    const withGuide = dispatchAs(guided, strategicAuth(guided, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      invitees: ["npc-zhuifeng"],
      departAfterTicks: 1,
      params: { nodeId: "orchard" },
    });
    expect(withGuide.commandStatus).toBe("accepted");
    const guidedTaskId = (withGuide.result as { readonly taskId: string }).taskId;
    expect(respondAs(guided, "npc-zhuifeng", guidedTaskId, "accept").commandStatus).toBe("accepted");
    setGameClock(guided, { worldTick: 1, mode: "running" });
    guided.authority.jobs.runDue(guided.branchId, 1);
    const guidedTask = readGameAggregate(guided, "task", guidedTaskId);
    // 两条道路 r-wg-ps 与 r-wg-or 各减 1：行程 8，加观察 2，合计 10。
    expect(guidedTask).toMatchObject({ status: "running", route: ["r-wg-ps", "r-wg-or"] });
    expect(nominalTick(guidedTask) - 1).toBe(10);

    const plain = await harness();
    expect(start(plain).commandStatus).toBe("accepted");
    const withoutGuide = dispatchAs(plain, strategicAuth(plain, "human-independent"), {
      taskType: "scout",
      teamId: "team-rubble",
      departAfterTicks: 1,
      params: { nodeId: "orchard" },
    });
    expect(withoutGuide.commandStatus).toBe("accepted");
    const plainTaskId = (withoutGuide.result as { readonly taskId: string }).taskId;
    setGameClock(plain, { worldTick: 1, mode: "running" });
    plain.authority.jobs.runDue(plain.branchId, 1);
    const plainTask = readGameAggregate(plain, "task", plainTaskId);
    expect(plainTask).toMatchObject({ status: "running", route: ["r-wg-ps", "r-wg-or"] });
    expect(nominalTick(plainTask) - 1).toBe(12);
  });

  it("侦察同一条路线：谷寻在目标节点参与时同样每条道路减 1", async () => {
    const guided = await harness();
    expect(start(guided).commandStatus).toBe("accepted");
    const withGuide = dispatchAs(guided, strategicAuth(guided, "species-fauna"), {
      taskType: "scout",
      teamId: "team-fauna",
      invitees: ["npc-guxun"],
      departAfterTicks: 1,
      params: { nodeId: "watergate" },
    });
    expect(withGuide.commandStatus).toBe("accepted");
    const guidedTaskId = (withGuide.result as { readonly taskId: string }).taskId;
    expect(respondAs(guided, "npc-guxun", guidedTaskId, "accept").commandStatus).toBe("accepted");
    setGameClock(guided, { worldTick: 1, mode: "running" });
    guided.authority.jobs.runDue(guided.branchId, 1);
    const guidedTask = readGameAggregate(guided, "task", guidedTaskId);
    expect(guidedTask).toMatchObject({ status: "running", route: ["r-wg-ps"] });
    expect(nominalTick(guidedTask) - 1).toBe(8);

    const plain = await harness();
    expect(start(plain).commandStatus).toBe("accepted");
    const withoutGuide = dispatchAs(plain, strategicAuth(plain, "species-fauna"), {
      taskType: "scout",
      teamId: "team-fauna",
      departAfterTicks: 1,
      params: { nodeId: "watergate" },
    });
    expect(withoutGuide.commandStatus).toBe("accepted");
    const plainTaskId = (withoutGuide.result as { readonly taskId: string }).taskId;
    setGameClock(plain, { worldTick: 1, mode: "running" });
    plain.authority.jobs.runDue(plain.branchId, 1);
    const plainTask = readGameAggregate(plain, "task", plainTaskId);
    expect(plainTask).toMatchObject({ status: "running", route: ["r-wg-ps"] });
    expect(nominalTick(plainTask) - 1).toBe(9);
  });
});

describe("修复材料结算", () => {
  it("非 team-star 修复缺少供给库存点被拒，team-star 允许 null 并完成", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const missingSupply = dispatchAs(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-commons", supplyStockpileId: null },
    });
    expect(missingSupply.commandStatus).toBe("rejected");
    expect(missingSupply.reasonCode).toBe("invalid-params");

    const teamStar = dispatchAs(value, strategicAuth(value, "species-extraterrestrial"), {
      taskType: "repair",
      teamId: "team-star",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-star", supplyStockpileId: null },
    });
    expect(teamStar.commandStatus).toBe("accepted");
    const taskId = (teamStar.result as { readonly taskId: string }).taskId;
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ reserved: { energy: 10 } });
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({
      status: "running",
      workStartTick: 6,
      materialsConsumed: false,
    });
    setGameClock(value, { worldTick: 6, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 6);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ materialsConsumed: true });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({
      amount: { energy: 30 },
      reserved: { energy: 0 },
    });
    setGameClock(value, { worldTick: 12, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 12);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 12 });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "relay.stability": 85 });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ amount: { energy: 30 } });
    expect(consumedOf(value, taskId)).toHaveLength(1);
  });

  it("非 team-star 修复预留能源 10 与供给 5，出发即在工作节点时当次结算一次", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchAs(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-commons", supplyStockpileId: "sp-commons" },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      reserved: { supply: 5, energy: 10 },
    });
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({
      status: "running",
      workStartTick: 1,
      materialsConsumed: true,
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 55, energy: 2 },
      reserved: { supply: 0, energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(2);
    setGameClock(value, { worldTick: 7, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 7);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 55, energy: 2 },
    });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "relay.stability": 70 });
    expect(consumedOf(value, taskId)).toHaveLength(2);
  });

  it("修复到达 grayharbor 前取消：释放预留且不消耗", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchAs(value, strategicAuth(value, "species-extraterrestrial"), {
      taskType: "repair",
      teamId: "team-star",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-star", supplyStockpileId: null },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "running", workStartTick: 6 });
    setGameClock(value, { worldTick: 3, mode: "running" });
    const cancel = cancelAs(value, strategicAuth(value, "species-extraterrestrial"), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "cancelled", materialsConsumed: false });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({
      amount: { energy: 40 },
      reserved: { energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(0);
    setGameClock(value, { worldTick: 20, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 20);
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({ amount: { energy: 40 } });
    expect(consumedOf(value, taskId)).toHaveLength(0);
  });

  it("修复开始工作后取消：材料恰好消耗一次且不退还，重试取消被拒", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchAs(value, strategicAuth(value, "species-extraterrestrial"), {
      taskType: "repair",
      teamId: "team-star",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-star", supplyStockpileId: null },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    setGameClock(value, { worldTick: 6, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 6);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ materialsConsumed: true });
    expect(consumedOf(value, taskId)).toHaveLength(1);

    setGameClock(value, { worldTick: 7, mode: "running" });
    const cancel = cancelAs(value, strategicAuth(value, "species-extraterrestrial"), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "cancelled" });
    expect(readGameAggregate(value, "stockpile", "sp-star")).toMatchObject({
      amount: { energy: 30 },
      reserved: { energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(1);

    const retry = cancelAs(value, strategicAuth(value, "species-extraterrestrial"), taskId);
    expect(retry.commandStatus).toBe("rejected");
    expect(retry.reasonCode).toBe("task-not-cancellable");
    setGameClock(value, { worldTick: 20, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 20);
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
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchAs(value, strategicAuth(value, "species-extraterrestrial"), {
      ...delayInjuryTransport,
      invitees: ["npc-luo"],
      departAfterTicks: 4,
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    expect(respondAs(value, "npc-luo", taskId, "accept").commandStatus).toBe("accepted");

    setGameClock(value, { worldTick: 4, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 4);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({
      status: "running",
      departTick: 4,
      nominalCompletionTick: 11,
      riskOutcome: { delayTicks: 2, injuredAgentIds: ["npc-luo"], teamInjured: false },
    });
    // 出发只写内部风险：不改变角色伤势，也不发 CharacterInjured。
    expect(readGameAggregate(value, "character", "npc-luo")).toMatchObject({ injuredUntilTick: null });
    expect(eventsOf(value, "TaskDeparted")).toHaveLength(1);
    expect(eventsOf(value, "CharacterInjured")).toHaveLength(0);

    setGameClock(value, { worldTick: 11, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 11);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "running", delayNoticeSent: true });
    const delayed = eventsOf(value, "TaskDelayed");
    expect(delayed).toHaveLength(1);
    expect(delayed[0]?.payload).toMatchObject({ taskId, newCompletionTick: 13, cause: "road-risk" });
    expect(eventsOf(value, "CharacterInjured")).toHaveLength(0);

    setGameClock(value, { worldTick: 13, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 13);
    expect(eventsOf(value, "TaskDelayed")).toHaveLength(1);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 13 });
    const injured = eventsOf(value, "CharacterInjured");
    expect(injured).toHaveLength(1);
    expect(injured[0]?.payload).toMatchObject({ agentId: "npc-luo", untilTick: 61, cause: "road-risk" });
    expect(readGameAggregate(value, "character", "npc-luo")).toMatchObject({ injuredUntilTick: 61 });
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
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchAs(value, strategicAuth(value, "species-extraterrestrial"), {
      ...delayInjuryTransport,
      departAfterTicks: 4,
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    setGameClock(value, { worldTick: 4, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 4);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({
      status: "running",
      riskOutcome: { delayTicks: 2, injuredAgentIds: [], teamInjured: true },
    });
    expect(readGameAggregate(value, "team", "team-star")).toMatchObject({ status: "traveling" });
    setGameClock(value, { worldTick: 11, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 11);
    expect(eventsOf(value, "TaskDelayed")).toHaveLength(1);
    setGameClock(value, { worldTick: 13, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 13);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 13 });
    expect(readGameAggregate(value, "team", "team-star")).toMatchObject({
      status: "recovering",
      busyUntilTick: 37,
    });
    expect(eventsOf(value, "CharacterInjured")).toHaveLength(0);
  });
});
