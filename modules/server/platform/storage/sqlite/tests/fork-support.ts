/**
 * 分支复制测试共享的源分支种子数据与行比较助手。
 * 依赖存储模块测试助手与存储端口；种入覆盖全部分支级表的最小行，供复制与修正断言使用。
 * 禁止让种子数据依赖真实业务内容、共享数据库，或把运行级 turn 当成分支级数据复制。
 */
import type { BranchKind, StoragePort, StorageRow } from "@world-prism/contracts";

export const SRC = "brn-src";
export const NOW = "2026-01-01T00:00:00.000Z";

/** 修复后允许与源分支不同的分支级表；其余表在 fork 点必须逐行相等。 */
export const TABLES_EXPECTED_EQUAL = [
  "aggregate_state",
  "domain_events",
  "command_receipts",
  "speech_commits",
  "jobs",
  "consumer_offsets",
  "consumer_inbox",
  "observations",
  "perception_state",
  "memory_records",
  "memory_revisions",
  "memory_watermarks",
  "operations",
] as const;

const TURN_STATUSES = [
  ["turn-completed", "completed"],
  ["turn-failed", "failed"],
  ["turn-budget", "budget-exhausted"],
  ["turn-deciding", "deciding"],
  ["turn-cancelled", "cancelled"],
] as const;

function branchRow(branchId: string, kind: string, status: string, runId: string | null): StorageRow {
  return {
    branch_id: branchId,
    world_id: "wld-1",
    kind,
    status,
    parent_branch_id: null,
    forked_at_world_seq: null,
    run_id: runId,
    profile_hash: null,
    created_at: NOW,
  };
}

