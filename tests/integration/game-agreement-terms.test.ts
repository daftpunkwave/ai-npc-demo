/**
 * 验证八类协议条款的履约与违约路径；规则明确 delegate 没有违约状态。
 * 依赖真实 SQLite、世界/地图/行动/通信/协议模块与 authority；任务与期限都经 job 推进，履约证据经消费者处理。
 * 禁止直接修改协议聚合、绕过命令网关或放宽条款校验。
 */
import type { AuthContext, CommandType, Json, Term } from "@ai-npc/contracts";
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

/** 只设置时钟并执行到期 job 与消费者；用于没有进行中任务的期限判定。 */
function runToTick(value: GameHarness, tick: number): void {
  setGameClock(value, { worldTick: tick, mode: "running" });
  value.authority.jobs.runDue(value.branchId, tick);
  value.authority.consumers.run(value.branchId);
}

/** 逐 tick 推进，保证出发、名义完成与延误后的完成 job 都在各自的到期 tick 处理。 */
function advanceTicks(value: GameHarness, fromTick: number, toTick: number): void {
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    runToTick(value, tick);
  }
}

interface AgreementView {
  readonly status: string;
  readonly fulfilledTerms: readonly number[];
  readonly breachedTerms: readonly number[];
  readonly progress: readonly number[];
}

function agreementState(value: GameHarness, agreementId: string): AgreementView {
  const state = readGameAggregate(value, "agreement", agreementId);
  if (state === null) {
    throw new Error(`协议 ${agreementId} 不存在`);
  }
  return state as unknown as AgreementView;
}

interface TaskView {
  readonly status: string;
  readonly completedAtTick: number | null;
}

function taskState(value: GameHarness, taskId: string): TaskView {
  const state = readGameAggregate(value, "task", taskId);
  if (state === null) {
    throw new Error(`任务 ${taskId} 不存在`);
  }
  return state as unknown as TaskView;
}

function eventPayloads<T>(value: GameHarness, type: string): readonly T[] {
  return readGameEvents(value)
    .filter((event) => event.type === type)
    .map((event) => event.payload as unknown as T);
}

interface TermEventPayload {
  readonly agreementId: string;
  readonly termIndex: number;
  readonly obligorId: string;
}

function agreementCount(value: GameHarness): number {
  return value.storage.transact((tx) =>
    tx.branch(value.branchId).table("aggregate_state").count({ aggregate_type: "agreement" }),
  );
}

interface JobRow {
  readonly kind: string;
  readonly idempotencyKey: string;
}

function jobRows(value: GameHarness): readonly JobRow[] {
  return value.storage.transact((tx) =>
    tx
      .branch(value.branchId)
      .table("jobs")
      .list({})
      .map((row) => ({
        kind: String(row["kind"]),
        idempotencyKey: String(row["idempotency_key"]),
      })),
  );
}

