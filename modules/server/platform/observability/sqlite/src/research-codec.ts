/**
 * 核心职责：把数据源端口给出的记忆、观察与 turn 记录，以及自有 trace 行的单元格，转换为公共研究 DTO。
 * 交互契约：记忆、观察与 turn 只接收数据所有者已解码的类型化记录与 scope；trace 单元格来自本模块拥有的表；
 *   不执行事务或业务判断。
 * 约束与禁忌：不得把缺失字段补成伪造证据；无法解释的值必须抛出明确错误。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析时会把 TurnSummary 与 TurnDetail 的联合误判为 any。 */
import {
  DomainError,
  agentObservationSchema,
  jsonValueSchema,
  memoryRecordSchema,
  type AgentObservation,
  type Json,
  type MemoryRecord,
  type TurnDetail,
  type TurnSummary,
} from "@world-prism/contracts";
import type { ObservedMemoryRecord, ObservedObservation, ObservedTurnRun } from "@world-prism/module-sdk";

/** 读取非空文本列。 */
export function stringColumn(row: Readonly<Record<string, unknown>>, key: string): string {
  // key 只由本模块固定的 trace 列名调用，不接受请求输入。
  // eslint-disable-next-line security/detect-object-injection
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("invalid-state", `观测字段 ${key} 不是非空文本`);
  }
  return value;
}

/** 校验 JSON 值形状；保证后续 DTO 不携带 undefined。 */
export function jsonColumn(value: unknown): Json {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("invalid-state", "观测 JSON 列不符合 JSON 契约");
  return parsed.data;
}

export function parseJsonText(value: unknown): Json {
  if (typeof value !== "string") throw new DomainError("invalid-state", "观测 JSON 文本缺失");
  try {
    return jsonColumn(JSON.parse(value));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("invalid-state", "观测 JSON 文本无法解析", { cause: error });
  }
}

type ResearchScope = { readonly worldId: string; readonly branchId: string; readonly agentId: string };

/**
 * 把记忆行版本转换为对外记录；scope 由调用方从世界与分支上下文补齐。
 *
 * revision 取该行的 rowVersion，而不是查询用的视图 revision：记忆是追加式行版本，
 * 同一 memoryId 的每次改写都新增一个版本并让 rowVersion 加 1，冻结视图的 revision 则是整个 Agent
 * 记忆水位。两者语义不同，对外契约要的是「这条记录的第几次改写」，因此必须来自行版本；
 * 否则同一记录在不同视图下会显示成不同的「版本」，而真正被改写过的记录反而看起来没变。
 */
export function decodeMemoryRecord(record: ObservedMemoryRecord, scope: ResearchScope): MemoryRecord {
  return memoryRecordSchema.parse({
    memoryId: record.memoryId,
    scope: {
      worldId: scope.worldId,
      branchId: scope.branchId,
      agentId: scope.agentId,
    },
    sourceObservationIds: record.sourceObservationIds,
    kind: record.kind,
    status: record.status,
    epistemic: record.epistemic,
    releasePolicyId: record.releasePolicyId,
    validFromTick: record.validFromTick,
    validUntilTick: record.validUntilTick,
    revision: record.rowVersion,
    content: record.content,
  });
}

/** 把观察记录转换为契约对象。 */
export function decodeObservation(observation: ObservedObservation, scope: ResearchScope): AgentObservation {
  return agentObservationSchema.parse({
    observationId: observation.observationId,
    scope,
    observationSeq: observation.observationSeq,
    sourceEventIds: observation.sourceEventIds,
    sourceObservationIds: observation.sourceObservationIds,
    occurredAtTick: observation.occurredAtTick,
    sensedAtTick: observation.sensedAtTick,
    knownAtTick: observation.knownAtTick,
    channel: observation.channel,
    epistemic: observation.epistemic,
    confidence: observation.confidence,
    releasePolicyId: observation.releasePolicyId,
    content: observation.content,
  });
}

/** 生成与 turn 记录一致的摘要；触发类型、调用次数与 token 由调用方补齐。 */
export function summaryFromTurnRun(input: {
  readonly run: ObservedTurnRun;
  readonly triggerKinds: readonly string[];
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly tokens: TurnSummary["tokens"];
}): TurnSummary {
  const { run } = input;
  return {
    turnId: run.turnId as TurnSummary["turnId"],
    runId: run.runId as TurnSummary["runId"],
    branchId: run.branchId,
    agentId: run.agentId as TurnSummary["agentId"],
    agentTurnIndex: run.agentTurnIndex,
    status: run.status,
    triggerKinds: [...input.triggerKinds],
    terminalReason: run.terminalReason,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
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
