/**
 * 覆盖跨分支 Agent 激活配额与释放后重新激活。
 * 依赖真实 SQLite 存储与确定性宿主时钟；不启动 turn loop。
 * 禁止把冻结分支计入配额或允许第 16 个活动身份。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateAgentRoster, activateAgentRosterInTransaction } from "@world-prism/agent-runtime";
import type { StoragePort } from "@world-prism/contracts";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost, expectDomainCode } from "./authority-support";

const active: { readonly storage: StoragePort; readonly dispose: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const item of active.splice(0)) await item.dispose();
});

async function storageFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-quota-"));
  const host = createFakeHost();
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  const storage = instance.port as StoragePort;
  storage.transact((tx) => {
    tx.rows("worlds").put({ world_id: "wld-000000000001", pack_id: "earth-2964-v1", content_version: "0.3.0", created_at: "2026-01-01T00:00:00.000Z" });
    for (const [index, status] of ["active", "paused", "frozen"] .entries()) {
      tx.rows("branches").put({
        branch_id: `br-00000000000${index + 1}`,
        world_id: "wld-000000000001",
        kind: status === "frozen" ? "snapshot" : "online",
        status,
        parent_branch_id: null,
        forked_at_world_seq: null,
        run_id: null,
        profile_hash: null,
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
  });
  active.push({
    storage,
    dispose: async () => {
      await instance.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
  return storage;
}

describe("Agent 激活配额", () => {
  it("在线与暂停分支共享 15 个名额，冻结分支不计入", async () => {
    const storage = await storageFixture();
    const first = Array.from({ length: 10 }, (_, index) => `agent-a-${index}`);
    const second = Array.from({ length: 5 }, (_, index) => `agent-b-${index}`);
    expect(activateAgentRoster({
      storage,
      branchId: "br-000000000001",
      agentIds: first,
      nowIso: "2026-01-01T00:00:00.000Z",
    }).totalActive).toBe(10);
    expect(activateAgentRoster({
      storage,
      branchId: "br-000000000002",
      agentIds: second,
      nowIso: "2026-01-01T00:00:01.000Z",
    }).totalActive).toBe(15);
    const overQuota = storage.transact((tx) => activateAgentRosterInTransaction({
      tx,
      branchId: "br-000000000002",
      agentIds: [...second, "agent-b-extra"],
      nowIso: "2026-01-01T00:00:02.000Z",
    }));
    expect(overQuota).toEqual({
      kind: "rejected",
      reasonCode: "budget-exhausted",
      requested: 16,
      limit: 15,
    });
    expectDomainCode(() => activateAgentRoster({
      storage,
      branchId: "br-000000000002",
      agentIds: [...second, "agent-b-extra"],
      nowIso: "2026-01-01T00:00:02.000Z",
    }), "budget-exhausted");
    expect(storage.transact((tx) => ({
      branches: tx.all("SELECT branch_id, status FROM branches ORDER BY branch_id"),
      count: tx.all("SELECT COUNT(*) AS count FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id WHERE a.status = 'active' AND b.status IN ('active', 'paused')")[0]?.["count"],
      extraActivation: tx.branch("br-000000000002").table("agent_activations").get({ agent_id: "agent-b-extra" }),
      extraLease: tx.branch("br-000000000002").table("controller_leases").get({ agent_id: "agent-b-extra" }),
    }))).toEqual({
      branches: [
        { branch_id: "br-000000000001", status: "active" },
        { branch_id: "br-000000000002", status: "paused" },
        { branch_id: "br-000000000003", status: "frozen" },
      ],
      count: 15,
      extraActivation: null,
      extraLease: null,
    });
    storage.transact((tx) => {
      const branches = tx.rows("branches");
      for (const branchId of ["br-000000000001", "br-000000000002"]) {
        const branch = branches.get({ branch_id: branchId });
        if (branch !== null) branches.put({ ...branch, status: "archived" });
      }
      const frozen = branches.get({ branch_id: "br-000000000003" });
      if (frozen !== null) branches.put({ ...frozen, status: "active" });
    });
    expect(activateAgentRoster({
      storage,
      branchId: "br-000000000003",
      agentIds: Array.from({ length: 6 }, (_, index) => `agent-frozen-${index}`),
      nowIso: "2026-01-01T00:00:03.000Z",
    }).totalActive).toBe(6);
  });
});
