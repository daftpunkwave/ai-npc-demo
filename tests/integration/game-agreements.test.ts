/**
 * 验证协议提出、接受、还价、过期、运输履约与违约检查。
 * 依赖真实 SQLite、世界/行动/协议模块与 authority；消费者显式推进。
 * 禁止直接改协议状态或跳过事件消费者。
 */
import type { Json, Term } from "@ai-npc/contracts";
import type { AgreementQueryPorts, TaskView } from "@ai-npc/module-sdk";
import { createAgreementsPort } from "@ai-npc/mod-game-agreements-standard";
import { describe, expect, it } from "vitest";
import {
  acceptAgreement,
  advanceTo,
  agreementCount,
  createMemoryTx,
  dispatchTask,
  executeCommand,
  expectAgreement,
  gameEventTypes,
  jobRows,
  playerAuth,
  proposeAgreement,
  proposeAgreementCommand,
  proposeAndAccept,
  readGameAggregate,
  readGameEventAudience,
  readGameEvents,
  respondAgreement,
  runConsumers,
  setGameClock,
  strategicAuth,
  useStartedGameHarnesses,
  type GameHarness,
} from "./game-agreement-support";

const harness = useStartedGameHarnesses();

/** 玩家向人类中立交付 10 点供给的条款；tick 与数量由调用方指定。 */
function deliveryTerm(byTick: number, amount = 10): Term {
  return {
    kind: "deliver",
    obligorId: "player-1",
    resource: "supply",
    amount,
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    byTick,
  };
}

/** 以玩家身份提出默认的供给交付协议；返回协议 ID。 */
function proposeDelivery(value: GameHarness, expiresInTicks?: number): string {
  return proposeAgreement(
    value,
    playerAuth(value),
    ["player-1", "human-neutral"],
    [deliveryTerm(30)],
    expiresInTicks === undefined ? {} : { expiresInTicks },
  );
}

/** 以玩家身份派遣 10 点供给从灰港到果园；返回任务 ID。 */
function dispatchSupplyTransport(value: GameHarness): string {
  return dispatchTask(value, playerAuth(value), {
    taskType: "transport",
    teamId: "team-commons",
    params: {
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      cargo: { supply: 10, energy: 0, medical: 0 },
    },
  });
}

/** 断言协议事件受众只有当事人，不含 public、system 或无关主体。 */
function expectPartiesOnly(value: GameHarness, type: string, parties: readonly string[]): void {
  const audience = readGameEventAudience(value, type);
  expect(audience).toEqual([{ kind: "principals", ids: [...parties] }]);
  const serialized = JSON.stringify(audience);
  for (const absent of ["public", "system", "human-independent", "npc-cenyan"]) {
    expect(serialized).not.toContain(absent);
  }
}

