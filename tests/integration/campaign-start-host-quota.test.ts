/**
 * 验证真实主装配（startHost）内 campaign.start 的名册激活与部署级 15 身份配额。
 * 依赖临时数据目录、standard 装配、standard-15 名册与生产命令网关；不监听端口、不启动真实模型。
 * 禁止绕过 startHost 直接拼装 authority 与钩子，也禁止让被拒开局留下 campaign、事件或激活写入。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "@ai-npc/app-server";
import type { AuthContext } from "@ai-npc/contracts";
import { loadRoster } from "@ai-npc/experiment";
import { gameCommandEnvelope } from "./game-support";
import { stubStandardModelHttp } from "./standard-model-support";

const hosts: RunningHost[] = [];
const dirs: string[] = [];

beforeEach(stubStandardModelHttp);

afterEach(async () => {
  // 先等待全部宿主关闭再删除数据目录：SQLite 句柄未释放时 Windows 删除会抛 EBUSY。
  const failures: unknown[] = [];
  const closed = await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const result of closed) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `主装配配额测试清理未全部完成：${failures.length} 处失败`);
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-host-quota-"));
  dirs.push(dir);
  return dir;
}

/** 与生产一致的默认启动：standard 装配、standard-15 名册，随机 seed 冻结首个在线 run。 */
async function startStandardHost(): Promise<RunningHost> {
  const host = await startHost({
    dataDir: tempDataDir(),
    playerToken: "quota-player",
    consoleToken: "quota-console",
  });
  hosts.push(host);
  return host;
}

function playerAuth(host: RunningHost): AuthContext {
  return {
    principalId: "player-1",
    kind: "player",
    roles: ["player"],
    worldId: host.worldId,
    branchId: host.branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnId: null,
    turnLeaseEpoch: null,
  };
}

/** 部署级活动身份数：所有活动或暂停分支上 status='active' 的激活行总数。 */
function activeActivationCount(host: RunningHost): number {
  return host.storage.transact((tx) => Number(tx.all(
    "SELECT COUNT(*) AS count FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id " +
    "WHERE a.status = 'active' AND b.status IN ('active', 'paused')",
  )[0]?.["count"] ?? 0));
}

function branchTable(host: RunningHost, name: string) {
  return host.storage.transact((tx) => tx.branch(host.branchId).table(name).list());
}

/** 在指定分支预置 status='active' 的活动身份，模拟其他 run 或分支占用的配额。 */
function seedActiveAgents(host: RunningHost, branchId: string, agentIds: readonly string[]): void {
  host.storage.transact((tx) => {
    const table = tx.branch(branchId).table("agent_activations");
    for (const agentId of agentIds) {
      table.put({ agent_id: agentId, status: "active", updated_at: "2026-11-21T00:00:00.000Z" });
    }
  });
}

/** 新建一个同部署的活动实验分支，用于验证配额跨分支计数。 */
function seedExperimentBranch(host: RunningHost, branchId: string): void {
  host.storage.transact((tx) => {
    tx.rows("branches").put({
      branch_id: branchId,
      world_id: host.worldId,
      kind: "experiment",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: null,
      run_id: null,
      profile_hash: null,
      created_at: "2026-11-21T00:00:00.000Z",
    });
  });
}

const rosterAgentIds = loadRoster("standard-15", { configDir: resolve("config"), env: process.env })
  .value.agents.map(({ agentId }) => agentId);

