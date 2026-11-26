/**
 * 核心职责：验证 `probe.ask` 命令只能在活跃沙盒分支由系统世界身份发行，并产生面向被问 Agent 的 `ProbeAsked` 事件。
 * 交互契约：使用真实 SQLite、内容包与 authority 命令网关；沙盒分支由测试直接登记，不启动 Agent 运行时。
 * 约束与禁忌：禁止用测试内自建命令处理器替代真实注册；断言必须覆盖发行者、分支种类与事件受众三条边界。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSystemAuth } from "@world-prism/authority";
import type { Json } from "@world-prism/contracts";
import {
  createGameHarness,
  gameCommandEnvelope,
  playerAuth,
  readGameEvents,
  readGameEventTypes,
  setGameClock,
  startNeutralCampaign,
  strategicAuth,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (harness) => harness.dispose()));
});

const sandboxBranchId = "br-000000000099";

/** 在同一世界下登记一个活跃沙盒分支，继承开局所需的时钟行；不复制世界状态。 */
function seedSandboxBranch(harness: GameHarness): void {
  harness.storage.transact((tx) => {
    const createdAt = harness.host.nowIso();
    tx.rows("branches").put({
      branch_id: sandboxBranchId,
      world_id: harness.worldId,
      kind: "sandbox",
      status: "active",
      parent_branch_id: harness.branchId,
      forked_at_world_seq: 0,
      run_id: null,
      profile_hash: null,
      created_at: createdAt,
    });
    tx.branch(sandboxBranchId).table("clock").put({
      world_tick: 0,
      mode: "running",
      seconds_per_tick: 20,
      run_version: 0,
      step_target_tick: null,
      updated_at: createdAt,
    });
  });
}

/** 读取指定分支的领域事件；沙盒分支与在线分支各取各的，JSON 列按存储约定解码。 */
function eventsOf(harness: GameHarness, branchId: string): readonly { readonly type: string; readonly payload: Json }[] {
  return harness.storage.transact((tx) =>
    tx
      .all("SELECT type, payload_json FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC", [branchId])
      .map((row) => ({
        type: String(row["type"]),
        payload: typeof row["payload_json"] === "string"
          ? (JSON.parse(row["payload_json"]) as Json)
          : (row["payload_json"] as Json),
      })),
  );
}

/** 以系统世界身份向沙盒分支提交探针。 */
function askProbe(
  harness: GameHarness,
  branchId: string,
  payload: Json,
): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return harness.authority.commands.execute(
    { ...createSystemAuth(harness.worldId, branchId) },
    gameCommandEnvelope("probe.ask", payload, harness.host.ids("cmd")),
  );
}

async function harnessWithSandbox(): Promise<GameHarness> {
  const harness = await createGameHarness();
  active.push(harness);
  expect(startNeutralCampaign(harness).commandStatus).toBe("accepted");
  seedSandboxBranch(harness);
  return harness;
}

