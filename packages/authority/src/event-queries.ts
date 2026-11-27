/**
 * 核心职责：领域事件存储的只读查询：按事件类型与载荷字段批量查找最新事件序号、按分支列出完整事件行，
 *   以及为观测数据源提供解码后的时间线、分支事件与最新序号。
 * 交互契约：只接受建有表达式索引的（事件类型，载荷字段）组合；字段名受契约载荷类型约束，
 *   查询中的取值表达式与迁移建立的索引列逐字一致；观测记录的列到字段映射只在本文件维护。
 * 约束与禁忌：只读；按载荷字段取值查找时不解析载荷的其他字段；禁止为未建索引的字段拼接查询，
 *   否则会退化为逐行解析 JSON；时间线的筛选与 limit 必须在 SQL 内完成，不得取回后在内存截取。
 */
import type {
  DomainEventPayload,
  DomainEventType,
  StorageRawRow,
  StorageRow,
  StorageTransaction,
  StorageValue,
} from "@world-prism/contracts";
import type { DomainEventTimelineQuery, ObservedDomainEvent } from "@world-prism/module-sdk";
import { readJsonTextCell, requireStorageNumber, requireStorageString } from "./storage-values";

/**
 * 建有表达式索引、可按取值查找的事件载荷字段。字段名必须是该事件契约载荷的键：
 * 载荷字段改名或删除时，这里在类型检查阶段失败，读取方不会静默得到空结果。
 * 新增条目时必须在迁移中建立表达式完全相同的索引（DialogueSubmitted.dialogueId 对应迁移 0019）。
 */
export const indexedEventPayloadKeys = {
  DialogueSubmitted: "dialogueId",
} as const satisfies { readonly [Type in DomainEventType]?: keyof DomainEventPayload<Type> & string };

/** 可按载荷字段查找最新序号的事件类型。 */
export type IndexedEventType = keyof typeof indexedEventPayloadKeys;

/**
 * 从事件载荷取出被索引字段的表达式。先做 json_valid 守卫再取值：表达式索引对每一行求值，
 * 历史上的非法 JSON 文本会让裸 json_extract 在写入与建索引时失败；JSON 合法时守卫不改变取值的类型。
 */
function payloadKeyExpression(type: IndexedEventType): string {
  // eslint-disable-next-line security/detect-object-injection -- type 是登记表的字面量键，不来自外部输入。
  const key = indexedEventPayloadKeys[type];
  return `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.${key}') END`;
}

/**
 * 按载荷字段取值批量查各自最新 world_seq 的查询；参数依次为分支、事件类型与 count 个取值。
 * 取值表达式必须与索引列逐字一致，否则 SQLite 只能靠 (branch_id, type) 收窄后逐行解析 JSON；
 * 导出给集成测试，让查询计划断言直接跑生产语句而不是另写一份等价副本。
 */
export function latestEventSeqsSql(type: IndexedEventType, count: number): string {
  const expression = payloadKeyExpression(type);
  const placeholders = Array.from({ length: count }, () => "?").join(", ");
  return `SELECT ${expression} AS payload_key,
                 MAX(world_seq) AS world_seq
            FROM domain_events
           WHERE branch_id = ?
             AND type = ?
             AND ${expression} IN (${placeholders})
           GROUP BY payload_key`;
}

/**
 * 在调用方事务内查找每个载荷字段取值对应事件的最新 world_seq；没有对应事件的取值不出现在结果中。
 * 取值为空时不发起查询。
 */
export function latestEventSeqsByPayload(
  tx: StorageTransaction,
  branchId: string,
  type: IndexedEventType,
  values: readonly string[],
): ReadonlyMap<string, number> {
  if (values.length === 0) {
    return new Map();
  }
  const rows = tx.all(latestEventSeqsSql(type, values.length), [branchId, type, ...values]);
  return new Map(rows.map((row) => [String(row["payload_key"]), Number(row["world_seq"])]));
}

