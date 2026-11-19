/**
 * 验证协议提出、接受、还价、过期、运输履约与违约检查。
 * 依赖真实 SQLite、世界/行动/协议模块与 authority；消费者显式推进。
 * 禁止直接改协议状态或跳过事件消费者。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
  readGameEvents,
  readGameEventAudience,
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

function start(value: GameHarness): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return startNeutralCampaign(value);
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

function proposeDelivery(value: GameHarness, expiresInTicks?: number): string {
  const command = value.authority.commands.execute(
    playerAuth(value),
    gameCommandEnvelope(
      "agreement.propose",
      {
        parties: ["player-1", "human-neutral"],
        terms: [
          {
            kind: "deliver",
            obligorId: "player-1",
            resource: "supply",
            amount: 10,
            fromStockpileId: "sp-commons",
            toStockpileId: "sp-earth",
            byTick: 30,
          },
        ],
        ...(expiresInTicks === undefined ? {} : { expiresInTicks }),
      },
      value.host.ids("cmd"),
    ),
  );
  expect(command.commandStatus).toBe("accepted");
  return (command.result as { readonly agreementId: string }).agreementId;
}

/** 以人类中立战略 Agent 接受协议。 */
function acceptByNeutral(value: GameHarness, agreementId: string): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return value.authority.commands.execute(
    strategicAuth(value, "human-neutral"),
    gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
  );
}

