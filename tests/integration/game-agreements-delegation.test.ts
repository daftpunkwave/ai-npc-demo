/**
 * 验证委托与通行/水闸条款的签发资格、生效写入、期限边界与仅队伍委托。
 * 依赖真实 SQLite、世界/地图/行动/协议模块与 authority；直接断言持久化事件与聚合，不依赖消费者推进。
 * 禁止直接改协议状态、伪造生效授权或绕过命令网关。
 */
import type { Term } from "@ai-npc/contracts";
import { describe, expect, it } from "vitest";
import { createWorldPort } from "@ai-npc/mod-game-world-slg-light";
import {
  acceptAgreement,
  advanceTo,
  agreementCount,
  createMemoryTx,
  executeCommand,
  expectAgreement,
  eventPayloads,
  playerAuth,
  proposeAgreementCommand,
  proposeAndAccept,
  readGameAggregate,
  respondAgreement,
  runConsumers,
  setGameClock,
  strategicAuth,
  useStartedGameHarnesses,
  type GameHarness,
  type Receipt,
} from "./game-agreement-support";

const harness = useStartedGameHarnesses();

/** 以玩家身份派遣 team-rubble 护送 r-gh-ps；不需要库存预留。 */
function dispatchEscort(value: GameHarness): Receipt {
  return executeCommand(value, playerAuth(value), "task.dispatch", {
    taskType: "escort",
    teamId: "team-rubble",
    params: { roadId: "r-gh-ps" },
  });
}

/** 以人类中立战略 Agent 设置水闸分配。 */
function setAllocation(value: GameHarness, policy: string): Receipt {
  return executeCommand(value, strategicAuth(value, "human-neutral"), "policy.set", {
    key: "watergate.allocation",
    value: policy,
  });
}

/** 以道路控制方战略 Agent 设置道路状态。 */
function setRoadStatus(value: GameHarness, roadId: string, status: string): Receipt {
  return executeCommand(value, strategicAuth(value, "human-independent"), "policy.set", {
    key: `road.status:${roadId}`,
    value: status,
  });
}

/** 构造 delegate 条款，默认放开供给 5、能源 2。 */
function delegateTerm(overrides: {
  readonly obligorId: string;
  readonly granteeId: string;
  readonly teamIds: readonly string[];
  readonly stockpileId: string | null;
  readonly maxDraw?: { readonly supply: number; readonly energy: number; readonly medical: number };
  readonly untilTick: number;
}): Term {
  return {
    kind: "delegate",
    obligorId: overrides.obligorId,
    granteeId: overrides.granteeId,
    teamIds: [...overrides.teamIds],
    stockpileId: overrides.stockpileId,
    maxDraw: overrides.maxDraw ?? { supply: 5, energy: 2, medical: 0 },
    untilTick: overrides.untilTick,
  };
}

/** 构造道路通行条款。 */
function passageTerm(obligorId: string, untilTick = 20): Term {
  return {
    kind: "grant-passage",
    obligorId,
    roadId: "r-gh-ps",
    granteeFactionId: "species-fauna",
    untilTick,
  };
}

/** 玩家提出通行条款，由道路控制方接受。 */
function proposePassage(value: GameHarness): string {
  return proposeAndAccept(
    value,
    strategicAuth(value, "human-independent"),
    playerAuth(value),
    ["human-independent", "player-1"],
    [passageTerm("human-independent")],
  );
}

/** 玩家提出水闸分配条款，由人类中立接受。 */
function proposeWater(value: GameHarness, terms: readonly Term[]): string {
  return proposeAndAccept(
    value,
    playerAuth(value),
    strategicAuth(value, "human-neutral"),
    ["player-1", "human-neutral"],
    terms,
  );
}

/** DelegationCreated 事件的公共 payload；各测试只断言自己关心的字段。 */
interface DelegationCreatedPayload {
  readonly delegationId: string;
  readonly grantorFactionId: string;
  readonly granteeId: string;
  readonly teamIds: readonly string[];
  readonly stockpileId: string | null;
  readonly untilTick: number;
}

