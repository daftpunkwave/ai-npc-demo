/**
 * 验证协议履约的时间窗口与旧格式任务兼容：生效前完成的任务或提交的分享不算履约，
 * 章节评估按当前水闸状态复核尚未消费的政策事实，缺少新增字段的旧任务行仍可读取并继续完成。
 * 依赖真实 SQLite、内容包、世界/行动/协议模块与 authority；tick 推进经 job、时钟步骤与消费者显式执行。
 * 禁止直接改写协议聚合、放宽任务 schema 或绕过命令网关伪造履约事实。
 */
import { TransactionWorldTx } from "@world-prism/authority";
import { domainEventPayloadSchemas, type AuthContext, type CommandType, type Json, type Term } from "@world-prism/contracts";
import { gameModuleIds, type TaskView } from "@world-prism/module-sdk";
import { createActionsPort } from "@world-prism/mod-game-actions-standard";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
  readGameEvents,
  setGameClock,
  startNeutralCampaign,
  strategicAuth,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

async function harness(): Promise<GameHarness> {
  return createTrackedGameHarness(active);
}

type Receipt = ReturnType<GameHarness["authority"]["commands"]["execute"]>;

/** 以指定主体走命令网关提交命令。 */
function execute(value: GameHarness, auth: AuthContext, type: CommandType, payload: Json): Receipt {
  return value.authority.commands.execute(auth, gameCommandEnvelope(type, payload, value.host.ids("cmd")));
}

function start(value: GameHarness): Receipt {
  return startNeutralCampaign(value);
}

/** 以玩家提出协议，并由指定战略 Agent 接受；返回协议 ID。 */
function activateAgreement(
  value: GameHarness,
  parties: readonly string[],
  terms: readonly Term[],
  accepterAgentId: string,
): string {
  const proposal = execute(value, playerAuth(value), "agreement.propose", {
    parties: [...parties],
    terms: [...terms],
  });
  expect(proposal.commandStatus).toBe("accepted");
  const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
  const accepted = execute(value, strategicAuth(value, accepterAgentId), "agreement.respond", {
    agreementId,
    response: "accept",
  });
  expect(accepted.commandStatus).toBe("accepted");
  return agreementId;
}

/** 直接设置时钟并只执行到期 job；用于在消费者追平之前观察期限 job 的判定。 */
function runJobsAt(value: GameHarness, tick: number): void {
  setGameClock(value, { worldTick: tick, mode: "running" });
  value.authority.jobs.runDue(value.branchId, tick);
}

/** 设置时钟并执行到期 job 与消费者；与在线 tick 的阶段顺序一致。 */
function runToTick(value: GameHarness, tick: number): void {
  runJobsAt(value, tick);
  value.authority.consumers.run(value.branchId);
}

interface AgreementView {
  readonly status: string;
  readonly fulfilledTerms: readonly number[];
  readonly breachedTerms: readonly number[];
}

function agreementState(value: GameHarness, agreementId: string): AgreementView {
  const state = readGameAggregate(value, "agreement", agreementId);
  if (state === null) {
    throw new Error(`协议 ${agreementId} 不存在`);
  }
  return state as unknown as AgreementView;
}

/** 通过行动端口按当前分支读取任务视图，直接覆盖 task() 的聚合校验路径。 */
function taskView(value: GameHarness, taskId: string): TaskView | null {
  return value.storage.transact((storageTx) => {
    const clock = storageTx.all("SELECT world_tick FROM clock WHERE branch_id = ?", [value.branchId])[0];
    const tx = new TransactionWorldTx({
      storageTx,
      worldId: value.worldId,
      branchId: value.branchId,
      worldTick: clock === undefined ? 0 : Number(clock["world_tick"]),
      principalId: "player-1",
      correlationId: "test:game-agreement-window",
      scope: { moduleId: gameModuleIds.actions, ownsAggregates: new Set(["task"]), order: 0 },
      host: value.host,
      eventSchemas: new Map(Object.entries(domainEventPayloadSchemas)),
    });
    return createActionsPort(() => tx).task(taskId);
  });
}

/**
 * 把任务行改写为旧版本格式：删除 riskOutcome、materialsConsumed 与 delegationDraws。
 * 只用于模拟升级前写入的聚合，读取路径必须靠 schema 默认值补齐。
 */