describe("协议", () => {
  it("提出者已接受，另一方接受后生效", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = proposeDelivery(value);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({
      status: "proposed",
      responses: { "player-1": "accept" },
    });
    expectPartiesOnly(value, "AgreementProposed", ["player-1", "human-neutral"]);
    const self = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(self.commandStatus).toBe("rejected");
    expect(self.reasonCode).toBe("already-responded");
    const accepted = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "active" });
    expectPartiesOnly(value, "AgreementResponded", ["player-1", "human-neutral"]);
    expectPartiesOnly(value, "AgreementActivated", ["player-1", "human-neutral"]);
    expect(readGameEvents(value).filter((event) => event.type === "AgreementActivated")).toHaveLength(1);
  });

  it("还价生成 version+1 的新提案并关闭旧提案", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = proposeDelivery(value);
    const counter = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope(
        "agreement.respond",
        {
          agreementId,
          response: "counter",
          counterTerms: [
            {
              kind: "deliver",
              obligorId: "player-1",
              resource: "supply",
              amount: 8,
              fromStockpileId: "sp-commons",
              toStockpileId: "sp-earth",
              byTick: 28,
            },
          ],
        },
        value.host.ids("cmd"),
      ),
    );
    expect(counter.commandStatus).toBe("accepted");
    const nextId = (counter.result as { readonly agreementId: string }).agreementId;
    expect(nextId).not.toBe(agreementId);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "superseded", supersededBy: nextId });
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

  it("过期 job 关闭未生效提案", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = proposeDelivery(value, 1);
    setGameClock(value, { worldTick: 2, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 2);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "expired" });
    expectPartiesOnly(value, "AgreementExpired", ["player-1", "human-neutral"]);
  });

  it("截止后接受被拒绝", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const proposal = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "agreement.propose",
        {
          parties: ["player-1", "human-neutral"],
          terms: [
            {
              kind: "deliver",
              obligorId: "player-1",
              resource: "supply",
              amount: 10,
              fromStockpileId: "sp-commons",
              toStockpileId: "sp-earth",
              byTick: 2,
            },
          ],
          expiresInTicks: 10,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(proposal.commandStatus).toBe("accepted");
    const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
    setGameClock(value, { worldTick: 3, mode: "running" });
    const accepted = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("rejected");
    expect(accepted.reasonCode).toBe("deadline-out-of-range");
  });

  it("运输完成触发条款履约与协议完成", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = proposeDelivery(value);
    const accepted = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    const dispatch = value.authority.commands.execute(
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
    expect(dispatch.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    setGameClock(value, { worldTick: 7, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 7);
    value.authority.consumers.run(value.branchId);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "fulfilled" });
    const events = readGameEvents(value).map((event) => event.type);
    expect(events).toContain("AgreementTermFulfilled");
    expect(events).toContain("AgreementFulfilled");
    expectPartiesOnly(value, "AgreementTermFulfilled", ["player-1", "human-neutral"]);
    expectPartiesOnly(value, "AgreementFulfilled", ["player-1", "human-neutral"]);
  });

  it("违约事件只发给当事人并排除无关派系", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = proposeDelivery(value);
    const accepted = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
    );
    expect(accepted.commandStatus).toBe("accepted");
    setGameClock(value, { worldTick: 31, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 31);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "breached" });
    expectPartiesOnly(value, "AgreementBreached", ["player-1", "human-neutral"]);
  });

  it("截止前完成的运输在消费者晚处理时由期限 job 复核履约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const agreementId = proposeDelivery(value);
    expect(acceptByNeutral(value, agreementId).commandStatus).toBe("accepted");
    const dispatch = value.authority.commands.execute(
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
    expect(dispatch.commandStatus).toBe("accepted");
    // 任务在 byTick（30）前完成，但事件消费者不推进。
    setGameClock(value, { worldTick: 1, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 1);
    setGameClock(value, { worldTick: 7, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 7);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "active", fulfilledTerms: [] });

    // 期限 job 先于消费者看到履约证据：按已提交事实记履约，不能判违约。
    setGameClock(value, { worldTick: 31, mode: "running" });
    value.authority.jobs.runDue(value.branchId, 31);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    expect(readGameEvents(value).map((event) => event.type)).not.toContain("AgreementBreached");

    // 消费者补跑已处理过的任务事实：不重复记条款履约或协议履约。
    value.authority.consumers.run(value.branchId);
    const types = readGameEvents(value).map((event) => event.type);
    expect(types.filter((type) => type === "AgreementTermFulfilled")).toHaveLength(1);
    expect(types.filter((type) => type === "AgreementFulfilled")).toHaveLength(1);
    expect(types).not.toContain("AgreementBreached");
  });

  it("分享发生在期限内的证据在消费者晚处理时按事件 tick 计入履约", async () => {
    const value = await harness();
    expect(start(value).commandStatus).toBe("accepted");
    const proposal = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "agreement.propose",
        {
          parties: ["player-1", "human-neutral"],
          terms: [
            {
              kind: "share-evidence",
              obligorId: "player-1",
              evidenceId: "ev-water-ledger",
              toPrincipalId: "human-neutral",
              byTick: 50,
            },
          ],
        },
        value.host.ids("cmd"),
      ),
    );
    expect(proposal.commandStatus).toBe("accepted");
    const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
    expect(acceptByNeutral(value, agreementId).commandStatus).toBe("accepted");

    setGameClock(value, { worldTick: 5, mode: "running" });
    const share = value.authority.commands.execute(
      playerAuth(value),
      gameCommandEnvelope(
        "information.share",
        { evidenceId: "ev-water-ledger", audience: ["human-neutral"] },
        value.host.ids("cmd"),
      ),
    );
    expect(share.commandStatus).toBe("accepted");

    // 消费者在期限之后才追平：按事件发生的 tick（5）判定，而不是消费时钟。
    setGameClock(value, { worldTick: 60, mode: "running" });
    value.authority.consumers.run(value.branchId);
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });

    // 期限 job 晚到同样按已提交分享事实复核，不重复计数。
    value.authority.jobs.runDue(value.branchId, 60);
    const types = readGameEvents(value).map((event) => event.type);
    expect(types.filter((type) => type === "AgreementTermFulfilled")).toHaveLength(1);
    expect(types.filter((type) => type === "AgreementFulfilled")).toHaveLength(1);
    expect(types).not.toContain("AgreementBreached");
  });
});
