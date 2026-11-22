/**
 * 验证 turn 租约守卫的截止判定契约：租约到期或超过回合截止时间时以
 * budget-exhausted / turn-deadline 停止，有效租约放行当前阶段。
 * 依赖最小事务替身与固定时钟，覆盖调度器回收之外 worker 自身检测到的超期路径。
 * 禁止访问真实存储、装配完整分支或发起模型调用。
 */
import { describe, expect, it } from "vitest";
import type { HostServices, StoragePort, StorageRow, StorageTransaction } from "@ai-npc/contracts";
import { TurnLeases, TurnStopped, type ClaimedTurn } from "@ai-npc/agent-runtime";

const nowIso = "2026-01-01T00:00:10.000Z";
const monotonicMs = 10_000;

interface LeaseTables {
  readonly turnRuns: StorageRow | null;
  readonly controllerLease: StorageRow | null;
}

function leaseHarness(tables: LeaseTables, deadlineMs: number) {
  const host = { nowIso: () => nowIso, monotonicMs: () => monotonicMs } as unknown as HostServices;
  const leases = new TurnLeases(null as unknown as StoragePort, host, new AbortController().signal);
  const tx = {
    rows: (name: string) => ({
      get: (key: Readonly<Record<string, unknown>>) => {
        if (name === "turn_runs") {
          return tables.turnRuns !== null && key["turn_id"] === tables.turnRuns["turn_id"] ? tables.turnRuns : null;
        }
        if (name === "branches") {
          return key["branch_id"] === "br-1" ? { branch_id: "br-1", status: "active" } : null;
        }
        return null;
      },
    }),
    branch: (branchId: string) => ({
      table: (name: string) => ({
        get: (key: Readonly<Record<string, unknown>>) => {
          if (branchId !== "br-1") return null;
          if (name === "agent_activations") {
            return key["agent_id"] === "agent-1" ? { agent_id: "agent-1", status: "active" } : null;
          }
          if (name === "controller_leases") return tables.controllerLease;
          if (name === "clock") return { run_version: 1, mode: "running" };
          return null;
        },
      }),
    }),
  } as unknown as StorageTransaction;
  const turn: ClaimedTurn = {
    auth: {
      worldId: "wld-1", branchId: "br-1", principalId: "agent-1", kind: "agent", roles: [],
      actingAsAgentId: null, controllerEpoch: 1, turnId: "turn-1", turnLeaseEpoch: 1,
    },
    runId: "run-1", agentTurnIndex: 1, profileHash: "hash-1", triggers: [],
    clockVersion: 1, worldTick: 0, observationSeq: 0, probe: false, pauseExempt: false,
    deadlineMs,
  };
  return { leases, tx, turn };
}

function runningTurnRow(leaseExpiry: string): StorageRow {
  return {
    turn_id: "turn-1", branch_id: "br-1", run_id: "run-1", agent_id: "agent-1", status: "deciding",
    turn_lease_epoch: 1, profile_hash: "hash-1", lease_expires_at: leaseExpiry, controller_epoch: 1,
  };
}

const agentLease = {
  agent_id: "agent-1", controller_kind: "agent", controller_epoch: 1,
  lease_expires_at: "2026-01-01T01:00:00.000Z",
};

describe("turn 租约截止判定", () => {
  it("租约到期时间已过时以 budget-exhausted / turn-deadline 停止", () => {
    const { leases, tx, turn } = leaseHarness(
      { turnRuns: runningTurnRow("2026-01-01T00:00:00.000Z"), controllerLease: agentLease },
      Number.MAX_SAFE_INTEGER,
    );
    let stopped: unknown;
    try {
      leases.require(tx, turn, "deciding");
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBeInstanceOf(TurnStopped);
    expect(stopped).toMatchObject({ status: "budget-exhausted", reason: "turn-deadline" });
  });

  it("超过回合截止时间时以 budget-exhausted / turn-deadline 停止", () => {
    const { leases, tx, turn } = leaseHarness(
      { turnRuns: runningTurnRow("2026-01-01T01:00:00.000Z"), controllerLease: agentLease },
      monotonicMs - 1,
    );
    let stopped: unknown;
    try {
      leases.require(tx, turn, "deciding");
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBeInstanceOf(TurnStopped);
    expect(stopped).toMatchObject({ status: "budget-exhausted", reason: "turn-deadline" });
  });

  it("租约与截止时间都有效时放行并返回当前 turn 行", () => {
    const { leases, tx, turn } = leaseHarness(
      { turnRuns: runningTurnRow("2026-01-01T01:00:00.000Z"), controllerLease: agentLease },
      monotonicMs + 1,
    );
    expect(leases.require(tx, turn, "deciding")).toMatchObject({ turn_id: "turn-1", status: "deciding" });
  });
});
