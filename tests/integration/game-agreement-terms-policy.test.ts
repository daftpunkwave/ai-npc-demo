/**
 * 验证由政策与事实触发的协议条款（证据分享、道路通行、水闸分配、委托）及条款校验边界。
 * 依赖真实 SQLite、世界/地图/行动/通信/协议模块与 authority；生效写入、持续义务与期限经消费者和 job 推进。
 * 禁止直接修改协议聚合、伪造生效授权或绕过命令网关。
 */
import type { Term } from "@world-prism/contracts";
import { describe, expect, it } from "vitest";
import {
  advanceToWithConsumers,
  agreementCount,
  executeCommand,
  expectAgreement,
  expectTermBreached,
  expectTermFulfilled,
  eventPayloads,
  jobRows,
  playerAuth,
  proposeAgreementCommand,
  proposeAsPlayer,
  runConsumers,
  setGameClock,
  strategicAuth,
  useStartedGameHarnesses,
  type GameHarness,
  type Receipt,
  type TermEventPayload,
} from "./game-agreement-support";

const harness = useStartedGameHarnesses();

/** 证据分享条款；默认在 tick 20 前完成。 */
function shareEvidenceTerm(byTick = 20): Term {
  return {
    kind: "share-evidence",
    obligorId: "player-1",
    evidenceId: "ev-water-ledger",
    toPrincipalId: "human-neutral",
    byTick,
  };
}

/** 道路通行条款；默认开放到 tick 20。 */
function passageTerm(untilTick = 20): Term {
  return {
    kind: "grant-passage",
    obligorId: "human-independent",
    roadId: "r-gh-ps",
    granteeFactionId: "species-fauna",
    untilTick,
  };
}

/** 水闸分配条款；policy 与期限由调用方指定。 */
function waterTerm(policy: "harbor-first" | "rotation", untilTick = 20): Term {
  return { kind: "water-allocation", obligorId: "human-neutral", policy, untilTick };
}

/** 水闸分配条款；义务人、policy 与期限由调用方指定。 */
function waterTermFor(obligorId: string, policy: "harbor-first" | "rotation", untilTick = 20): Term {
  return { kind: "water-allocation", obligorId, policy, untilTick };
}

/** 玩家提出通行条款，由道路控制方接受。 */
function proposePassage(value: GameHarness): string {
  return proposeAsPlayer(value, "human-independent", ["player-1", "human-independent"], [passageTerm()]);
}

/** 玩家提出水闸分配条款，由人类中立接受。 */
function proposeWater(value: GameHarness, terms: readonly Term[]): string {
  return proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], terms);
}

/** 断言持续义务生效期：两份协议各记条款履约，但整份协议尚未收尾。 */
function expectContinuousActive(value: GameHarness, agreementId: string, obligorId: string): void {
  expectTermFulfilled(value, {
    agreementId,
    termIndex: 0,
    obligorId,
    agreementStatus: "active",
    termFulfilledEvents: 2,
    agreementFulfilledEvents: 0,
  });
}

/** 断言持续义务期满：两份协议各自 fulfilled。 */
function expectContinuousFulfilled(value: GameHarness, agreementId: string, obligorId: string): void {
  expectTermFulfilled(value, {
    agreementId,
    termIndex: 0,
    obligorId,
    termFulfilledEvents: 2,
    agreementFulfilledEvents: 2,
  });
}