/**
 * 按分支列出全部领域事件的原始行，供 run 导出等需要完整事件证据的读取方使用。
 * 只读，不解码载荷；调用方负责脱敏与序列化。
 */
export function listBranchEventRows(tx: StorageTransaction, branchId: string): readonly StorageRow[] {
  return tx.branch(branchId).table("domain_events").list();
}

const observedEventColumns = `world_seq, world_tick, event_id, type, principal_id, audience_json,
                payload_json, correlation_id, committed_at`;

/** 把原始查询返回的事件行解码为观测记录；任一列不符合契约都按 invalid-state 失败。 */
function decodeObservedEvent(row: StorageRawRow): ObservedDomainEvent {
  return {
    worldSeq: requireStorageNumber(row, "domain_events", "world_seq"),
    worldTick: requireStorageNumber(row, "domain_events", "world_tick"),
    eventId: requireStorageString(row, "domain_events", "event_id"),
    type: requireStorageString(row, "domain_events", "type"),
    principalId: requireStorageString(row, "domain_events", "principal_id"),
    audience: readJsonTextCell(row["audience_json"], "domain_events", "audience_json"),
    payload: readJsonTextCell(row["payload_json"], "domain_events", "payload_json"),
    correlationId: requireStorageString(row, "domain_events", "correlation_id"),
    committedAt: requireStorageString(row, "domain_events", "committed_at"),
  };
}

/** 载荷任一文本值包含给定文本；用于按 Agent 或节点 ID 筛选时间线。 */
const payloadMentions = `EXISTS (
          SELECT 1 FROM json_tree(payload_json) AS payload_value
           WHERE payload_value.type = 'text'
             AND INSTR(CAST(payload_value.value AS TEXT), ?) > 0
        )`;

/**
 * 按时间线筛选读取分支内 afterSeq 之后的领域事件，按 world_seq 排序；
 * 类型、主体与载荷文本筛选都在 SQL 内完成，limit 是筛选后的真实条数。
 */
export function listTimelineEvents(
  tx: StorageTransaction,
  query: DomainEventTimelineQuery,
): readonly ObservedDomainEvent[] {
  const direction = query.order === "desc" ? "DESC" : "ASC";
  const conditions = ["branch_id = ?", "world_seq > ?"];
  const parameters: StorageValue[] = [query.branchId, query.afterSeq];
  if (query.types !== undefined && query.types.length > 0) {
    conditions.push(`type IN (${query.types.map(() => "?").join(", ")})`);
    parameters.push(...query.types);
  }
  if (query.involving !== undefined) {
    conditions.push(`(principal_id = ? OR ${payloadMentions})`);
    parameters.push(query.involving, query.involving);
  }
  if (query.mentioning !== undefined) {
    conditions.push(payloadMentions);
    parameters.push(query.mentioning);
  }
  parameters.push(query.limit);
  return tx.all(
    `SELECT ${observedEventColumns}
       FROM domain_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY world_seq ${direction}
      LIMIT ?`,
    parameters,
  ).map(decodeObservedEvent);
}

/** 读取分支内 afterSeq 之后的全部领域事件，按 world_seq 升序；用于分支差异比对。 */
export function listEventsAfter(
  tx: StorageTransaction,
  branchId: string,
  afterSeq: number,
): readonly ObservedDomainEvent[] {
  return tx.all(
    `SELECT ${observedEventColumns}
       FROM domain_events WHERE branch_id = ? AND world_seq > ?
      ORDER BY world_seq`,
    [branchId, afterSeq],
  ).map(decodeObservedEvent);
}

/** 分支最新领域事件序号；尚无事件时为 null。 */
export function latestEventSeq(tx: StorageTransaction, branchId: string): number | null {
  const value = tx.branch(branchId).table("domain_events").max("world_seq");
  return value === null ? null : requireStorageNumber({ world_seq: value }, "domain_events", "world_seq");
}
