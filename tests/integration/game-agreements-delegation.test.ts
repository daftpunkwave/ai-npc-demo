/**
 * 验证委托与通行/水闸条款的签发资格、生效写入、期限边界与仅队伍委托。
 * 依赖真实 SQLite、世界/地图/行动/协议模块与 authority；直接断言持久化事件与聚合，不依赖消费者推进。
 * 禁止直接改协议状态、伪造生效授权或绕过命令网关。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuthContext, Json } from "@ai-npc/contracts";
import { createWorldPort } from "@ai-npc/mod-game-world-slg-light";
import {
  createMemoryTx,
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

/** 以指定主体提出协议；条款按需由调用方构造。 */
function proposeAs(value: GameHarness, auth: AuthContext, parties: readonly string[], terms: readonly Json[]): Receipt {
  return value.authority.commands.execute(
    auth,
    gameCommandEnvelope(
      "agreement.propose",
      { parties: [...parties], terms: [...terms] },
      value.host.ids("cmd"),
    ),
  );
}

/** 以玩家身份提出协议。 */
function propose(value: GameHarness, parties: readonly string[], terms: readonly Json[]): Receipt {
  return proposeAs(value, playerAuth(value), parties, terms);
}

/** 以指定主体接受协议。 */
function respondAccept(value: GameHarness, auth: AuthContext, agreementId: string): Receipt {
  return value.authority.commands.execute(
    auth,
    gameCommandEnvelope("agreement.respond", { agreementId, response: "accept" }, value.host.ids("cmd")),
  );
}

/** 以指定战略 Agent 身份接受协议。 */
function accept(value: GameHarness, agreementId: string, agentId: string): Receipt {
  return respondAccept(value, strategicAuth(value, agentId), agreementId);
}

/** 读取指定事件类型的全部 payload。 */
function eventPayloads<T>(value: GameHarness, type: string): readonly T[] {
  return readGameEvents(value)
    .filter((event) => event.type === type)
    .map((event) => event.payload as unknown as T);
}

/** 当前分支的协议聚合数量，用于断言拒绝后没有业务写入。 */
function agreementCount(value: GameHarness): number {
  return value.storage.transact((tx) =>
    tx.branch(value.branchId).table("aggregate_state").count({ aggregate_type: "agreement" }),
  );
}

/** 以玩家身份派遣 team-rubble 护送 r-gh-ps；不需要库存预留。 */
function dispatchEscort(value: GameHarness): Receipt {
  return value.authority.commands.execute(
    playerAuth(value),
    gameCommandEnvelope(
      "task.dispatch",
      { taskType: "escort", teamId: "team-rubble", params: { roadId: "r-gh-ps" } },
      value.host.ids("cmd"),
    ),
  );
}