describe("协议条款履约", () => {
  it("share-evidence 在 byTick 前分享给约定主体后条款履约", async () => {
    const value = await harness();
    const agreementId = proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
      shareEvidenceTerm(),
    ]);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [] });
    // 玩家在灰港公社开局时持有水闸分水账；分享真实走 information.share。
    setGameClock(value, { worldTick: 5, mode: "running" });
    const share = executeCommand(value, playerAuth(value), "information.share", {
      evidenceId: "ev-water-ledger",
      audience: ["human-neutral"],
    });
    expect(share.commandStatus).toBe("accepted");

    runConsumers(value);
    expectTermFulfilled(value, { agreementId, termIndex: 0, obligorId: "player-1" });
    const shared = eventPayloads<{ readonly evidenceId: string; readonly audience: readonly string[] }>(
      value,
      "InformationShared",
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ evidenceId: "ev-water-ledger", audience: ["human-neutral"] });
  });

  it("share-evidence 未在 byTick 前分享时 byTick+1 违约", async () => {
    const value = await harness();
    const agreementId = proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
      shareEvidenceTerm(),
    ]);
    expectAgreement(value, agreementId, { status: "active" });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "player-1" });
  });

  it("share-evidence 保持精确主体匹配，其他主体分享不计入玩家义务", async () => {
    const value = await harness();
    const agreementId = proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
      shareEvidenceTerm(),
    ]);
    setGameClock(value, { worldTick: 5, mode: "running" });
    // 温原持有水闸分水账，但不是条款义务人；派系归属映射不扩大个人知识授权。
    const share = executeCommand(value, strategicAuth(value, "npc-wenyuan"), "information.share", {
      evidenceId: "ev-water-ledger",
      audience: ["human-neutral"],
    });
    expect(share.commandStatus).toBe("accepted");
    runConsumers(value);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [] });

    advanceToWithConsumers(value, 21);
    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "player-1" });
  });

  it("grant-passage 与 water-allocation 生效即履约，义务期内违反持续义务时记违约", async () => {
    const value = await harness();
    const passageId = proposePassage(value);
    const waterId = proposeWater(value, [waterTerm("harbor-first")]);
    // 生效即记条款履约；untilTick 之前仍有持续义务，整份协议保持 active。
    expectContinuousActive(value, passageId, "human-independent");
    expectContinuousActive(value, waterId, "human-neutral");
    expect(
      eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled").map((payload) => payload.agreementId),
    ).toEqual([passageId, waterId]);
    expect(eventPayloads(value, "PassageGranted")).toHaveLength(1);

    // 义务人在义务期内关闭道路并改分配：两条持续义务分别违约。
    setGameClock(value, { worldTick: 5, mode: "running" });
    const close = executeCommand(value, strategicAuth(value, "human-independent"), "policy.set", {
      key: "road.status:r-gh-ps",
      value: "closed",
    });
    expect(close.commandStatus).toBe("accepted");
    const reallocate = executeCommand(value, strategicAuth(value, "human-neutral"), "policy.set", {
      key: "watergate.allocation",
      value: "rotation",
    });
    expect(reallocate.commandStatus).toBe("accepted");
    runConsumers(value);

    expectTermBreached(value, passageId, {
      termIndex: 0,
      obligorId: "human-independent",
      breachEvents: 2,
    });
    expectTermBreached(value, waterId, {
      termIndex: 0,
      obligorId: "human-neutral",
      breachEvents: 2,
    });
  });

  it("grant-passage 与 water-allocation 期满未违约，untilTick+1 后整份协议 fulfilled", async () => {
    const value = await harness();
    const passageId = proposePassage(value);
    // 用与当前分配不同的值，验证生效写入本身不会被当成违约。
    const waterId = proposeWater(value, [waterTerm("rotation")]);
    expectContinuousActive(value, waterId, "human-neutral");
    // 生效写入真实改变了分配；这条 PolicyChanged 不能算义务期内违约。
    expect(eventPayloads<{ readonly key: string; readonly newValue: string }>(value, "PolicyChanged")).toEqual([
      expect.objectContaining({ key: "watergate.allocation", newValue: "rotation" }),
    ]);

    advanceToWithConsumers(value, 20);
    expectAgreement(value, passageId, { status: "active" });
    expectAgreement(value, waterId, { status: "active" });
    expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);

    advanceToWithConsumers(value, 21);
    expectContinuousFulfilled(value, passageId, "human-independent");
    expectContinuousFulfilled(value, waterId, "human-neutral");
  });

  it("delegate 生效即履约且整份协议 fulfilled，不安排违约检查 job", async () => {
    const value = await harness();
    const agreementId = proposeAsPlayer(value, "human-neutral", ["player-1", "human-neutral"], [
      {
        kind: "delegate",
        obligorId: "human-neutral",
        granteeId: "player-1",
        teamIds: ["team-commons"],
        stockpileId: "sp-commons",
        maxDraw: { supply: 5, energy: 2, medical: 0 },
        untilTick: 20,
      },
    ]);
    expectTermFulfilled(value, {
      agreementId,
      termIndex: 0,
      obligorId: "human-neutral",
      evidenceEventIds: [],
    });
    // 首版没有撤销命令：delegate 不安排 agreement.breach job。
    expect(
      jobRows(value).filter(
        (job) => job.kind === "agreement.breach" && job.idempotencyKey.startsWith(`agreement-breach:${agreementId}:`),
      ),
    ).toHaveLength(0);
  });

  it("派系为水闸义务人时，占席玩家改分配记为违约", async () => {
    const value = await harness();
    // 义务人写派系主体，实际改分配的是该派系 campaign 的玩家。
    const agreementId = proposeWater(value, [waterTerm("harbor-first")]);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [0], breachedTerms: [] });

    setGameClock(value, { worldTick: 5, mode: "running" });
    const reallocate = executeCommand(value, playerAuth(value), "policy.set", {
      key: "watergate.allocation",
      value: "rotation",
    });
    expect(reallocate.commandStatus).toBe("accepted");
    runConsumers(value);

    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "human-neutral" });
  });

  it("玩家为水闸义务人时，派系主体改分配记为违约", async () => {
    const value = await harness();
    const agreementId = proposeWater(value, [waterTermFor("player-1", "harbor-first")]);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [0], breachedTerms: [] });

    setGameClock(value, { worldTick: 5, mode: "running" });
    const reallocate = executeCommand(value, strategicAuth(value, "human-neutral"), "policy.set", {
      key: "watergate.allocation",
      value: "rotation",
    });
    expect(reallocate.commandStatus).toBe("accepted");
    runConsumers(value);

    expectTermBreached(value, agreementId, { termIndex: 0, obligorId: "player-1" });
  });
});

