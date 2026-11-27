/**
 * 核心职责：验证 `knowledge.seed` 只在实验分支、开局之后与首个 tick 之前由系统世界身份发行，
 * 并按通信模块的知识授权语义产生面向受授主体的 `KnowledgeGranted`。
 * 交互契约：使用真实 SQLite、内容包与 authority 命令网关；测试分支由支架登记，按用例改写分支种类与时钟。
 * 约束与禁忌：禁止用测试内自建处理器替代真实注册；断言覆盖发行者、分支种类、时点与重放幂等四条边界。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSystemAuth } from "@world-prism/authority";
import type { Json } from "@world-prism/contracts";
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

/** 把测试分支改为指定种类；网关每次执行都从分支行读取种类。 */
function setBranchKind(harness: GameHarness, kind: "online" | "experiment" | "sandbox"): void {
  harness.storage.transact((tx) => {
    const branch = tx.rows("branches").get({ branch_id: harness.branchId });
    if (branch === null) throw new Error("缺少测试分支行");
    tx.rows("branches").put({ ...branch, kind });
  });
}

/** 已开局的实验分支，时钟停在 tick 0。 */
async function startedExperiment(): Promise<GameHarness> {
  const harness = await createTrackedGameHarness(active);
  setBranchKind(harness, "experiment");
  expect(startNeutralCampaign(harness).commandStatus).toBe("accepted");
  return harness;
}

function seed(harness: GameHarness, payload: Json, commandId = harness.host.ids("cmd")) {
  return harness.authority.commands.execute(
    createSystemAuth(harness.worldId, harness.branchId),
    gameCommandEnvelope("knowledge.seed", payload, commandId),
  );
}

/** 预置途径产生的授权事件；开局本身也会以 `start` 途径授予知识，这里只看 `setup`。 */
function setupGrants(harness: GameHarness) {
  return readGameEvents(harness).filter(
    (event) => event.type === "KnowledgeGranted" && (event.payload as { via?: unknown }).via === "setup",
  );
}

const floodLogToPlayer = { evidenceId: "ev-flood-log", principalId: "player-1" };

describe("实验预置知识命令", () => {
  it("开局后、首个 tick 前在实验分支授予知识，事件只面向受授主体", async () => {
    const harness = await startedExperiment();

    const receipt = seed(harness, floodLogToPlayer);

    expect(receipt.commandStatus).toBe("accepted");
    const grants = setupGrants(harness);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.payload).toMatchObject({ principalId: "player-1", itemId: "ev-flood-log", via: "setup" });
    expect(grants[0]?.worldTick).toBe(0);
    expect(grants[0]?.audience).toEqual([{ kind: "principals", ids: ["player-1"] }]);
    // 授权落在通信模块的知识聚合上，与开局、分享、发现走同一份状态。
    const grantId = (grants[0]?.payload as { grantId: string }).grantId;
    expect(readGameAggregate(harness, "knowledge-grant", "player-1:ev-flood-log:setup")).toMatchObject({ grantId, via: "setup" });
  });

  it("同一命令重放返回原回执，换命令 ID 重提也不产生第二条授权", async () => {
    const harness = await startedExperiment();
    const first = seed(harness, floodLogToPlayer, "cmd-000000000901");
    const replay = seed(harness, floodLogToPlayer, "cmd-000000000901");
    const resubmitted = seed(harness, floodLogToPlayer, "cmd-000000000902");

    expect(first.commandStatus).toBe("accepted");
    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.acceptedEventIds).toEqual(first.acceptedEventIds);
    expect(resubmitted.commandStatus).toBe("accepted");
    expect(resubmitted.receiptId).not.toBe(first.receiptId);
    expect(resubmitted.acceptedEventIds).toEqual([]);
    expect(setupGrants(harness)).toHaveLength(1);
  });

  it("在线分支与沙盒分支都拒绝预置知识，且不留授权", async () => {
    for (const kind of ["online", "sandbox"] as const) {
      const harness = await startedExperiment();
      setBranchKind(harness, kind);

      const receipt = seed(harness, floodLogToPlayer);

      expect(receipt.commandStatus).toBe("rejected");
      expect(receipt.reasonCode).toBe("no-authority");
      expect(setupGrants(harness)).toHaveLength(0);
    }
  });

  it("玩家与 Agent 不能发行预置知识", async () => {
    const harness = await startedExperiment();
    for (const auth of [playerAuth(harness), strategicAuth(harness, "human-earth-alliance")]) {
      const receipt = harness.authority.commands.execute(
        auth,
        gameCommandEnvelope("knowledge.seed", floodLogToPlayer, harness.host.ids("cmd")),
      );
      expect(receipt.commandStatus).toBe("rejected");
      expect(receipt.reasonCode).toBe("no-authority");
    }
    expect(setupGrants(harness)).toHaveLength(0);
  });

  it("开局之前拒绝预置知识", async () => {
    const harness = await createTrackedGameHarness(active);
    setBranchKind(harness, "experiment");

    const receipt = seed(harness, floodLogToPlayer);

    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("not-ready");
    expect(readGameEvents(harness)).toHaveLength(0);
  });

  it("世界时钟推进后拒绝预置知识，避免各变体起点不一致", async () => {
    const harness = await startedExperiment();
    setGameClock(harness, { worldTick: 1, mode: "stepping", stepTargetTick: 2 });

    const receipt = seed(harness, floodLogToPlayer);

    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("world-tick-not-zero");
    expect(setupGrants(harness)).toHaveLength(0);
  });

  it("未知证据与未知接收主体都被拒绝", async () => {
    const harness = await startedExperiment();

    const unknownEvidence = seed(harness, { evidenceId: "ev-does-not-exist", principalId: "player-1" });
    const unknownPrincipal = seed(harness, { evidenceId: "ev-flood-log", principalId: "npc-does-not-exist" });

    expect(unknownEvidence.commandStatus).toBe("rejected");
    expect(unknownEvidence.reasonCode).toBe("invalid-params");
    expect(unknownPrincipal.commandStatus).toBe("rejected");
    expect(unknownPrincipal.reasonCode).toBe("unknown-target");
    expect(setupGrants(harness)).toHaveLength(0);
  });

  it("可以把证据预置给 Agent 主体", async () => {
    const harness = await startedExperiment();

    const receipt = seed(harness, { evidenceId: "ev-flood-log", principalId: "human-earth-alliance" });

    expect(receipt.commandStatus).toBe("accepted");
    expect(setupGrants(harness).map((event) => event.audience)).toEqual([
      [{ kind: "principals", ids: ["human-earth-alliance"] }],
    ]);
  });
});
