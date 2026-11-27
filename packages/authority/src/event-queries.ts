/**
 * 核心职责：领域事件存储的只读查询：按事件类型与载荷字段批量查找最新事件序号，以及按分支列出完整事件行。
 * 交互契约：只接受建有表达式索引的（事件类型，载荷字段）组合；字段名受契约载荷类型约束，
 *   查询中的取值表达式与迁移建立的索引列逐字一致。
 * 约束与禁忌：只读；不解析载荷的其他字段；禁止为未建索引的字段拼接查询，否则会退化为逐行解析 JSON。
 */
import type { DomainEventPayload, DomainEventType, StorageRow, StorageTransaction } from "@world-prism/contracts";

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