describe("条款校验边界", () => {
  it("非 delegate 条款的 byTick 与 untilTick 必须晚于当前 tick 且不超过当前 +168", async () => {
    const value = await harness();
    const proposeEscort = (byTick: number): Receipt =>
      proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-independent"], [
        { kind: "escort", obligorId: "human-independent", roadId: "r-gh-ps", byTick },
      ]);
    const proposeWaterCommand = (untilTick: number): Receipt =>
      proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
        waterTerm("rotation", untilTick),
      ]);

    for (const proposal of [proposeEscort(0), proposeWaterCommand(0), proposeEscort(169), proposeWaterCommand(169)]) {
      expect(proposal.commandStatus).toBe("rejected");
      expect(proposal.reasonCode).toBe("deadline-out-of-range");
    }
    expect(agreementCount(value)).toBe(0);

    expect(proposeEscort(168).commandStatus).toBe("accepted");
    expect(agreementCount(value)).toBe(1);
    expect(proposeWaterCommand(168).commandStatus).toBe("accepted");
    expect(agreementCount(value)).toBe(2);
  });

  it("义务人缺少条款所需授权时提出被拒且零写入", async () => {
    const value = await harness();
    // 玩家对 sp-rubble 没有动用权。
    const deliver = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
      {
        kind: "deliver",
        obligorId: "player-1",
        resource: "supply",
        amount: 5,
        fromStockpileId: "sp-rubble",
        toStockpileId: "sp-earth",
        byTick: 20,
      },
    ]);
    expect(deliver.commandStatus).toBe("rejected");
    expect(deliver.reasonCode).toBe("invalid-terms");
    // 祁录不持有水闸分水账。
    const share = proposeAgreementCommand(value, playerAuth(value), ["player-1", "npc-qilu"], [
      {
        kind: "share-evidence",
        obligorId: "npc-qilu",
        evidenceId: "ev-water-ledger",
        toPrincipalId: "human-neutral",
        byTick: 20,
      },
    ]);
    expect(share.commandStatus).toBe("rejected");
    expect(share.reasonCode).toBe("invalid-terms");
    // 水闸分配只能由占公社席的玩家承担；其他派系党魁没有授权。
    const water = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-pacifist"], [
      { kind: "water-allocation", obligorId: "human-pacifist", policy: "rotation", untilTick: 20 },
    ]);
    expect(water.commandStatus).toBe("rejected");
    expect(water.reasonCode).toBe("invalid-terms");
    // r-gh-ps 的控制方是 human-independent，human-neutral 不是控制方战略 Agent。
    const passage = proposeAgreementCommand(value, playerAuth(value), ["player-1", "human-neutral"], [
      {
        kind: "grant-passage",
        obligorId: "human-neutral",
        roadId: "r-gh-ps",
        granteeFactionId: "species-fauna",
        untilTick: 20,
      },
    ]);
    expect(passage.commandStatus).toBe("rejected");
    expect(passage.reasonCode).toBe("invalid-terms");

    expect(agreementCount(value)).toBe(0);
    expect(eventPayloads(value, "AgreementProposed")).toHaveLength(0);
  });
});
