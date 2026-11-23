-- 核心职责：为 trace 增加墙上时钟开始时间，并为调试唤醒的 operationId 查询建立索引。
-- 交互契约：只扩展既有 trace_spans 与 lifecycle_events，不改写已有业务行。
-- 约束与禁忌：start_ms 继续表达单调时钟差；索引不得改变审计载荷或唤醒语义。
ALTER TABLE trace_spans ADD COLUMN started_at TEXT;
CREATE INDEX lifecycle_debug_operation
  ON lifecycle_events (run_id, branch_id, type, json_extract(payload_json, '$.operationId'));