function removeLegacyUnsupportedFields(value: GameHarness, taskId: string): void {
  value.storage.transact((tx) => {
    const table = tx.branch(value.branchId).table("aggregate_state");
    const row = table.get({ aggregate_type: "task", aggregate_id: taskId });
    if (row === null) {
      throw new Error(`任务 ${taskId} 不存在`);
    }
    const state = row["state_json"] as Record<string, Json>;
    Reflect.deleteProperty(state, "riskOutcome");
    Reflect.deleteProperty(state, "materialsConsumed");
    Reflect.deleteProperty(state, "delegationDraws");
    table.put({ ...row, state_json: state });
  });
}

describe("协议履约时间窗口", () => {
  it("协议生效前完成的同参数运输不构成履约，到期仍然违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = execute(value, playerAuth(value), "task.dispatch", {
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

    // 运输在 tick 7 完成；完成事件在协议生效前就被消费，不会被误记为本协议的履约。
    for (let tick = 1; tick <= 7; tick += 1) {
      runJobsAt(value, tick);
    }
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    value.authority.consumers.run(value.branchId);

    // 协议到 tick 8 才生效，条款参数与已完成运输完全一致。
    setGameClock(value, { worldTick: 8, mode: "running" });
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [
        {
          kind: "deliver",
          obligorId: "player-1",
          resource: "supply",
          amount: 5,
          fromStockpileId: "sp-commons",
          toStockpileId: "sp-earth",
          byTick: 20,
        },
      ],
      "human-neutral",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active", fulfilledTerms: [], breachedTerms: [] });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    expect(readGameEvents(value).map((event) => event.type)).not.toContain("AgreementFulfilled");
  });

  it("协议生效前提交的证据分享不构成履约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    // 玩家开局持有水闸分水账；tick 3 的分享发生在协议生效（tick 5）之前。
    setGameClock(value, { worldTick: 3, mode: "running" });
    const share = execute(value, playerAuth(value), "information.share", {
      evidenceId: "ev-water-ledger",
      audience: ["human-neutral"],
    });
    expect(share.commandStatus).toBe("accepted");
    value.authority.consumers.run(value.branchId);

    setGameClock(value, { worldTick: 5, mode: "running" });
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [
        {
          kind: "share-evidence",
          obligorId: "player-1",
          evidenceId: "ev-water-ledger",
          toPrincipalId: "human-neutral",
          byTick: 20,
        },
      ],
      "human-neutral",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active", fulfilledTerms: [], breachedTerms: [] });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
  });

  it("同 tick 未消费的水闸政策变更在章节评估中计为该协议违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    // 义务期覆盖到章节评估的 tick，生效写入与当前分配一致，不产生政策事件。
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [{ kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 168 }],
      "human-neutral",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active", fulfilledTerms: [0], breachedTerms: [] });

    // 章节评估同一 tick 改分配，但不运行消费者：协议聚合仍没有违约记录。
    setGameClock(value, { worldTick: 168, mode: "running" });
    const reallocate = execute(value, strategicAuth(value, "human-neutral"), "policy.set", {
      key: "watergate.allocation",
      value: "rotation",
    });
    expect(reallocate.commandStatus).toBe("accepted");
    value.authority.clock.run(value.branchId);

    expect(agreementState(value, agreementId)).toMatchObject({ status: "active", breachedTerms: [] });
    const chapters = readGameEvents(value).filter((event) => event.type === "ChapterStageEvaluated");
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.payload).toMatchObject({ fulfilledCount: 0, breachedCount: 1 });
  });
});

describe("旧格式任务兼容", () => {
  it("缺少三个新增字段的旧任务行能被 task() 读取并继续完成", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const dispatch = execute(value, playerAuth(value), "task.dispatch", {
      taskType: "transport",
      teamId: "team-commons",
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        cargo: { supply: 10, energy: 0, medical: 0 },
      },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;

    // 出发 job 之后任务处于 running；此时改写成升级前写入的旧行。
    runJobsAt(value, 1);
    removeLegacyUnsupportedFields(value, taskId);
    expect(taskView(value, taskId)).toMatchObject({ taskId, status: "running", completedAtTick: null });

    // 完成 job 读取旧行时补齐默认值，任务仍按名义完成 tick 正常结束。
    for (let tick = 2; tick <= 7; tick += 1) {
      runJobsAt(value, tick);
    }
    expect(readGameAggregate(value, "task", taskId)).toMatchObject({
      status: "completed",
      completedAtTick: 7,
      riskOutcome: { delayTicks: 0, injuredAgentIds: [], teamInjured: false },
      materialsConsumed: false,
      delegationDraws: [],
    });
    expect(taskView(value, taskId)).toMatchObject({ taskId, status: "completed", completedAtTick: 7 });
  });
});