function delegateTerm(overrides: {
  readonly obligorId: string;
  readonly granteeId: string;
  readonly teamIds: readonly string[];
  readonly stockpileId: string | null;
  readonly maxDraw?: { readonly supply: number; readonly energy: number; readonly medical: number };
  readonly untilTick: number;
}): Json {
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

describe("协议委托与授权", () => {
  it("战略 Agent 的库存与队伍委托生效时创建完整委托", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const proposal = proposeAs(value, strategicAuth(value, "human-neutral"), ["human-neutral", "player-1"], [
      delegateTerm({
        obligorId: "human-neutral",
        granteeId: "player-1",
        teamIds: ["team-commons"],
        stockpileId: "sp-commons",
        untilTick: 20,
      }),
    ]);
    expect(proposal.commandStatus).toBe("accepted");
    const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
    expect(respondAccept(value, playerAuth(value), agreementId).commandStatus).toBe("accepted");
    const created = eventPayloads<{
      readonly delegationId: string;
      readonly grantorFactionId: string;
      readonly granteeId: string;
      readonly teamIds: readonly string[];
      readonly stockpileId: string | null;
      readonly untilTick: number;
    }>(value, "DelegationCreated").at(-1);
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
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
    });
  });

  it("仅委托队伍的 null 库存委托可创建、可派遣队伍但无库存动用权", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const before = dispatchEscort(value);
    expect(before.commandStatus).toBe("rejected");
    expect(before.reasonCode).toBe("no-authority");
    const proposal = propose(value, ["player-1", "human-independent"], [
      delegateTerm({
        obligorId: "human-independent",
        granteeId: "player-1",
        teamIds: ["team-rubble"],
        stockpileId: null,
        maxDraw: { supply: 0, energy: 0, medical: 0 },
        untilTick: 20,
      }),
    ]);
    expect(proposal.commandStatus).toBe("accepted");
    const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
    expect(accept(value, agreementId, "human-independent").commandStatus).toBe("accepted");
    const created = eventPayloads<{
      readonly delegationId: string;
      readonly grantorFactionId: string;
      readonly granteeId: string;
      readonly teamIds: readonly string[];
      readonly stockpileId: string | null;
    }>(value, "DelegationCreated").at(-1);
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
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    expect(agreementCount(value)).toBe(0);
    const byPlayer = propose(value, ["player-1", "human-neutral"], [
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
    const byCharacter = propose(value, ["player-1", "npc-wenyuan"], [
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
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const foreignTeam = propose(value, ["player-1", "human-neutral"], [
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
    const foreignStockpile = propose(value, ["player-1", "human-neutral"], [
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
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const withUntilTick = (untilTick: number): Receipt =>
      propose(value, ["player-1", "human-neutral"], [
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
    expect(
      accept(value, (atBoundary.result as { readonly agreementId: string }).agreementId, "human-neutral").commandStatus,
    ).toBe("accepted");

    const short = withUntilTick(2);
    expect(short.commandStatus).toBe("accepted");
    const shortId = (short.result as { readonly agreementId: string }).agreementId;
    setGameClock(value, { worldTick: 3, mode: "running" });
    const expired = accept(value, shortId, "human-neutral");
    expect(expired.commandStatus).toBe("rejected");
    expect(expired.reasonCode).toBe("deadline-out-of-range");
    expect(readGameAggregate(value, "agreement", shortId)).toMatchObject({ status: "proposed" });
  });

  it("通行条款只能由道路控制方的战略 Agent 生效", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const sameFactionCharacter = propose(value, ["player-1", "npc-cenyan"], [
      {
        kind: "grant-passage",
        obligorId: "npc-cenyan",
        roadId: "r-gh-ps",
        granteeFactionId: "species-fauna",
        untilTick: 20,
      },
    ]);
    expect(sameFactionCharacter.commandStatus).toBe("rejected");
    expect(sameFactionCharacter.reasonCode).toBe("invalid-terms");
    const valid = proposeAs(value, strategicAuth(value, "human-independent"), ["human-independent", "player-1"], [
      {
        kind: "grant-passage",
        obligorId: "human-independent",
        roadId: "r-gh-ps",
        granteeFactionId: "species-fauna",
        untilTick: 20,
      },
    ]);
    expect(valid.commandStatus).toBe("accepted");
    const agreementId = (valid.result as { readonly agreementId: string }).agreementId;
    expect(respondAccept(value, playerAuth(value), agreementId).commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "active" });
    expect(eventPayloads(value, "PassageGranted")).toEqual([
      expect.objectContaining({ roadId: "r-gh-ps", granteeFactionId: "species-fauna", untilTick: 20 }),
    ]);
  });

  it("水闸分配已等于条款值时生效成功且不视为写入失败", async () => {
    const value = await harness();
    expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
    const proposal = propose(value, ["player-1", "human-neutral"], [
      {
        kind: "water-allocation",
        obligorId: "human-neutral",
        policy: "harbor-first",
        untilTick: 20,
      },
    ]);
    expect(proposal.commandStatus).toBe("accepted");
    const agreementId = (proposal.result as { readonly agreementId: string }).agreementId;
    expect(accept(value, agreementId, "human-neutral").commandStatus).toBe("accepted");
    expect(readGameAggregate(value, "agreement", agreementId)).toMatchObject({ status: "active" });
    expect(eventPayloads(value, "AgreementActivated")).toHaveLength(1);
    expect(eventPayloads(value, "PolicyChanged")).toHaveLength(0);
  });
});
