/**
 * 校验时间线筛选在数据库查询中完成，并正确表达排序与真实 limit。
 * 依赖记录 SQL 参数的存储桩；不打开 SQLite 或读取生产数据。
 */
import { describe, expect, it } from "vitest";
import type { StoragePort, StorageTransaction, StorageValue } from "@ai-npc/contracts";
import { ObservabilityPort } from "../src/plugin";

interface QueryCall {
  readonly sql: string;
  readonly parameters: readonly StorageValue[];
}

function row(): Record<string, StorageValue> {
  return {
    world_seq: 40,
    world_tick: 4,
    event_id: "evt-000000000040",
    type: "late.event",
    principal_id: "human-independent",
    audience_json: '{"kind":"public"}',
    payload_json: '{"agentId":"human-independent","nodeId":"node-gate"}',
    correlation_id: "corr-000000000040",
    committed_at: "2026-01-01T00:00:00.000Z",
  };
}

function storageWith(
  calls: QueryCall[],
  lifecycleRows: readonly Record<string, StorageValue>[] = [],
): StoragePort {
  const transaction = {
    all(sql: string, parameters: readonly StorageValue[] = []) {
      calls.push({ sql, parameters });
      return sql.includes("FROM domain_events") ? [row()] : lifecycleRows;
    },
  } as unknown as StorageTransaction;
  return {
    transact<T>(callback: (tx: StorageTransaction) => T): T {
      return callback(transaction);
    },
  } as unknown as StoragePort;
}

describe("ObservabilityPort timeline", () => {
  it("在 SQL 中应用类型、主体、节点筛选并保持最新优先", () => {
    const calls: QueryCall[] = [];
    const port = new ObservabilityPort(storageWith(calls), { timelineLimit: 200 });

    const response = port.timeline({
      branchId: "br-000000000001",
      fromSeq: 0,
      limit: 10,
      order: "desc",
      types: ["late.event"],
      agentId: "human-independent",
      nodeId: "node-gate",
    });

    expect(response.events).toHaveLength(1);
    const domainCall = calls[0];
    expect(domainCall?.sql).toContain("type IN (?)");
    expect(domainCall?.sql).toContain("json_tree(payload_json)");
    expect(domainCall?.sql).toContain("ORDER BY world_seq DESC");
    expect(domainCall?.parameters.at(-1)).toBe(10);
    expect(domainCall?.parameters).not.toContain(30);
  });

  it("生命周期事件按 subject_id 筛选，并与领域事件统一按时间截取", () => {
    const calls: QueryCall[] = [];
    const port = new ObservabilityPort(
      storageWith(calls, [{
        seq: 2,
        type: "AgentActivated",
        subject_id: "human-independent",
        payload_json: "{}",
        created_at: "2026-01-01T00:00:20.000Z",
      }]),
      { timelineLimit: 200 },
    );

    const response = port.timeline({
      branchId: "br-000000000001",
      fromSeq: 0,
      limit: 1,
      order: "desc",
      types: ["AgentActivated", "late.event"],
      agentId: "human-independent",
    });

    expect(response.events).toEqual([
      expect.objectContaining({ kind: "lifecycle", type: "AgentActivated" }),
    ]);
    const lifecycleCall = calls[1];
    expect(lifecycleCall?.sql).toContain("subject_id = ?");
    expect(lifecycleCall?.sql).toContain("ORDER BY created_at DESC");
  });
});
