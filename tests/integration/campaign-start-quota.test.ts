/**
 * 覆盖 campaign.start 同一事务内的名册激活与部署级 15 身份配额。
 * 依赖真实 SQLite 测试助手、宿主后续钩子与确定性宿主时钟；不启动 Agent turn loop。
 * 禁止让配额不足的命令写入 campaign 或激活行，也禁止把拒绝延后成事件消费阶段的重放失败。
 */
import { describe, expect, it } from "vitest";
import { createCampaignStartActivationHook } from "@ai-npc/agent-runtime";
import {
  campaignStartEnvelope,
  countBranchRows,
  playerAuth,
  readAggregate,
  type AuthorityHarness,
} from "./authority-support";
import { withHarness } from "./authority-fixtures";

const rosterAgents = Array.from({ length: 10 }, (_, index) => `agent-roster-${index}`);

/** 预置活动身份，模拟在线、实验或探针分支已经占用的名额。 */
function seedActiveAgents(harness: AuthorityHarness, agentIds: readonly string[]): void {
  harness.storage.transact((tx) => {
    const table = tx.branch(harness.branchId).table("agent_activations");
    for (const agentId of agentIds) {
      table.put({ agent_id: agentId, status: "active", updated_at: harness.host.nowIso() });
    }
  });
}

function registerActivationHook(harness: AuthorityHarness, agentIds: readonly string[]): void {
  harness.authority.hostAfterCommand(
    "agent-runtime",
    "campaign.start",
    createCampaignStartActivationHook({ agentIds, nowIso: () => harness.host.nowIso() }),
  );
}

function activeActivationCount(harness: AuthorityHarness): number {
  return harness.storage.transact((tx) => Number(
    tx.all(
      "SELECT COUNT(*) AS count FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id WHERE a.status = 'active' AND b.status IN ('active', 'paused')",
    )[0]?.["count"] ?? 0,
  ));
}

describe("campaign.start 名册激活配额", () => {
  it("配额不足时拒绝整条命令且不写入激活行", async () => {
    await withHarness(async (harness) => {
      seedActiveAgents(harness, Array.from({ length: 10 }, (_, index) => `agent-online-${index}`));
      seedActiveAgents(harness, Array.from({ length: 6 }, (_, index) => `agent-experiment-${index}`));
      registerActivationHook(harness, rosterAgents);
      const envelope = campaignStartEnvelope(harness, "cmd-000000000001");

      const receipt = harness.authority.commands.execute(playerAuth(harness), envelope);
      expect(receipt.commandStatus).toBe("rejected");
      expect(receipt.reasonCode).toBe("budget-exhausted");
      expect(receipt.acceptedEventIds).toEqual([]);
      expect(readAggregate(harness, "counter", "counter")).toBeNull();
      expect(countBranchRows(harness, "domain_events")).toBe(0);
      expect(activeActivationCount(harness)).toBe(16);
      for (const agentId of rosterAgents) {
        expect(harness.storage.transact((tx) =>
          tx.branch(harness.branchId).table("agent_activations").get({ agent_id: agentId }),
        )).toBeNull();
      }

      // 拒绝不产生领域事件，因此不会留下需要重放的 CampaignStarted 失败。
      expect(countBranchRows(harness, "consumer_offsets")).toBe(0);
      expect(countBranchRows(harness, "command_receipts")).toBe(1);
      const replay = harness.authority.commands.execute(playerAuth(harness), envelope);
      expect(replay).toEqual(receipt);
      expect(activeActivationCount(harness)).toBe(16);
    });
  });

  it("配额内开局在同一事务激活名册并保持幂等", async () => {
    await withHarness(async (harness) => {
      seedActiveAgents(harness, Array.from({ length: 5 }, (_, index) => `agent-online-${index}`));
      registerActivationHook(harness, rosterAgents);
      const envelope = campaignStartEnvelope(harness, "cmd-000000000002");

      const receipt = harness.authority.commands.execute(playerAuth(harness), envelope);
      expect(receipt.commandStatus).toBe("accepted");
      expect(receipt.acceptedEventIds).toHaveLength(1);
      expect(readAggregate(harness, "counter", "counter")?.state).toEqual({ count: 1 });
      expect(activeActivationCount(harness)).toBe(15);
      expect(countBranchRows(harness, "controller_leases")).toBe(10);
      for (const agentId of rosterAgents) {
        expect(harness.storage.transact((tx) =>
          tx.branch(harness.branchId).table("agent_activations").get({ agent_id: agentId }),
        )).toMatchObject({ status: "active" });
      }

      const replay = harness.authority.commands.execute(playerAuth(harness), envelope);
      expect(replay).toEqual(receipt);
      expect(activeActivationCount(harness)).toBe(15);
      expect(countBranchRows(harness, "domain_events")).toBe(1);
    });
  });

  it("已达 15 时只差一名也不放行，释放名额后可重新激活", async () => {
    await withHarness(async (harness) => {
      seedActiveAgents(harness, Array.from({ length: 15 }, (_, index) => `agent-online-${index}`));
      const releasingAgent = "agent-roster-0";
      registerActivationHook(harness, [releasingAgent]);
      const blocked = harness.authority.commands.execute(
        playerAuth(harness),
        campaignStartEnvelope(harness, "cmd-000000000003"),
      );
      expect(blocked.commandStatus).toBe("rejected");
      expect(blocked.reasonCode).toBe("budget-exhausted");

      harness.storage.transact((tx) => {
        const table = tx.branch(harness.branchId).table("agent_activations");
        table.put({ agent_id: "agent-online-0", status: "dormant", updated_at: harness.host.nowIso() });
      });
      const accepted = harness.authority.commands.execute(
        playerAuth(harness),
        campaignStartEnvelope(harness, "cmd-000000000004"),
      );
      expect(accepted.commandStatus).toBe("accepted");
      expect(harness.storage.transact((tx) =>
        tx.branch(harness.branchId).table("agent_activations").get({ agent_id: releasingAgent }),
      )).toMatchObject({ status: "active" });
      expect(activeActivationCount(harness)).toBe(15);
    });
  });
});
