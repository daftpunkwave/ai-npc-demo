/**
 * 核心职责：定义生命周期审计事件的统一字段契约与事务内写入。
 * 交互契约：调用方提供活跃的存储事务与事件字段；payload 以规范 JSON 序列化后写入 lifecycle_events 表。
 * 约束与禁忌：不得写入领域事件或调用方事务之外的表；插入失败向上抛出，错误处置策略（吞错或随事务回滚）由调用方决定。
 */
import { canonicalJson, type Json, type StorageTransaction } from "@ai-npc/contracts";

/**
 * 生命周期审计事件的字段契约；与 lifecycle_events 表列一一对应。
 * 该表是独立于领域事件的 run/控制日志，事件类型是字符串目录而非封闭枚举。
 */
export interface LifecycleAuditEvent {
  /** 归属 run；事件不落在具体 run（如部署级启动）时为 null。 */
  readonly runId: string | null;
  /** 归属分支；事件不落在具体分支时为 null。 */
  readonly branchId: string | null;
  /** 事件类型；时间线按该值过滤读取。 */
  readonly type: string;
  /** 事件主体；无明确主体时为 null。 */
  readonly subjectId: string | null;
  /** 事件载荷；序列化形态由本契约统一为规范 JSON。 */
  readonly payload: Json;
  /** 事件时间（ISO 字符串）。 */
  readonly createdAt: string;
}

/** 在调用方事务内写入一条生命周期审计事件；同一事务内的其他写入与本事件保持原子。 */
export function insertLifecycleAuditEvent(tx: StorageTransaction, event: LifecycleAuditEvent): void {
  tx.run(
    "INSERT INTO lifecycle_events (run_id, branch_id, type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [event.runId, event.branchId, event.type, event.subjectId, canonicalJson(event.payload), event.createdAt],
  );
}