describe("协议条款履约", () => {
  it("deliver 只完成部分运输：byTick+1 记违约并保留已记进度", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [
        {
          kind: "deliver",
          obligorId: "player-1",
          resource: "supply",
          amount: 10,
          fromStockpileId: "sp-commons",
          toStockpileId: "sp-earth",
          byTick: 20,
        },
      ],
      "human-neutral",
    );
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
    // 含货物运输每经过一条道路 +1 tick，r-gh-or 行程 6 tick，出发 tick 1、完成 tick 7。
    advanceTicks(value, 1, 7);
    expect(taskState(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    // 只记录部分进度，数量未达标前条款不履约。
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "active",
      fulfilledTerms: [],
      progress: [5],
    });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
      progress: [5],
    });
    const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "player-1" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);
  });

  it("escort 完成道路护送后条款履约、整份协议 fulfilled", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-independent"],
      [{ kind: "escort", obligorId: "human-independent", roadId: "r-gh-ps", byTick: 20 }],
      "human-independent",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active", fulfilledTerms: [] });
    const dispatch = execute(value, strategicAuth(value, "human-independent"), "task.dispatch", {
      taskType: "escort",
      teamId: "team-rubble",
      params: { roadId: "r-gh-ps" },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    // team-rubble 已在道路端点，出发 tick 1、巡护 12 tick，名义完成 tick 13。
    advanceTicks(value, 1, 20);
    expect(taskState(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 13 });
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    const fulfilledTerms = eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled");
    expect(fulfilledTerms).toHaveLength(1);
    expect(fulfilledTerms[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "human-independent" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(1);
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(0);
  });

  it("escort 未在 byTick 前完成护送时 byTick+1 违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-independent"],
      [{ kind: "escort", obligorId: "human-independent", roadId: "r-gh-ps", byTick: 20 }],
      "human-independent",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active" });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "human-independent" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);
  });

  it("rescue 完成群体救援后条款履约、整份协议 fulfilled", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-pacifist"],
      [{ kind: "rescue", obligorId: "human-pacifist", groupId: "grp-injured-migrants", byTick: 100 }],
      "human-pacifist",
    );
    const dispatch = execute(value, strategicAuth(value, "human-pacifist"), "task.dispatch", {
      taskType: "rescue",
      teamId: "team-truce",
      invitees: ["npc-suhui"],
      params: {
        groupId: "grp-injured-migrants",
        toNodeId: "grayharbor",
        medicalStockpileId: "sp-truce",
      },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    const accepted = execute(value, strategicAuth(value, "npc-suhui"), "task.respond", {
      taskId,
      response: "accept",
    });
    expect(accepted.commandStatus).toBe("accepted");

    // 出发 tick 2，行程 4 tick（苏回参与减 2），道路风险可能再延误 2 tick。
    advanceTicks(value, 1, 20);
    const task = taskState(value, taskId);
    expect(task.status).toBe("completed");
    expect(task.completedAtTick).not.toBeNull();
    expect(readGameAggregate(value, "group", "grp-injured-migrants")).toMatchObject({ status: "rescued" });
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    const fulfilledTerms = eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled");
    expect(fulfilledTerms).toHaveLength(1);
    expect(fulfilledTerms[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "human-pacifist" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(1);
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(0);
  });

  it("rescue 未在 byTick 前救援时 byTick+1 违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-pacifist"],
      [{ kind: "rescue", obligorId: "human-pacifist", groupId: "grp-injured-migrants", byTick: 20 }],
      "human-pacifist",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active" });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "human-pacifist" });
  });

  it("repair-relay 完成中继修复后条款履约、整份协议 fulfilled", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [{ kind: "repair-relay", obligorId: "human-neutral", byTick: 20 }],
      "human-neutral",
    );
    const dispatch = execute(value, strategicAuth(value, "human-neutral"), "task.dispatch", {
      taskType: "repair",
      teamId: "team-commons",
      params: {
        target: "relay",
        energyStockpileId: "sp-commons",
        supplyStockpileId: "sp-commons",
      },
    });
    expect(dispatch.commandStatus).toBe("accepted");
    const taskId = (dispatch.result as { readonly taskId: string }).taskId;
    // team-commons 已在 grayharbor：出发 tick 1 即开始工作，6 tick 后完成。
    advanceTicks(value, 1, 7);
    expect(taskState(value, taskId)).toMatchObject({ status: "completed", completedAtTick: 7 });
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    const fulfilledTerms = eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled");
    expect(fulfilledTerms).toHaveLength(1);
    expect(fulfilledTerms[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "human-neutral" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(1);
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(0);
  });

  it("repair-relay 未在 byTick 前完成修复时 byTick+1 违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [{ kind: "repair-relay", obligorId: "human-neutral", byTick: 20 }],
      "human-neutral",
    );
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active" });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "human-neutral" });
  });

  it("share-evidence 在 byTick 前分享给约定主体后条款履约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
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
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active", fulfilledTerms: [] });
    // 玩家在灰港公社开局时持有水闸分水账；分享真实走 information.share。
    setGameClock(value, { worldTick: 5, mode: "running" });
    const share = execute(value, playerAuth(value), "information.share", {
      evidenceId: "ev-water-ledger",
      audience: ["human-neutral"],
    });
    expect(share.commandStatus).toBe("accepted");

    value.authority.consumers.run(value.branchId);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    const shared = eventPayloads<{ readonly evidenceId: string; readonly audience: readonly string[] }>(
      value,
      "InformationShared",
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ evidenceId: "ev-water-ledger", audience: ["human-neutral"] });
    const fulfilledTerms = eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled");
    expect(fulfilledTerms).toHaveLength(1);
    expect(fulfilledTerms[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "player-1" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(1);
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(0);
  });

  it("share-evidence 未在 byTick 前分享时 byTick+1 违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
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
    expect(agreementState(value, agreementId)).toMatchObject({ status: "active" });

    runToTick(value, 21);
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ agreementId, termIndex: 0, obligorId: "player-1" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);
  });

  it("grant-passage 与 water-allocation 生效即履约，义务期内违反持续义务时记违约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const passageId = activateAgreement(
      value,
      ["player-1", "human-independent"],
      [
        {
          kind: "grant-passage",
          obligorId: "human-independent",
          roadId: "r-gh-ps",
          granteeFactionId: "species-fauna",
          untilTick: 20,
        },
      ],
      "human-independent",
    );
    const waterId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [{ kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 20 }],
      "human-neutral",
    );
    // 生效即记条款履约；untilTick 之前仍有持续义务，整份协议保持 active。
    expect(agreementState(value, passageId)).toMatchObject({
      status: "active",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    expect(agreementState(value, waterId)).toMatchObject({
      status: "active",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    const activationFulfillments = eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled");
    expect(activationFulfillments).toHaveLength(2);
    expect(activationFulfillments[0]).toMatchObject({ agreementId: passageId, termIndex: 0 });
    expect(activationFulfillments[1]).toMatchObject({ agreementId: waterId, termIndex: 0 });
    expect(eventPayloads(value, "PassageGranted")).toHaveLength(1);
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);

    // 义务人在义务期内关闭道路并改分配：两条持续义务分别违约。
    setGameClock(value, { worldTick: 5, mode: "running" });
    const close = execute(value, strategicAuth(value, "human-independent"), "policy.set", {
      key: "road.status:r-gh-ps",
      value: "closed",
    });
    expect(close.commandStatus).toBe("accepted");
    const reallocate = execute(value, strategicAuth(value, "human-neutral"), "policy.set", {
      key: "watergate.allocation",
      value: "rotation",
    });
    expect(reallocate.commandStatus).toBe("accepted");
    value.authority.consumers.run(value.branchId);

    expect(agreementState(value, passageId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    expect(agreementState(value, waterId)).toMatchObject({
      status: "breached",
      fulfilledTerms: [],
      breachedTerms: [0],
    });
    const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
    expect(breaches).toHaveLength(2);
    expect(breaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agreementId: passageId, termIndex: 0, obligorId: "human-independent" }),
        expect.objectContaining({ agreementId: waterId, termIndex: 0, obligorId: "human-neutral" }),
      ]),
    );
  });

  it("grant-passage 与 water-allocation 期满未违约，untilTick+1 后整份协议 fulfilled", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const passageId = activateAgreement(
      value,
      ["player-1", "human-independent"],
      [
        {
          kind: "grant-passage",
          obligorId: "human-independent",
          roadId: "r-gh-ps",
          granteeFactionId: "species-fauna",
          untilTick: 20,
        },
      ],
      "human-independent",
    );
    // 用与当前分配不同的值，验证生效写入本身不会被当成违约。
    const waterId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [{ kind: "water-allocation", obligorId: "human-neutral", policy: "rotation", untilTick: 20 }],
      "human-neutral",
    );
    expect(agreementState(value, waterId)).toMatchObject({
      status: "active",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    // 生效写入真实改变了分配；这条 PolicyChanged 不能算义务期内违约。
    expect(eventPayloads<{ readonly key: string; readonly newValue: string }>(value, "PolicyChanged")).toEqual([
      expect.objectContaining({ key: "watergate.allocation", newValue: "rotation" }),
    ]);

    runToTick(value, 20);
    expect(agreementState(value, passageId)).toMatchObject({ status: "active" });
    expect(agreementState(value, waterId)).toMatchObject({ status: "active" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);

    runToTick(value, 21);
    expect(agreementState(value, passageId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    expect(agreementState(value, waterId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(2);
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(0);
  });

  it("delegate 生效即履约且整份协议 fulfilled，不安排违约检查 job", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = activateAgreement(
      value,
      ["player-1", "human-neutral"],
      [
        {
          kind: "delegate",
          obligorId: "human-neutral",
          granteeId: "player-1",
          teamIds: ["team-commons"],
          stockpileId: "sp-commons",
          maxDraw: { supply: 5, energy: 2, medical: 0 },
          untilTick: 20,
        },
      ],
      "human-neutral",
    );
    expect(agreementState(value, agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    const fulfilledTerms = eventPayloads<TermEventPayload & { readonly evidenceEventIds: readonly string[] }>(
      value,
      "AgreementTermFulfilled",
    );
    expect(fulfilledTerms).toHaveLength(1);
    expect(fulfilledTerms[0]).toMatchObject({
      agreementId,
      termIndex: 0,
      obligorId: "human-neutral",
      evidenceEventIds: [],
    });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(1);
    // 首版没有撤销命令：delegate 不安排 agreement.breach job。
    expect(
      jobRows(value).filter(
        (job) => job.kind === "agreement.breach" && job.idempotencyKey.startsWith(`agreement-breach:${agreementId}:`),
      ),
    ).toHaveLength(0);
  });
});

describe("条款校验边界", () => {
  it("非 delegate 条款的 byTick 与 untilTick 必须晚于当前 tick 且不超过当前 +168", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const proposeEscort = (byTick: number): Receipt =>
      execute(value, playerAuth(value), "agreement.propose", {
        parties: ["player-1", "human-independent"],
        terms: [{ kind: "escort", obligorId: "human-independent", roadId: "r-gh-ps", byTick }],
      });
    const proposeWater = (untilTick: number): Receipt =>
      execute(value, playerAuth(value), "agreement.propose", {
        parties: ["player-1", "human-neutral"],
        terms: [{ kind: "water-allocation", obligorId: "human-neutral", policy: "rotation", untilTick }],
      });

    for (const proposal of [proposeEscort(0), proposeWater(0), proposeEscort(169), proposeWater(169)]) {
      expect(proposal.commandStatus).toBe("rejected");
      expect(proposal.reasonCode).toBe("deadline-out-of-range");
    }
    expect(agreementCount(value)).toBe(0);

    expect(proposeEscort(168).commandStatus).toBe("accepted");
    expect(agreementCount(value)).toBe(1);
    expect(proposeWater(168).commandStatus).toBe("accepted");
    expect(agreementCount(value)).toBe(2);
  });

  it("义务人缺少条款所需授权时提出被拒且零写入", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    // 玩家对 sp-rubble 没有动用权。
    const deliver = execute(value, playerAuth(value), "agreement.propose", {
      parties: ["player-1", "human-neutral"],
      terms: [
        {
          kind: "deliver",
          obligorId: "player-1",
          resource: "supply",
          amount: 5,
          fromStockpileId: "sp-rubble",
          toStockpileId: "sp-earth",
          byTick: 20,
        },
      ],
    });
    expect(deliver.commandStatus).toBe("rejected");
    expect(deliver.reasonCode).toBe("invalid-terms");
    // 岑雁不持有水闸分水账。
    const share = execute(value, playerAuth(value), "agreement.propose", {
      parties: ["player-1", "npc-cenyan"],
      terms: [
        {
          kind: "share-evidence",
          obligorId: "npc-cenyan",
          evidenceId: "ev-water-ledger",
          toPrincipalId: "human-neutral",
          byTick: 20,
        },
      ],
    });
    expect(share.commandStatus).toBe("rejected");
    expect(share.reasonCode).toBe("invalid-terms");
    // 水闸分配只能由 human-neutral 承担。
    const water = execute(value, playerAuth(value), "agreement.propose", {
      parties: ["player-1", "human-neutral"],
      terms: [{ kind: "water-allocation", obligorId: "player-1", policy: "rotation", untilTick: 20 }],
    });
    expect(water.commandStatus).toBe("rejected");
    expect(water.reasonCode).toBe("invalid-terms");
    // r-gh-ps 的控制方是 human-independent，human-neutral 不是控制方战略 Agent。
    const passage = execute(value, playerAuth(value), "agreement.propose", {
      parties: ["player-1", "human-neutral"],
      terms: [
        {
          kind: "grant-passage",
          obligorId: "human-neutral",
          roadId: "r-gh-ps",
          granteeFactionId: "species-fauna",
          untilTick: 20,
        },
      ],
    });
    expect(passage.commandStatus).toBe("rejected");
    expect(passage.reasonCode).toBe("invalid-terms");

    expect(agreementCount(value)).toBe(0);
    expect(eventPayloads(value, "AgreementProposed")).toHaveLength(0);
  });
});
