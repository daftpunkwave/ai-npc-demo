-- 核心职责：为 run 启动与停止记录 operationId 的首次结果，支持重放返回原结果。
-- 交互契约：部署级表，按世界、主体、操作类型与 operationId 唯一；结果以 JSON 保存。
-- 约束与禁忌：禁止在既有迁移上改动；只新增表，不改动运营幂等表的 operation_kind 枚举。
CREATE TABLE IF NOT EXISTS run_control_idempotency (
  world_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('start', 'stop')),
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, principal_id, operation_id, operation_kind)
);
