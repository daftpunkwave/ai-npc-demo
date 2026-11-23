/**
 * 核心职责：实现研究控制台的分支事件差异、队列摘要与调试唤醒查询。
 * 交互契约：依赖存储事务和宿主 ID/时间；只写生命周期审计与 debug trigger。
 * 约束与禁忌：不发模型请求、不执行审计重放、不修改世界事实。
 */
import {
  DomainError,
  branchCompareResponseSchema,
  debugQueuesResponseSchema,
  debugWakeResponseSchema,
  jsonValueSchema,
  type BranchCompareResponse,
  type DebugQueuesResponse,
  type DebugWakeResponse,
  type HostServices,
  type StoragePort,
} from "@ai-npc/contracts";
import { insertLifecycleAuditEvent } from "@ai-npc/module-sdk";

function jsonColumn(value: unknown) {
  return jsonValueSchema.parse(value);
}

function oldest(values: readonly string[]): string | null {
  return values.length === 0 ? null : values.reduce((left, right) => left < right ? left : right);
}

export function compareBranchEvents(
  storage: StoragePort,
  left: string,
  right: string,
  atSeq: number,
): BranchCompareResponse {
  const values = (branchId: string) => storage.transact((tx) => tx.all(
    `SELECT world_seq, type, payload_json, principal_id
       FROM domain_events WHERE branch_id = ? AND world_seq > ?
      ORDER BY world_seq`,
    [branchId, atSeq],
  ));
  const leftRows = new Map(values(left).map((row) => [Number(row["world_seq"]), row]));
  const rightRows = new Map(values(right).map((row) => [Number(row["world_seq"]), row]));
  const keys = [...new Set([...leftRows.keys(), ...rightRows.keys()])].sort((a, b) => a - b);
  const differences = keys.flatMap((seq) => {
    const leftRow = leftRows.get(seq);
    const rightRow = rightRows.get(seq);
    if (JSON.stringify(leftRow) === JSON.stringify(rightRow)) return [];
    return [{
      kind: "event" as const,
      key: String(seq),
      left: leftRow === undefined ? null : jsonColumn({
        type: leftRow["type"], payload: leftRow["payload_json"], principalId: leftRow["principal_id"],
      }),
      right: rightRow === undefined ? null : jsonColumn({
        type: rightRow["type"], payload: rightRow["payload_json"], principalId: rightRow["principal_id"],
      }),
    }];
  });
  return branchCompareResponseSchema.parse({ left, right, atSeq, differences });
}

export function readDebugQueues(storage: StoragePort, branchId: string): DebugQueuesResponse {
  const scheduler = storage.transact((tx) => {
    const rows = tx.all(
      "SELECT created_tick FROM triggers WHERE branch_id = ? AND consumed_by_turn_id IS NULL",
      [branchId],
    );
    return { queued: rows.length, running: 0, oldestAt: null };
  });
  const modelPool = storage.transact((tx) => {
    const rows = tx.all(
      `SELECT m.created_at FROM model_attempts m
         JOIN runs r ON r.run_id = m.run_id
        WHERE r.branch_id = ? AND m.status = 'started'`,
      [branchId],
    );
    return { queued: 0, running: rows.length, oldestAt: oldest(rows.map((row) => String(row["created_at"]))) };
  });
  const maintenance = storage.transact((tx) => {
    const rows = tx.all(
      `SELECT status, created_at FROM maintenance_runs
        WHERE branch_id = ? AND status IN ('queued', 'leased')`,
      [branchId],
    );
    return {
      queued: rows.filter((row) => row["status"] === "queued").length,
      running: rows.filter((row) => row["status"] === "leased").length,
      oldestAt: oldest(rows.map((row) => String(row["created_at"]))),
    };
  });
  return debugQueuesResponseSchema.parse({ scheduler, modelPool, maintenance });
}

export function wakeDebugAgent(
  storage: StoragePort,
  host: HostServices,
  branchId: string,
  agentId: string,
  reason: string,
  operationId: string,
): DebugWakeResponse {
  return storage.transact((tx) => {
    const run = tx.rows("runs").list({ branch_id: branchId })[0];
    if (run === undefined || run["run_id"] === undefined) {
      throw new DomainError("not-found", `分支 ${branchId} 没有可调试的 run`);
    }
    const branch = tx.branch(branchId);
    const key = `debug:${operationId}`;
    const existingTrigger = tx.get(
      `SELECT agent_id FROM triggers WHERE branch_id = ? AND dedupe_key = ?`,
      [branchId, key],
    );
    if (existingTrigger !== null) {
      if (existingTrigger["agent_id"] !== agentId) {
        throw new DomainError("idempotency-conflict", "同一 operationId 的调试唤醒请求内容不一致");
      }
      const prior = tx.get(
        `SELECT payload_json FROM lifecycle_events
          WHERE run_id = ? AND branch_id = ? AND type = 'DebugWakeRequested'
            AND json_extract(payload_json, '$.operationId') = ?
          ORDER BY seq DESC LIMIT 1`,
        [String(run["run_id"]), branchId, operationId],
      );
      const raw = prior?.["payload_json"];
      if (typeof raw !== "string") {
        throw new DomainError("invalid-state", "调试唤醒缺少对应的审计记录");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new DomainError("invalid-state", "调试唤醒审计载荷不是合法 JSON");
      }
      if (payload === null || Array.isArray(payload) || typeof payload !== "object" ||
        (payload as { readonly reason?: unknown }).reason !== reason) {
        throw new DomainError("idempotency-conflict", "同一 operationId 的调试唤醒请求内容不一致");
      }
      return debugWakeResponseSchema.parse({ ok: true });
    }
    const activation = branch.table("agent_activations").get({ agent_id: agentId });
    if (activation?.["status"] !== "active") throw new DomainError("not-found", `Agent ${agentId} 未激活`);
    const clock = branch.table("clock").get({});
    if (clock === null) throw new DomainError("not-ready", "当前分支没有时钟");
    branch.table("triggers").put({
      trigger_id: host.ids("trg"),
      agent_id: agentId,
      kind: "debug",
      priority: 100,
      source_ref: operationId,
      created_tick: Number(clock["world_tick"]),
      dedupe_key: key,
      consumed_by_turn_id: null,
    });
    tx.rows("runs").put({ ...run, contaminated: 1 });
    insertLifecycleAuditEvent(tx, {
      runId: String(run["run_id"]),
      branchId,
      type: "DebugWakeRequested",
      subjectId: agentId,
      payload: { agentId, reason, operationId },
      createdAt: host.nowIso(),
    });
    return debugWakeResponseSchema.parse({ ok: true });
  });
}
