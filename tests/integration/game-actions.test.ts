/**
 * 验证任务派遣、邀请、运输完成、救援与取消回滚。
 * 依赖真实 SQLite、世界/通信/行动模块、内容包与 authority；不启动网络。
 * 禁止用固定任务状态替代规则结算。
 */
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