/** 读取最后一条 DelegationCreated 事件 payload；没有事件时返回 undefined。 */
function lastDelegationCreated(value: GameHarness): DelegationCreatedPayload | undefined {
  return eventPayloads<DelegationCreatedPayload>(value, "DelegationCreated").at(-1);
}

describe("协议委托与授权", () => {
  it("战略 Agent 的库存与队伍委托生效时创建完整委托", async () => {
    const value = await harness();
    const agreementId = proposeAndAccept(
      value,
      strategicAuth(value, "human-neutral"),
      playerAuth(value),
      ["human-neutral", "player-1"],
      [
        delegateTerm({
          obligorId: "human-neutral",
          granteeId: "player-1",
          teamIds: ["team-commons"],
          stockpileId: "sp-commons",
          untilTick: 20,
        }),
      ],
    );
    const created = lastDelegationCreated(value);
    expect(created).toMatchObject({
      grantorFactionId: "human-neutral",
      granteeId: "player-1",
      teamIds: ["team-commons"],
      stockpileId: "sp-commons",
      untilTick: 20,
    });
    expect(readGameAggregate(value, "delegation", created?.delegationId ?? "")).toMatchObject({
      grantorFactionId: "human-neutral",
      granteeId: "player-1",
      teamIds: ["team-commons"],
      stockpileId: "sp-commons",
      remaining: { supply: 5, energy: 2, medical: 0 },
      untilTick: 20,
    });
    expectAgreement(value, agreementId, { status: "fulfilled", fulfilledTerms: [0] });
  });

  it("仅委托队伍的 null 库存委托可创建、可派遣队伍但无库存动用权", async () => {
    const value = await harness();
    const before = dispatchEscort(value);
    expect(before.commandStatus).toBe("rejected");
    expect(before.reasonCode).toBe("no-authority");
    const agreementId = proposeAndAccept(
      value,
      playerAuth(value),
      strategicAuth(value, "human-independent"),
      ["player-1", "human-independent"],
      [
        delegateTerm({
          obligorId: "human-independent",
          granteeId: "player-1",
          teamIds: ["team-rubble"],
          stockpileId: null,
          maxDraw: { supply: 0, energy: 0, medical: 0 },
          untilTick: 20,
        }),
      ],
    );
    const created = lastDelegationCreated(value);
    expect(created).toMatchObject({ grantorFactionId: "human-independent", granteeId: "player-1", teamIds: ["team-rubble"] });
    expect(created?.stockpileId).toBeNull();
    expect(readGameAggregate(value, "delegation", created?.delegationId ?? "")).toMatchObject({
      grantorFactionId: "human-independent",
      granteeId: "player-1",
      teamIds: ["team-rubble"],
      stockpileId: null,
      remaining: { supply: 0, energy: 0, medical: 0 },
      untilTick: 20,
    });
    const after = dispatchEscort(value);
    expect(after.commandStatus).toBe("accepted");

    const tx = createMemoryTx();
    const world = createWorldPort(() => tx, value.gameContent, value.host.ids);
    const portCreated = world.createDelegation({
      grantorFactionId: "human-independent",
      granteeId: "player-1",
      teamIds: ["team-rubble"],
      stockpileId: null,
      maxDraw: { supply: 0, energy: 0, medical: 0 },
      untilTick: 20,
    });
    expect(world.delegationsOf("player-1")).toEqual([
      {
        delegationId: portCreated.delegationId,
        grantorFactionId: "human-independent",
        granteeId: "player-1",
        teamIds: ["team-rubble"],
        stockpileId: null,
        remaining: { supply: 0, energy: 0, medical: 0 },
        untilTick: 20,
      },
    ]);
    expect(world.drawAuthority("player-1", "sp-rubble").kind).toBe("none");
  });

  it("玩家或角色作为义务人被拒且零写入", async () => {
    const value = await harness();
    expect(agreementCount(value)).toBe(0);
    const byPlayer = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
      delegateTerm({
        obligorId: "player-1",
        granteeId: "player-1",
        teamIds: ["team-commons"],
        stockpileId: null,
        untilTick: 20,
      }),
    ]);
    expect(byPlayer.commandStatus).toBe("rejected");
    expect(byPlayer.reasonCode).toBe("invalid-terms");
    const byCharacter = proposeAgreementCommand(value, playerAuth(value), ["player-1", "npc-wenyuan"], [
      delegateTerm({
        obligorId: "npc-wenyuan",
        granteeId: "player-1",
        teamIds: ["team-commons"],
        stockpileId: null,
        untilTick: 20,
      }),
    ]);
    expect(byCharacter.commandStatus).toBe("rejected");
    expect(byCharacter.reasonCode).toBe("invalid-terms");
    expect(agreementCount(value)).toBe(0);
    expect(eventPayloads(value, "AgreementProposed")).toHaveLength(0);
    expect(eventPayloads(value, "DelegationCreated")).toHaveLength(9);
  });

  it("队伍或库存点不属于义务人派系时被拒", async () => {
    const value = await harness();
    const foreignTeam = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
      delegateTerm({
        obligorId: "human-neutral",
        granteeId: "player-1",
        teamIds: ["team-earth"],
        stockpileId: null,
        untilTick: 20,
      }),
    ]);
    expect(foreignTeam.commandStatus).toBe("rejected");
    expect(foreignTeam.reasonCode).toBe("invalid-terms");
    const foreignStockpile = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
      delegateTerm({
        obligorId: "human-neutral",
        granteeId: "player-1",
        teamIds: ["team-commons"],
        stockpileId: "sp-rubble",
        untilTick: 20,
      }),
    ]);
    expect(foreignStockpile.commandStatus).toBe("rejected");
    expect(foreignStockpile.reasonCode).toBe("invalid-terms");
    expect(agreementCount(value)).toBe(0);
  });

  it("delegate 的 untilTick 在提出与生效时都受当前 tick + 168 限制", async () => {
    const value = await harness();
    const withUntilTick = (untilTick: number): Receipt =>
      proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
        delegateTerm({
          obligorId: "human-neutral",
          granteeId: "player-1",
          teamIds: ["team-commons"],
          stockpileId: null,
          untilTick,
        }),
      ]);
    const atCurrent = withUntilTick(0);
    expect(atCurrent.commandStatus).toBe("rejected");
    expect(atCurrent.reasonCode).toBe("deadline-out-of-range");
    const beyondRange = withUntilTick(169);
    expect(beyondRange.commandStatus).toBe("rejected");
    expect(beyondRange.reasonCode).toBe("deadline-out-of-range");
    const atBoundary = withUntilTick(168);
    expect(atBoundary.commandStatus).toBe("accepted");
    const boundaryId = (atBoundary.result as { readonly agreementId: string }).agreementId;
    acceptAgreement(value, strategicAuth(value, "human-neutral"), boundaryId);

    const short = withUntilTick(2);
    expect(short.commandStatus).toBe("accepted");
    const shortId = (short.result as { readonly agreementId: string }).agreementId;
    setGameClock(value, { worldTick: 3, mode: "running" });
    const expired = respondAgreement(value, strategicAuth(value, "human-neutral"), shortId, "accept");
    expect(expired.commandStatus).toBe("rejected");
    expect(expired.reasonCode).toBe("deadline-out-of-range");
    expectAgreement(value, shortId, { status: "proposed" });
  });

  it("通行条款只能由道路控制方的战略 Agent 生效", async () => {
    const value = await harness();
    // human-earth-alliance 是已知派系主体，但不是 r-gh-ps 的控制方。
    const nonController = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-earth-alliance"], [
      passageTerm("human-earth-alliance"),
    ]);
    expect(nonController.commandStatus).toBe("rejected");
    expect(nonController.reasonCode).toBe("invalid-terms");
    const agreementId = proposePassage(value);
    expectAgreement(value, agreementId, { status: "active" });
    expect(eventPayloads(value, "PassageGranted")).toEqual([
      expect.objectContaining({ roadId: "r-gh-ps", granteeFactionId: "species-fauna", untilTick: 20 }),
    ]);
  });

  it("水闸分配已等于条款值时生效成功且不视为写入失败", async () => {
    const value = await harness();
    const agreementId = proposeWater(value, [
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 20 },
    ]);
    expectAgreement(value, agreementId, { status: "active" });
    expect(eventPayloads(value, "AgreementActivated")).toHaveLength(1);
    expect(eventPayloads(value, "PolicyChanged")).toHaveLength(0);
  });

  it("义务期内记录的持续义务违约在政策恢复后保持 breached", async () => {
    const value = await harness();
    const waterId = proposeWater(value, [
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 20 },
    ]);
    // 生效即记为履约，但义务期未结束，协议仍然是 active。
    expectAgreement(value, waterId, { status: "active", fulfilledTerms: [0], breachedTerms: [] });
    const passageId = proposePassage(value);
    expectAgreement(value, passageId, { status: "active", fulfilledTerms: [0], breachedTerms: [] });

    // 义务期内改变分配并关闭道路：两条持续义务分别违约。
    setGameClock(value, { worldTick: 5, mode: "running" });
    expect(setAllocation(value, "rotation").commandStatus).toBe("accepted");
    expect(setRoadStatus(value, "r-gh-ps", "closed").commandStatus).toBe("accepted");
    runConsumers(value);
    expectAgreement(value, waterId, { status: "breached", breachedTerms: [0] });
    expectAgreement(value, passageId, { status: "breached", breachedTerms: [0] });

    // 政策与道路恢复不是履约证据：违约事实保留。
    setGameClock(value, { worldTick: 10, mode: "running" });
    expect(setAllocation(value, "harbor-first").commandStatus).toBe("accepted");
    expect(setRoadStatus(value, "r-gh-ps", "open").commandStatus).toBe("accepted");
    runConsumers(value);
    expectAgreement(value, waterId, { status: "breached", breachedTerms: [0] });
    expectAgreement(value, passageId, { status: "breached", breachedTerms: [0] });

    // 义务期结束的期限 job 也不能把已违约条款改写成履约。
    advanceTo(value, 21);
    expectAgreement(value, waterId, { status: "breached", breachedTerms: [0] });
    expectAgreement(value, passageId, { status: "breached", breachedTerms: [0] });
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(2);
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);
  });

  it("一次政策变更同时命中同一协议的多条水闸条款", async () => {
    const value = await harness();
    const agreementId = proposeWater(value, [
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 20 },
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 40 },
    ]);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [0, 1] });

    setGameClock(value, { worldTick: 5, mode: "running" });
    expect(setAllocation(value, "rotation").commandStatus).toBe("accepted");
    runConsumers(value);
    // 同一事件命中两条条款：两条都要记录，不能互相覆盖。
    expectAgreement(value, agreementId, { status: "breached", breachedTerms: [0, 1] });
    expect(eventPayloads<{ readonly termIndex: number }>(value, "AgreementBreached").map((entry) => entry.termIndex)).toEqual([0, 1]);

    // 两条条款的期限 job 都到期后仍不重复记录，也不把协议改回 fulfilled。
    advanceTo(value, 41);
    expectAgreement(value, agreementId, { status: "breached", breachedTerms: [0, 1] });
    expect(eventPayloads(value, "AgreementBreached")).toHaveLength(2);
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);
  });

  it("水闸与通行条款在义务期结束前保持 active，期满未违约才 fulfilled", async () => {
    const value = await harness();
    const waterId = proposeWater(value, [
      { kind: "water-allocation", obligorId: "human-neutral", policy: "harbor-first", untilTick: 20 },
    ]);
    expectAgreement(value, waterId, { status: "active", fulfilledTerms: [0] });

    const passageId = proposePassage(value);
    expectAgreement(value, passageId, { status: "active", fulfilledTerms: [0] });

    // 义务期最后一天仍未到期，协议不能整体标为 fulfilled。
    advanceTo(value, 20);
    expectAgreement(value, waterId, { status: "active" });
    expectAgreement(value, passageId, { status: "active" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);

    // untilTick + 1 的期限 job 确认义务期结束且未违约后才收尾。
    advanceTo(value, 21);
    expectAgreement(value, waterId, { status: "fulfilled", fulfilledTerms: [0] });
    expectAgreement(value, passageId, { status: "fulfilled", fulfilledTerms: [0] });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(2);
  });
});