describe("探针命令", () => {
  it("在活跃沙盒分支提交后产生面向被问 Agent 的 ProbeAsked 事件", async () => {
    const harness = await harnessWithSandbox();
    // 直接使用内容包 s-promise 脚本声明的探针 ID：命令、事件与脚本 answerKey 共用同一命名空间。
    const receipt = askProbe(harness, sandboxBranchId, {
      probeId: "p-recall-promise",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "党魁之前答应过你什么？",
    });

    expect(receipt.commandStatus).toBe("accepted");
    expect(receipt.acceptedEventIds).toHaveLength(1);
    const probeEvent = eventsOf(harness, sandboxBranchId).find((event) => event.type === "ProbeAsked");
    expect(probeEvent?.payload).toMatchObject({
      probeId: "p-recall-promise",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "党魁之前答应过你什么？",
    });
    // 探针只写沙盒分支：在线分支不得出现探针事件或额外对白。
    expect(readGameEventTypes(harness)).not.toContain("ProbeAsked");
  });

  it("暂停中的沙盒分支仍接受探针，因为沙盒不推进逻辑时间", async () => {
    const harness = await harnessWithSandbox();
    harness.storage.transact((tx) => {
      const table = tx.branch(sandboxBranchId).table("clock");
      const row = table.get({});
      if (row === null) throw new Error("沙盒分支没有时钟行");
      table.put({ ...row, mode: "paused" });
    });

    const receipt = askProbe(harness, sandboxBranchId, {
      probeId: "p-probe-2",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "你知道星图有几份吗？",
    });

    expect(receipt.commandStatus).toBe("accepted");
    expect(eventsOf(harness, sandboxBranchId).map((event) => event.type)).toContain("ProbeAsked");
  });

  it("在线分支拒绝探针：暂停豁免只覆盖沙盒分支", async () => {
    const harness = await harnessWithSandbox();
    setGameClock(harness, { worldTick: 3, mode: "paused" });

    const receipt = askProbe(harness, harness.branchId, {
      probeId: "p-probe-3",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "越权探针",
    });

    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("no-authority");
    expect(readGameEventTypes(harness)).not.toContain("ProbeAsked");
  });

  it("运行中的在线分支同样拒绝探针：分支种类限制不依赖暂停状态", async () => {
    // 时钟为 running 时暂停豁免根本不会被求值，因此分支种类必须由网关独立裁决。
    const harness = await harnessWithSandbox();
    setGameClock(harness, { worldTick: 3, mode: "running" });

    const receipt = askProbe(harness, harness.branchId, {
      probeId: "p-probe-9",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "运行中世界的探针",
    });

    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("no-authority");
    expect(readGameEventTypes(harness)).not.toContain("ProbeAsked");
  });

  it("实验分支拒绝探针：探针只用于沙盒", async () => {
    const harness = await harnessWithSandbox();
    harness.storage.transact((tx) => {
      const branch = tx.rows("branches").get({ branch_id: sandboxBranchId });
      if (branch === null) throw new Error("缺少沙盒分支行");
      tx.rows("branches").put({ ...branch, kind: "experiment" });
    });

    const receipt = askProbe(harness, sandboxBranchId, {
      probeId: "p-probe-a",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "实验分支探针",
    });

    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("no-authority");
    expect(eventsOf(harness, sandboxBranchId)).toHaveLength(0);
  });

  it("探针不产生对白、批准索引，也不推进逻辑时间", async () => {
    const harness = await harnessWithSandbox();
    const tickBefore = harness.storage.transact(
      (tx) => Number(tx.branch(sandboxBranchId).table("clock").get({})?.["world_tick"]),
    );
    // 对白以 conversation-line 聚合与 speech_commits 索引为准；两者都应是零。
    const counts = (): { readonly speech: number; readonly lines: number } => harness.storage.transact((tx) => ({
      speech: Number(tx.get("SELECT COUNT(*) AS n FROM speech_commits WHERE branch_id = ?", [sandboxBranchId])?.["n"]),
      lines: tx.branch(sandboxBranchId).table("aggregate_state")
        .list({ aggregate_type: "conversation-line" }).length,
    }));
    const before = counts();

    askProbe(harness, sandboxBranchId, {
      probeId: "p-probe-b",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "不产生对白的探针",
    });

    expect(counts()).toEqual(before);
    const tickAfter = harness.storage.transact(
      (tx) => Number(tx.branch(sandboxBranchId).table("clock").get({})?.["world_tick"]),
    );
    expect(tickAfter).toBe(tickBefore);
    expect(eventsOf(harness, sandboxBranchId).filter((event) => event.type === "ProbeAsked")).toHaveLength(1);
  });

  it("非系统主体不能发行探针，且不写入回执以外的事件", async () => {
    const harness = await harnessWithSandbox();
    for (const auth of [playerAuth(harness), strategicAuth(harness, "human-independent")]) {
      const receipt = harness.authority.commands.execute(
        { ...auth, branchId: sandboxBranchId },
        gameCommandEnvelope(
          "probe.ask",
          { probeId: "p-probe-4", agentId: "human-independent", askedBy: "player-1", question: "越权探针" },
          harness.host.ids("cmd"),
        ),
      );
      expect(receipt.commandStatus).toBe("rejected");
      expect(receipt.reasonCode).toBe("no-authority");
    }
    expect(eventsOf(harness, sandboxBranchId)).toHaveLength(0);
  });

  it("未知被问主体与未知提问者都被拒绝且不留下事件", async () => {
    const harness = await harnessWithSandbox();
    const unknownAgent = askProbe(harness, sandboxBranchId, {
      probeId: "p-probe-5",
      agentId: "npc-does-not-exist",
      askedBy: "player-1",
      question: "未知主体",
    });
    expect(unknownAgent.commandStatus).toBe("rejected");
    expect(unknownAgent.reasonCode).toBe("unknown-target");

    const unknownAsker = askProbe(harness, sandboxBranchId, {
      probeId: "p-probe-6",
      agentId: "human-independent",
      askedBy: "npc-does-not-exist",
      question: "未知提问者",
    });
    expect(unknownAsker.commandStatus).toBe("rejected");
    expect(unknownAsker.reasonCode).toBe("unknown-target");
    expect(eventsOf(harness, sandboxBranchId)).toHaveLength(0);
  });

  it("同一 probeId 换命令 ID 重复提交只写一条事件", async () => {
    // 幂等以 commandId 为准，因此换命令 ID 会重新执行处理器；探针语义要求同一 probeId 只留一条观察。
    const harness = await harnessWithSandbox();
    const payload = {
      probeId: "p-probe-c", agentId: "human-independent", askedBy: "player-1", question: "不同命令 ID",
    };
    const first = askProbe(harness, sandboxBranchId, payload);
    const second = askProbe(harness, sandboxBranchId, payload);

    expect(first.commandStatus).toBe("accepted");
    expect(second.commandStatus).toBe("accepted");
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(eventsOf(harness, sandboxBranchId).filter((event) => event.type === "ProbeAsked")).toHaveLength(1);
  });

  it("同一 probeId 重放只写一条事件", async () => {
    const harness = await harnessWithSandbox();
    const envelope = gameCommandEnvelope(
      "probe.ask",
      { probeId: "p-probe-7", agentId: "human-independent", askedBy: "player-1", question: "重放探针" },
      "cmd-000000000777",
    );
    const first = harness.authority.commands.execute(
      { ...createSystemAuth(harness.worldId, sandboxBranchId) },
      envelope,
    );
    const replay = harness.authority.commands.execute(
      { ...createSystemAuth(harness.worldId, sandboxBranchId) },
      envelope,
    );

    expect(first.commandStatus).toBe("accepted");
    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.acceptedEventIds).toEqual(first.acceptedEventIds);
    expect(eventsOf(harness, sandboxBranchId).filter((event) => event.type === "ProbeAsked")).toHaveLength(1);
  });

  it("沙盒分支的事件受众只含被问 Agent", async () => {
    const harness = await harnessWithSandbox();
    askProbe(harness, sandboxBranchId, {
      probeId: "p-probe-8",
      agentId: "human-independent",
      askedBy: "player-1",
      question: "受众检查",
    });

    const audience = harness.storage.transact((tx) => {
      const row = tx.get(
        "SELECT audience_json FROM domain_events WHERE branch_id = ? AND type = 'ProbeAsked' LIMIT 1",
        [sandboxBranchId],
      );
      if (row === null) return null;
      return typeof row["audience_json"] === "string"
        ? (JSON.parse(row["audience_json"]) as Json)
        : (row["audience_json"] as Json);
    });
    expect(audience).toEqual([{ kind: "principals", ids: ["human-independent"] }]);
    expect(readGameEvents(harness).filter((event) => event.type === "ProbeAsked")).toHaveLength(0);
  });
});
