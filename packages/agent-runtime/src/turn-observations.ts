/**
 * 核心职责：在 turn 就绪时按 seq 区间与触发源两条下推查询取回该 Agent 的观察，去重后按 seq 升序返回。
 * 交互契约：依赖 storage 事务的原始查询能力，输入要求给出分支、Agent、记忆作用域、
 * 已消费水位（previousSeq）、记忆水位上界（throughSeq）与 trigger 的 sourceRef 集合；
 * 输出为经 decodeObservationRow 与 parseObservation 校验的只读观察列表。
 * 约束与禁忌：禁止经表级接口全表加载再在 JS 过滤，禁止无上界查询，禁止截断触发源集合。
 */
import type {
  AgentObservation,
  MemoryScope,
  StorageRawRow,
  StorageTransaction,
  StorageValue,
} from "@ai-npc/contracts";
import { decodeObservationRow, parseObservation } from "./memory-row-codec";

/** 与 memory-store 的 readObservations 保持同一组列，避免两条路径取回不同形状的行。 */
const OBSERVATION_COLUMNS = `observation_id, observation_seq, source_event_ids_json, source_observation_ids_json,
          occurred_at_tick, sensed_at_tick, known_at_tick, channel, epistemic,
          confidence, release_policy_id, content_json`;

/**
 * 单条补充查询的 IN 参数上限。
 * 触发源数量由调度侧 mergeLimit 决定，理论上可配置到超过 SQLite 的绑定变量上限；
 * 因此按批拆分而不是截断：每一批都保留 observation_seq 上界，合并结果不丢观察。
 */
const SOURCE_REF_BATCH_SIZE = 500;

export interface TurnObservationQuery {
  readonly branchId: string;
  readonly agentId: string;
  readonly scope: MemoryScope;
  /** 上一个 turn 已消费的观察水位；主区间从其后开始。 */
  readonly previousSeq: number;
  /** 当前记忆水位，任一查询都不得超过该上界。 */
  readonly throughSeq: number;
  /** 本轮 trigger 的来源引用集合：命中 observation 的 sourceEventIds 时补取更早的观察。 */
  readonly sourceRefs: readonly string[];
}

/**
 * 取回 turn 就绪所需的观察：主区间 (previousSeq, throughSeq] 与触发源补充集合的并集。
 * 两条查询都在 SQL 内完成范围与 JSON 成员判定，结果按 observation_seq 去重并升序。
 */
export function readTurnObservations(
  tx: StorageTransaction,
  input: TurnObservationQuery,
): readonly AgentObservation[] {
  const bySeq = new Map<number, AgentObservation>();
  const collect = (rows: readonly StorageRawRow[]): void => {
    for (const row of rows) {
      const observation = parseObservation(decodeObservationRow(row), input.scope);
      bySeq.set(observation.observationSeq, observation);
    }
  };

  collect(tx.all(
    `SELECT ${OBSERVATION_COLUMNS}
       FROM observations
      WHERE branch_id = ? AND agent_id = ?
        AND observation_seq > ? AND observation_seq <= ?
      ORDER BY observation_seq ASC`,
    [input.branchId, input.agentId, input.previousSeq, input.throughSeq],
  ));

  for (const batch of sourceRefBatches(input.sourceRefs)) {
    const placeholders = batch.map(() => "?").join(", ");
    const params: StorageValue[] = [input.branchId, input.agentId, input.throughSeq, ...batch];
    collect(tx.all(
      `SELECT ${OBSERVATION_COLUMNS}
         FROM observations
        WHERE branch_id = ? AND agent_id = ?
          AND observation_seq <= ?
          AND EXISTS (
            SELECT 1 FROM json_each(observations.source_event_ids_json) AS e
             WHERE e.value IN (${placeholders})
          )
        ORDER BY observation_seq ASC`,
      params,
    ));
  }

  return [...bySeq.values()].sort((left, right) => left.observationSeq - right.observationSeq);
}

/** 去重后按固定批大小切分触发源；空集合不产生查询，也不产生空 IN 列表。 */
function sourceRefBatches(sourceRefs: readonly string[]): readonly (readonly string[])[] {
  const unique = [...new Set(sourceRefs)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += SOURCE_REF_BATCH_SIZE) {
    batches.push(unique.slice(index, index + SOURCE_REF_BATCH_SIZE));
  }
  return batches;
}
