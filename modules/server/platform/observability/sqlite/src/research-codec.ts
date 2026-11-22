/**
 * 核心职责：把观测存储中的追加式记忆、观察、turn 与 artifact 行解码为公共研究 DTO。
 * 交互契约：只接收已由 StoragePort 读取的原始行和 scope，不执行事务或业务判断。
 * 约束与禁忌：不得把缺失字段补成伪造证据；无法解释的行必须抛出明确错误。
 */
import {
  DomainError,
  agentObservationSchema,
  jsonValueSchema,
  memoryRecordSchema,
  type AgentObservation,
  type Json,
  type MemoryRecord,
  type StorageRow,
  type TurnDetail,
  type TurnSummary,
} from "@ai-npc/contracts";

/** 读取非负整数列；存储层返回不合法时拒绝继续，而不是静默归零。 */
export function numberColumn(row: StorageRow, key: string): number {
  // key 只由本文件转换为固定字段名，不接受请求输入。
  // eslint-disable-next-line security/detect-object-injection
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid-state", `观测字段 ${key} 不是非负安全整数`);
  }
  return value;
}

/** 读取非空文本列。 */
export function stringColumn(row: StorageRow, key: string): string {
  // key 只由本文件转换为固定字段名，不接受请求输入。
  // eslint-disable-next-line security/detect-object-injection
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("invalid-state", `观测字段 ${key} 不是非空文本`);
  }
  return value;
}

/** 读取可空文本列。 */
export function nullableStringColumn(row: StorageRow, key: string): string | null {
  // key 只由本文件转换为固定字段名，不接受请求输入。
  // eslint-disable-next-line security/detect-object-injection
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new DomainError("invalid-state", `观测字段 ${key} 不是文本或 null`);
  return value;
}

/** 解析存储中已经解码的 JSON 列；保证后续 DTO 不携带 undefined。 */
export function jsonColumn(value: unknown): Json {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("invalid-state", "观测 JSON 列不符合 JSON 契约");
  return parsed.data;
}

/** 把存储的记忆行转换为对外记录；scope 由调用方从世界与分支上下文补齐。 */
export function decodeMemoryRecord(
  row: StorageRow,
  input: { readonly worldId: string; readonly branchId: string; readonly agentId: string; readonly revision: number },
): MemoryRecord {
  return memoryRecordSchema.parse({
    memoryId: stringColumn(row, "memory_id"),
    scope: {
      worldId: input.worldId,
      branchId: input.branchId,
      agentId: input.agentId,
    },
    sourceObservationIds: row["source_observation_ids_json"],
    contentRefs: [],
    kind: stringColumn(row, "kind"),
    status: stringColumn(row, "status"),
    epistemic: stringColumn(row, "epistemic"),
    releasePolicyId: stringColumn(row, "release_policy_id"),
    validFromTick: numberColumn(row, "valid_from_tick"),
    validUntilTick: row["valid_until_tick"] === null ? null : numberColumn(row, "valid_until_tick"),
    revision: input.revision,
    content: jsonColumn(row["content_json"]),
  });
}

/** 把存储的观察行转换为契约对象。 */
export function decodeObservation(
  row: StorageRow,
  input: { readonly worldId: string; readonly branchId: string; readonly agentId: string },
): AgentObservation {
  return agentObservationSchema.parse({
    observationId: stringColumn(row, "observation_id"),
    scope: input,
    observationSeq: numberColumn(row, "observation_seq"),
    sourceEventIds: row["source_event_ids_json"],
    sourceObservationIds: row["source_observation_ids_json"],
    occurredAtTick: numberColumn(row, "occurred_at_tick"),
    sensedAtTick: numberColumn(row, "sensed_at_tick"),
    knownAtTick: numberColumn(row, "known_at_tick"),
    channel: stringColumn(row, "channel"),
    epistemic: stringColumn(row, "epistemic"),
    confidence: typeof row["confidence"] === "number" ? row["confidence"] : Number.NaN,
    releasePolicyId: stringColumn(row, "release_policy_id"),
    content: jsonColumn(row["content_json"]),
  });
}

/** 生成与 turn 行结构一致的摘要；触发类型与 token 由调用方补齐。 */
export function summaryFromRow(input: {
  readonly row: StorageRow;
  readonly triggerKinds: readonly string[];
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: TurnSummary["tokens"];
}): TurnSummary {
  return {
    turnId: stringColumn(input.row, "turn_id") as TurnSummary["turnId"],
    runId: stringColumn(input.row, "run_id") as TurnSummary["runId"],
    branchId: stringColumn(input.row, "branch_id"),
    agentId: stringColumn(input.row, "agent_id") as TurnSummary["agentId"],
    agentTurnIndex: numberColumn(input.row, "agent_turn_index"),
    status: stringColumn(input.row, "status"),
    triggerKinds: [...input.triggerKinds],
    terminalReason: nullableStringColumn(input.row, "terminal_reason"),
    createdAt: stringColumn(input.row, "created_at"),
    endedAt: nullableStringColumn(input.row, "ended_at"),
    modelCalls: input.modelCalls,
    toolCalls: input.toolCalls,
    tokens: input.tokens,
  };
}

/** turn 详情中的空字段必须保持显式空值，不能用示例数据填充。 */
export function detailFromSummary(
  summary: TurnSummary,
  input: Omit<TurnDetail, keyof TurnSummary | "toolCalls"> & { readonly toolCalls: TurnDetail["toolCalls"] },
): TurnDetail {
  return { ...summary, ...input };
}
