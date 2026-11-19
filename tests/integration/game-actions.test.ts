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

describe("任务资源写入失败的事务边界", () => {
  it("修复完成时第二个扣减失败：job 回滚、任务可重试，不提交 TaskFailed 或部分扣减", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    // 先让 team-commons 运货到隘口，使修复需要先赶回灰港，工作与完成落在不同 job。
    const move = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-rubble",
        cargo: { supply: 1, energy: 0, medical: 0 },
      },
    });
    expect(move.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    setGameClock(value, { worldTick: 20, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 20);
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ nodeId: "pass", status: "idle" });

    const repair = dispatchAs(value, strategicAuth(value, "human-neutral"), {
      taskType: "repair",
      teamId: "team-commons",
      departAfterTicks: 1,
      params: { target: "relay", energyStockpileId: "sp-commons", supplyStockpileId: "sp-commons" },
    });
    expect(repair.commandStatus).toBe("accepted");
    const taskId = (repair.result as { readonly taskId: string }).taskId;
    setGameClock(value, { worldTick: 21, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 21);
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
    setGameClock(value, { worldTick: 27, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 27);
    setGameClock(value, { worldTick: 31, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 31);
    if (departed.riskOutcome.delayTicks > 0) {
      setGameClock(value, { worldTick: departed.nominalCompletionTick, mode: "running" });
      value.authority.jobs.runDue(value.branchId, departed.nominalCompletionTick);
      expect(eventsOf(value, "TaskDelayed")).toHaveLength(1);
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
    expect(eventsOf(value, "TaskFailed")).toHaveLength(0);
    expect(consumedOf(value, taskId)).toHaveLength(0);
    expect(
      eventsOf(value, "TaskCompleted").filter(
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
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({
      status: "completed",
      materialsConsumed: true,
      completedAtTick: completionTick,
    });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({
      amount: { supply: 54, energy: 2 },
      reserved: { supply: 0, energy: 0 },
    });
    expect(consumedOf(value, taskId)).toHaveLength(2);
    expect(eventsOf(value, "TaskFailed")).toHaveLength(0);
    expect(
      eventsOf(value, "TaskCompleted").filter(
        (event) => (event.payload as { readonly taskId?: string }).taskId === taskId,
      ),
    ).toHaveLength(1);
  });

  it("取消时释放预留失败：命令 rejected，任务与库存保持原状态", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchTransport(value);
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
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

    const cancel = cancelAs(value, playerAuth(value), taskId);
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
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = dispatchTransport(value);
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
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

    const cancel = cancelAs(value, playerAuth(value), taskId);
    expect(cancel.commandStatus).toBe("rejected");
    expect(cancel.reasonCode).toBe("invalid-params");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "pending" });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toEqual(stockBefore);
    expect(readGameEvents(value)).toHaveLength(eventsBefore);
  });

  it("委托回补只退回实际扣减的那笔，不按主体与库存点重选", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const proposal = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope(
        "agreement.propose",
        {
          parties: ["human-neutral", "player-1"],
          terms: [
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
        },
        value.host.ids("cmd"),
      ),
    );
    expect(proposal.commandStatus).toBe("accepted");
    const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
    expect(
      value.authority.commands.execute(
        playerAuth(value),
        gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
      ).commandStatus,
    ).toBe("accepted");
    const playerDelegations = eventsOf(value, "DelegationCreated")
      .map((event) => event.payload as {
        readonly delegationId: string;
        readonly granteeId: string;
        readonly stockpileId: string | null;
      })
      .filter((payload) => payload.granteeId === "player-1" && payload.stockpileId === "sp-commons");
    expect(playerDelegations).toHaveLength(2);

    const dispatch = dispatchAs(value, playerAuth(value), {
      taskType: "transport",
      teamId: "team-commons",
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        cargo: { supply: 5, energy: 0, medical: 0 },
      },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
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

    const cancel = cancelAs(value, playerAuth(value), taskId);
    expect(cancel.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "cancelled" });
    expect(delegationBalance(value, drawnId).remaining.supply).toBe(drawnBefore.limit.supply);
    expect(delegationBalance(value, other!.delegationId).remaining).toEqual(otherBalance.remaining);
  });
});