describe("协议", () => {
  it("提出者已接受，另一方接受后生效", async () => {
    const value = await harness();
    const agreementId = proposeDelivery(value);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({
      status: "proposed",
      responses: { "player-1": "accept" },
    });
    expectPartiesOnly(value, "AgreementProposed", ["player-1", "human-neutral"]);
    const self = respondAgreement(value, playerAuth(value), agreementId, "accept");
    expect(self.commandStatus).toBe("rejected");
    expect(self.reasonCode).toBe("already-responded");
    acceptAgreement(value, strategicAuth(value, "human-neutral"), agreementId);
    expectAgreement(value, agreementId, { status: "active" });
    expectPartiesOnly(value, "AgreementResponded", ["player-1", "human-neutral"]);
    expectPartiesOnly(value, "AgreementActivated", ["player-1", "human-neutral"]);
    expect(gameEventTypes(value).filter((type) => type === "AgreementActivated")).toHaveLength(1);
  });

  it("还价生成 version+1 的新提案并关闭旧提案", async () => {
    const value = await harness();
    const agreementId = proposeDelivery(value);
    const counter = respondAgreement(value, strategicAuth(value, "human-neutral"), agreementId, "counter", [
      deliveryTerm(28, 8),
    ]);
    expect(counter.commandStatus).toBe("accepted");
    const nextId = (counter.result as { readonly agreementId: string }).agreementId;
    expect(nextId).not.toBe(agreementId);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({
      status: "superseded",
      supersededBy: nextId,
    });
    expect(readGameAggregate(value, "agreement", nextId)).toMatchObject({
      version: 2,
      status: "proposed",
      proposerId: "human-neutral",
      responses: { "human-neutral": "accept" },
    });
    expectPartiesOnly(value, "AgreementSuperseded", ["player-1", "human-neutral"]);
    expect(
      readGameEvents(value)
        .filter((event) => event.type === "AgreementProposed")
        .map((event) => event.audience),
    ).toEqual([
      [{ kind: "principals", ids: ["player-1", "human-neutral"] }],
      [{ kind: "principals", ids: ["player-1", "human-neutral"] }],
    ]);
  });

  it("未知当事人被拒绝，且不写入协议或 job", async () => {
    const value = await harness();
    const jobsBefore = jobRows(value).length;
    const proposal = proposeAgreementCommand(
      value,
      playerAuth(value),
      ["player-1", "ghost-principal"],
      [deliveryTerm(30)],
    );
    expect(proposal.commandStatus).toBe("rejected");
    expect(proposal.reasonCode).toBe("unknown-party");
    expect(agreementCount(value)).toBe(0);
    expect(jobRows(value)).toHaveLength(jobsBefore);
  });

  it("超过当事人与条款数量上限的提案在契约层拒绝，不产生状态或 job", async () => {
    const value = await harness();
    const jobsBefore = jobRows(value).length;
    const tooManyParties = proposeAgreementCommand(
      value,
      playerAuth(value),
      ["player-1", ...Array.from({ length: 20 }, (_, index) => `ghost-${index}`)],
      [deliveryTerm(30)],
    );
    expect(tooManyParties.commandStatus).toBe("rejected");
    expect(tooManyParties.reasonCode).toBe("invalid-params");
    const tooManyTerms = proposeAgreementCommand(
      value,
      playerAuth(value),
      ["player-1", "human-neutral"],
      Array.from({ length: 21 }, () => deliveryTerm(30)),
    );
    expect(tooManyTerms.commandStatus).toBe("rejected");
    expect(tooManyTerms.reasonCode).toBe("invalid-params");
    expect(agreementCount(value)).toBe(0);
    expect(jobRows(value)).toHaveLength(jobsBefore);
  });

  it("还价保留原提案的到期 tick，不延长协议生命周期", async () => {
    const value = await harness();
    // 默认有效期 24 tick，原提案的绝对到期 tick 为 24。
    const agreementId = proposeDelivery(value);
    setGameClock(value, { worldTick: 10, mode: "running" });
    const counter = respondAgreement(value, strategicAuth(value, "human-neutral"), agreementId, "counter", [
      deliveryTerm(30, 8),
    ]);
    expect(counter.commandStatus).toBe("accepted");
    const nextId = (counter.result as { readonly agreementId: string }).agreementId;
    expect(readGameAggregate(value, "agreement", nextId)).toMatchObject({
      version: 2,
      expiresAtTick: 24,
    });
  });

  it("还价版本达到上限后拒绝继续还价", async () => {
    const value = await harness();
    let agreementId = proposeDelivery(value);
    const proposer = strategicAuth(value, "human-neutral");
    const otherParty = playerAuth(value);
    // version 从 1 起，每次还价加一；最多到 version 5，即允许四次还价。
    for (let index = 0; index < 4; index += 1) {
      const actor = index % 2 === 0 ? proposer : otherParty;
      const counter = respondAgreement(value, actor, agreementId, "counter", [deliveryTerm(30, 8)]);
      expect(counter.commandStatus).toBe("accepted");
      agreementId = (counter.result as { readonly agreementId: string }).agreementId;
      expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ version: index + 2 });
    }
    const rejected = respondAgreement(value, proposer, agreementId, "counter", [deliveryTerm(30, 8)]);
    expect(rejected.commandStatus).toBe("rejected");
    expect(rejected.reasonCode).toBe("counter-limit-reached");
    expect(agreementCount(value)).toBe(5);
  });

  it("过期 job 关闭未生效提案", async () => {
    const value = await harness();
    const agreementId = proposeDelivery(value, 1);
    advanceTo(value, 2);
    expectAgreement(value, agreementId, { status: "expired" });
    expectPartiesOnly(value, "AgreementExpired", ["player-1", "human-neutral"]);
  });

  it("截止后接受被拒绝", async () => {
    const value = await harness();
    const agreementId = proposeAgreement(
      value,
      playerAuth(value),
      ["player-1", "human-neutral"],
      [deliveryTerm(2)],
      { expiresInTicks: 10 },
    );
    advanceTo(value, 3);
    const accepted = respondAgreement(value, strategicAuth(value, "human-neutral"), agreementId, "accept");
    expect(accepted.commandStatus).toBe("rejected");
    expect(accepted.reasonCode).toBe("deadline-out-of-range");
  });

  it("过期默认 24 tick，显式超过 168 被拒绝", async () => {
    const value = await harness();
    const agreementId = proposeAgreement(
      value,
      playerAuth(value),
      ["player-1", "human-neutral"],
      [deliveryTerm(30)],
    );
    expectAgreement(value, agreementId, { status: "proposed" });
    expect(
      (readGameAggregate(value, "agreement", agreementId) as { readonly expiresAtTick: number })
        .expiresAtTick,
    ).toBe(24);

    const beyond = proposeAgreementCommand(
      value,
      playerAuth(value),
      ["player-1", "human-neutral"],
      [deliveryTerm(30)],
      { expiresInTicks: 169 },
    );
    expect(beyond.commandStatus).toBe("rejected");
    expect(beyond.reasonCode).toBe("deadline-out-of-range");
  });

  it("运输完成触发条款履约与协议完成", async () => {
    const value = await harness();
    const agreementId = proposeDelivery(value);
    acceptAgreement(value, strategicAuth(value, "human-neutral"), agreementId);
    dispatchSupplyTransport(value);
    advanceTo(value, 1);
    advanceTo(value, 7);
    runConsumers(value);
    expectAgreement(value, agreementId, { status: "fulfilled" });
    const events = gameEventTypes(value);
    expect(events).toContain("AgreementTermFulfilled");
    expect(events).toContain("AgreementFulfilled");
    expectPartiesOnly(value, "AgreementTermFulfilled", ["player-1", "human-neutral"]);
    expectPartiesOnly(value, "AgreementFulfilled", ["player-1", "human-neutral"]);
  });

  it("违约事件只发给当事人并排除无关派系", async () => {
    const value = await harness();
    const agreementId = proposeAndAccept(
      value,
      playerAuth(value),
      strategicAuth(value, "human-neutral"),
      ["player-1", "human-neutral"],
      [deliveryTerm(30)],
    );
    advanceTo(value, 31);
    expectAgreement(value, agreementId, { status: "breached" });
    expectPartiesOnly(value, "AgreementBreached", ["player-1", "human-neutral"]);
  });

  it("截止前完成的运输在消费者晚处理时由期限 job 复核履约", async () => {
    const value = await harness();
    const agreementId = proposeDelivery(value);
    acceptAgreement(value, strategicAuth(value, "human-neutral"), agreementId);
    dispatchSupplyTransport(value);
    // 任务在 byTick（30）前完成，但事件消费者不推进。
    advanceTo(value, 1);
    advanceTo(value, 7);
    expectAgreement(value, agreementId, { status: "active", fulfilledTerms: [] });

    // 期限 job 先于消费者看到履约证据：按已提交事实记履约，不能判违约。
    advanceTo(value, 31);
    expectAgreement(value, agreementId, { status: "fulfilled", fulfilledTerms: [0], breachedTerms: [] });
    expect(gameEventTypes(value)).not.toContain("AgreementBreached");

    // 消费者补跑已处理过的任务事实：不重复记条款履约或协议履约。
    runConsumers(value);
    const types = gameEventTypes(value);
    expect(types.filter((type) => type === "AgreementTermFulfilled")).toHaveLength(1);
    expect(types.filter((type) => type === "AgreementFulfilled")).toHaveLength(1);
    expect(types).not.toContain("AgreementBreached");
  });

  it("分享发生在期限内的证据在消费者晚处理时按事件 tick 计入履约", async () => {
    const value = await harness();
    const agreementId = proposeAgreement(
      value,
      playerAuth(value),
      ["player-1", "human-neutral"],
      [
        {
          kind: "share-evidence",
          obligorId: "player-1",
          evidenceId: "ev-water-ledger",
          toPrincipalId: "human-neutral",
          byTick: 50,
        },
      ],
    );
    acceptAgreement(value, strategicAuth(value, "human-neutral"), agreementId);

    setGameClock(value, { worldTick: 5, mode: "running" });
    const share = executeCommand(value, playerAuth(value), "information.share", {
      evidenceId: "ev-water-ledger",
      audience: ["human-neutral"],
    });
    expect(share.commandStatus).toBe("accepted");

    // 消费者在期限之后才追平：按事件发生的 tick（5）判定，而不是消费时钟。
    setGameClock(value, { worldTick: 60, mode: "running" });
    runConsumers(value);
    expectAgreement(value, agreementId, { status: "fulfilled", fulfilledTerms: [0], breachedTerms: [] });

    // 期限 job 晚到同样按已提交分享事实复核，不重复计数。
    value.authority.jobs.runDue(value.branchId, 60);
    const types = gameEventTypes(value);
    expect(types.filter((type) => type === "AgreementTermFulfilled")).toHaveLength(1);
    expect(types.filter((type) => type === "AgreementFulfilled")).toHaveLength(1);
    expect(types).not.toContain("AgreementBreached");
  });

  it("替换行动、通信、世界与地图查询端口后协议统计仍正确", () => {
    const tx = createMemoryTx(30);
    tx.put(
      "agreement",
      "agr-000000000001",
      activeAgreement({ agreementId: "agr-000000000001", terms: [deliveryTerm(30)] }),
    );
    tx.put(
      "agreement",
      "agr-000000000002",
      activeAgreement({
        agreementId: "agr-000000000002",
        terms: [
          {
            kind: "share-evidence",
            obligorId: "player-1",
            evidenceId: "ev-water-ledger",
            toPrincipalId: "human-neutral",
            byTick: 40,
          },
        ],
      }),
    );
    tx.put(
      "agreement",
      "agr-000000000003",
      activeAgreement({
        agreementId: "agr-000000000003",
        terms: [
          {
            kind: "water-allocation",
            obligorId: "human-neutral",
            policy: "harbor-first",
            untilTick: 10,
          },
        ],
      }),
    );
    tx.put(
      "agreement",
      "agr-000000000004",
      activeAgreement({
        agreementId: "agr-000000000004",
        terms: [
          {
            kind: "grant-passage",
            obligorId: "human-neutral",
            roadId: "r-gh-ps",
            granteeFactionId: "human-neutral",
            untilTick: 40,
          },
        ],
      }),
    );

    const completedTask: TaskView = {
      taskId: "task-000000000001",
      taskType: "transport",
      teamId: "team-commons",
      // 公社党魁派遣本派系队伍；义务人写成 campaign 玩家 player-1，靠主体派系映射归到一起。
      dispatcherId: "human-neutral",
      invitees: [],
      participants: [],
      status: "completed",
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        cargo: { supply: 10, energy: 0, medical: 0 },
      },
      route: ["r-gh-or"],
      departTick: 1,
      nominalCompletionTick: 5,
      completedAtTick: 5,
      delayNoticeSent: false,
    };
    let shareQueries = 0;
    let roadQueries = 0;
    const queries: AgreementQueryPorts = {
      actions: { completedTasks: () => [completedTask] },
      comms: {
        hasShare: (query) => {
          shareQueries += 1;
          return (
            query.fromId === "player-1" &&
            query.evidenceId === "ev-water-ledger" &&
            query.toPrincipalId === "human-neutral" &&
            query.sinceTick === 0 &&
            query.byTick === 40
          );
        },
      },
      world: {
        meters: () => ({
          "relay.stability": 45,
          "orchard.water": 50,
          "migration.safety": 50,
          "watergate.allocation": "harbor-first",
        }),
        teams: () => [
          {
            teamId: "team-commons",
            ownerFactionId: "human-neutral",
            nodeId: "grayharbor",
            capabilities: ["transport"],
            capacity: 2,
            status: "idle",
            busyUntilTick: null,
            currentTaskId: null,
          },
        ],
        // 当前 campaign 的玩家是 player-1，按映射代表 human-neutral。
        campaign: () => ({
          campaignId: "cmp-000000000001",
          factionId: "human-neutral",
          playerId: "player-1",
          chapterId: "watergate",
          startTick: 0,
          status: "running",
          outcome: null,
        }),
      },
      map: {
        roadStatus: (roadId) => {
          roadQueries += 1;
          return roadId === "r-gh-ps" ? "closed" : "open";
        },
      },
    };
    const port = createAgreementsPort(
      () => tx,
      queries,
      new Map<string, unknown>([["human-neutral", {}]]),
    );
    // 三条由替换端口提供的事实满足：完成任务、证据分享、水闸分配；
    // 仍在义务期的通行条款因道路关闭计为违约。
    expect(port.countsAsOf(30)).toEqual({ fulfilled: 3, breached: 1 });
    expect(shareQueries).toBe(1);
    expect(roadQueries).toBe(1);
  });
});

/** 构造一份已生效的协议状态；统计只读取这些已提交字段。 */
function activeAgreement(input: {
  readonly agreementId: string;
  readonly terms: readonly Term[];
}): Json {
  return {
    agreementId: input.agreementId,
    version: 1,
    proposerId: "player-1",
    parties: ["player-1", "human-neutral"],
    terms: [...input.terms],
    responses: { "player-1": "accept", "human-neutral": "accept" },
    status: "active",
    createdAtTick: 0,
    activatedAtTick: 0,
    expiresAtTick: 100,
    supersedesId: null,
    supersededBy: null,
    fulfilledTerms: [],
    breachedTerms: [],
    progress: input.terms.map(() => 0),
  } as unknown as Json;
}