/** 写入世界、源分支以及每张分支级表的一到多行，覆盖 job seq 与各类 trigger 消费状态。 */
export function seedSourceBranch(port: StoragePort): void {
  port.transact((tx) => {
    tx.rows("worlds").put({
      world_id: "wld-1",
      pack_id: "earth-2964-v1",
      content_version: "v1",
      created_at: NOW,
    });
    tx.rows("branches").put(branchRow(SRC, "online", "active", "run-src"));
    const branch = tx.branch(SRC);
    branch.table("clock").put({
      world_tick: 42,
      mode: "running",
      seconds_per_tick: 10,
      run_version: 3,
      step_target_tick: 50,
      updated_at: NOW,
    });
    branch.table("aggregate_state").put({
      aggregate_type: "stockpile",
      aggregate_id: "stk-1",
      version: 2,
      state_json: { amount: 20 },
    });
    for (const worldSeq of [1, 2, 3]) {
      branch.table("domain_events").put({
        world_seq: worldSeq,
        event_id: `evt-${worldSeq}`,
        world_tick: worldSeq,
        type: "TestHappened",
        schema_version: 1,
        principal_id: "player-1",
        causation_ids_json: [],
        correlation_id: `corr-${worldSeq}`,
        audience_json: [],
        payload_json: { seq: worldSeq },
        committed_at: NOW,
      });
    }
    branch.table("command_receipts").put({
      principal_id: "player-1",
      command_id: "cmd-1",
      command_type: "campaign.start",
      payload_hash: "hash-1",
      receipt_json: { commandStatus: "accepted" },
      created_at: NOW,
    });
    branch.table("speech_commits").put({
      approved_speech_artifact_ref: "art-speech-1",
      principal_id: "player-1",
      command_id: "cmd-1",
      event_id: "evt-1",
    });
    for (const [seq, dueTick, status] of [
      [1, 10, "scheduled"],
      [2, 20, "scheduled"],
      [3, 30, "done"],
    ] as const) {
      branch.table("jobs").put({
        job_id: `job-${seq}`,
        seq,
        kind: "daily-settle",
        due_tick: dueTick,
        status,
        idempotency_key: `daily:${seq}`,
        payload_json: { seq },
        attempts: 0,
        last_error: null,
      });
    }
    branch.table("consumer_offsets").put({ consumer_id: "projection", last_world_seq: 3 });
    branch.table("consumer_inbox").put({
      consumer_id: "projection",
      event_id: "evt-1",
      processed_at: NOW,
    });
    branch.table("agent_activations").put({ agent_id: "agt-cenyan", status: "active", updated_at: NOW });
    branch.table("controller_leases").put({
      agent_id: "agt-cenyan",
      controller_kind: "agent",
      controller_principal_id: null,
      controller_epoch: 4,
      lease_expires_at: null,
    });
    branch.table("observations").put({
      agent_id: "agt-cenyan",
      observation_seq: 1,
      observation_id: "obs-1",
      source_event_ids_json: ["evt-1"],
      source_observation_ids_json: [],
      occurred_at_tick: 1,
      sensed_at_tick: 2,
      known_at_tick: 3,
      channel: "witnessed",
      epistemic: "witnessed",
      confidence: 1,
      release_policy_id: "policy-1",
      content_json: { summary: "听见水声" },
    });
    branch.table("perception_state").put({
      agent_id: "agt-cenyan",
      module_id: "agent.perception.local",
      revision: 2,
      scanned_through_seq: 3,
      state_json: { dedupe: ["evt-1"] },
    });
    branch.table("memory_records").put({
      agent_id: "agt-cenyan",
      memory_id: "mem-1",
      row_version: 1,
      module_id: "agent.memory.ledger",
      kind: "episodic",
      tier: "long",
      status: "active",
      epistemic: "verified-event",
      release_policy_id: "policy-1",
      valid_from_tick: 1,
      valid_until_tick: null,
      created_revision: 0,
      retired_revision: null,
      strength: 1,
      salience: 0,
      recall_count: 0,
      tags_json: [],
      source_observation_ids_json: ["obs-1"],
      content_json: { text: "记住水声" },
    });
    branch.table("memory_revisions").put({
      agent_id: "agt-cenyan",
      revision: 0,
      base_revision: 0,
      observation_seq_through: 1,
      world_seq_through: 3,
      change_kind: "init",
      plan_hash: "plan-0",
      created_at: NOW,
    });
    branch.table("memory_watermarks").put({
      agent_id: "agt-cenyan",
      module_id: "agent.memory.ledger",
      revision: 0,
      observation_seq_consumed: 1,
      durable_through_seq: 3,
      derived_through_seq: 3,
      derived_through_tick: 3,
    });
    branch.table("operations").put({
      agent_id: "agt-cenyan",
      operation_id: "op-1",
      command_id: "cmd-op-1",
      payload_hash: "hash-op",
      created_at: NOW,
    });
  });

  port.transact((tx) => {
    for (const [turnId, status] of TURN_STATUSES) {
      tx.rows("turn_runs").put({
        turn_id: turnId,
        run_id: "run-src",
        branch_id: SRC,
        agent_id: "agt-cenyan",
        agent_turn_index: 1,
        status,
        trigger_ids_json: [],
        input_frontier_json: null,
        memory_revision: 0,
        profile_hash: "profile-1",
        controller_epoch: 4,
        turn_lease_epoch: 1,
        lease_expires_at: null,
        terminal_reason: null,
        effective_json: null,
        created_at: NOW,
        started_at: null,
        ended_at: null,
      });
    }
    const triggers = tx.branch(SRC).table("triggers");
    const triggerRows: readonly StorageRow[] = [
      { trigger_id: "t-completed", priority: 1, source_ref: "evt-1", created_tick: 1, dedupe_key: "completed", consumed_by_turn_id: "turn-completed" },
      { trigger_id: "t-failed", priority: 1, source_ref: "evt-2", created_tick: 2, dedupe_key: "failed", consumed_by_turn_id: "turn-failed" },
      { trigger_id: "t-budget", priority: 1, source_ref: "evt-3", created_tick: 3, dedupe_key: "budget", consumed_by_turn_id: "turn-budget" },
      { trigger_id: "t-deciding", priority: 1, source_ref: "evt-1", created_tick: 4, dedupe_key: "deciding", consumed_by_turn_id: "turn-deciding" },
      { trigger_id: "t-cancelled", priority: 2, source_ref: "evt-2", created_tick: 5, dedupe_key: "cancelled", consumed_by_turn_id: "turn-cancelled" },
      { trigger_id: "t-none", priority: 3, source_ref: "job-1", created_tick: 6, dedupe_key: "none", consumed_by_turn_id: null },
    ];
    for (const row of triggerRows) {
      triggers.put({ agent_id: "agt-cenyan", kind: "event", ...row });
    }
  });
}

/** 读取分支级表并去掉 branch_id，按内容排序后比较，避免依赖未声明的默认行序。 */
export function snapshotTable(port: StoragePort, branchId: string, table: string): readonly string[] {
  return port.transact((tx) =>
    tx
      .branch(branchId)
      .table(table)
      .list()
      .map((row) => {
        const rest: Record<string, unknown> = {};
        for (const [column, value] of Object.entries(row)) {
          if (column !== "branch_id") {
            rest[column] = value;
          }
        }
        return JSON.stringify(rest);
      })
      .sort(),
  );
}

/** 在事务内对源分支执行一次复制，供各用例复用。 */
export function forkInto(port: StoragePort, dst: string, kind: BranchKind, runId?: string): void {
  port.transact((tx) => {
    port.forkBranch(tx, runId === undefined
      ? { srcBranchId: SRC, dstBranchId: dst, kind }
      : { srcBranchId: SRC, dstBranchId: dst, kind, runId });
  });
}