describe("主装配 campaign.start 名册激活配额", () => {
  it("正式装配开局在同一事务激活 15 个身份并占满部署级名额", async () => {
    const host = await startStandardHost();
    const envelope = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001");

    const receipt = host.authority.commands.execute(playerAuth(host), envelope);
    expect(receipt.commandStatus).toBe("accepted");
    expect(receipt.acceptedEventIds.length).toBeGreaterThan(0);

    const activations = branchTable(host, "agent_activations");
    expect(activations).toHaveLength(15);
    expect(activations.map((row) => String(row["agent_id"]))).toEqual(expect.arrayContaining(rosterAgentIds));
    for (const row of activations) {
      expect(row["status"]).toBe("active");
    }
    expect(activeActivationCount(host)).toBe(15);
    expect(branchTable(host, "controller_leases")).toHaveLength(15);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("aggregate_state")
      .get({ aggregate_type: "campaign", aggregate_id: "campaign" }))).not.toBeNull();

    // 同一命令重放返回原回执，不重复激活。
    const replay = host.authority.commands.execute(playerAuth(host), envelope);
    expect(replay).toEqual(receipt);
    expect(activeActivationCount(host)).toBe(15);
    expect(branchTable(host, "agent_activations")).toHaveLength(15);
  }, 30_000);

  it("活动身份已达 15 时开局按 budget-exhausted 拒绝且不落库", async () => {
    const host = await startStandardHost();
    // 预置 15 个外来活动身份，模拟实验或探针分支已占满部署级配额。
    seedActiveAgents(host, host.branchId, Array.from({ length: 15 }, (_, index) => `agent-experiment-${index}`));
    const envelope = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000002");

    const receipt = host.authority.commands.execute(playerAuth(host), envelope);
    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("budget-exhausted");
    expect(receipt.acceptedEventIds).toEqual([]);

    // 开局写入整体回滚：聚合、事件与名册激活、租约都不落库。
    expect(branchTable(host, "aggregate_state")).toEqual([]);
    expect(branchTable(host, "domain_events")).toEqual([]);
    expect(branchTable(host, "controller_leases")).toEqual([]);
    const activations = branchTable(host, "agent_activations");
    expect(activations).toHaveLength(15);
    expect(activations.every((row) => String(row["agent_id"]).startsWith("agent-experiment-"))).toBe(true);
    expect(activeActivationCount(host)).toBe(15);

    // 拒绝回执同样幂等：重放同一命令返回原回执，不改变任何写入。
    const replay = host.authority.commands.execute(playerAuth(host), envelope);
    expect(replay).toEqual(receipt);
    expect(branchTable(host, "command_receipts")).toHaveLength(1);
    expect(activeActivationCount(host)).toBe(15);
  }, 30_000);

  it("部署级配额只差一名时开局同样拒绝且不产生写入", async () => {
    const host = await startStandardHost();
    // 名册需要 15 个名额，预置 1 个活动身份后开局将超出部署级 15 上限。
    seedActiveAgents(host, host.branchId, ["agent-experiment-0"]);
    const envelope = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000003");

    const receipt = host.authority.commands.execute(playerAuth(host), envelope);
    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("budget-exhausted");
    expect(receipt.acceptedEventIds).toEqual([]);

    expect(branchTable(host, "aggregate_state")).toEqual([]);
    expect(branchTable(host, "domain_events")).toEqual([]);
    expect(branchTable(host, "controller_leases")).toEqual([]);
    expect(branchTable(host, "agent_activations")).toHaveLength(1);
    expect(activeActivationCount(host)).toBe(1);
  }, 30_000);

  it("其他活动分支占满配额时在线分支开局被拒绝且在线分支不落库", async () => {
    const host = await startStandardHost();
    // 配额计数覆盖部署内所有活动或暂停分支：实验分支占满 15 名额后在线开局同样被拒。
    const experimentBranchId = "br-experiment-0001";
    seedExperimentBranch(host, experimentBranchId);
    seedActiveAgents(host, experimentBranchId, Array.from({ length: 15 }, (_, index) => `agent-experiment-${index}`));
    const envelope = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000004");

    const receipt = host.authority.commands.execute(playerAuth(host), envelope);
    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("budget-exhausted");
    expect(receipt.acceptedEventIds).toEqual([]);

    expect(branchTable(host, "aggregate_state")).toEqual([]);
    expect(branchTable(host, "domain_events")).toEqual([]);
    expect(branchTable(host, "controller_leases")).toEqual([]);
    expect(branchTable(host, "agent_activations")).toEqual([]);
    expect(activeActivationCount(host)).toBe(15);
    expect(branchTable(host, "command_receipts")).toHaveLength(1);
  }, 30_000);
});
