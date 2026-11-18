/**
 * 验证任务派遣、邀请、运输完成、救援与取消回滚。
 * 依赖真实 SQLite、世界/通信/行动模块、内容包与 authority；不启动网络。
 * 禁止用固定任务状态替代规则结算。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createGameHarness,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
  readGameEvents,
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
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "running", departTick: 1 });
    const departed = eventsOf(value, "TaskDeparted");
    expect(departed).toHaveLength(1);
    expect(departed[0]?.payload).toMatchObject({ route: ["r-gh-or"], nominalCompletionTick: 7 });
    setGameClock(value, { worldTick: 7, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 7);
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expect(readGameAggregate(value, "stockpile", "sp-commons")).toMatchObject({ amount: { supply: 50 } });
    expect(readGameAggregate(value, "stockpile", "sp-earth")).toMatchObject({ amount: { supply: 30 } });
    expect(readGameAggregate(value, "team", "team-commons")).toMatchObject({ nodeId: "orchard", status: "idle" });
    expect(eventsOf(value, "TaskCompleted")).toHaveLength(1);
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
    const invitations = readGameEvents(value).filter((event) => event.type === "TaskInvitationIssued");
    expect(invitations).toHaveLength(1);
    const accept = value.authority.commands.execute(
      strategicAuth(value, "npc-suhui"),
      gameCommandEnvelope("task.respond", { taskId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(accept.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    setGameClock(value, { worldTick: 20, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 20);
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({ status: "rescued", injured: 0, nodeId: "grayharbor" });
    expect(readGameAggregate(value, "meters", "meters")).toMatchObject({ "migration.safety": 60 });
    expect(readGameAggregate(value, "stockpile", "sp-truce")).toMatchObject({ amount: { medical: 4 } });
  });
});
