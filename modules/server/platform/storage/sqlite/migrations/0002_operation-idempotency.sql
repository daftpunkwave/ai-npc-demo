-- 运营操作幂等记录：按世界、认证主体与 operationId 保存首次执行结果。
-- 该表是部署级表（主键不含 branch_id），不参与分支复制，因而在在线别名切换与进程重启后仍然有效。
-- 迁移只新增表与索引，可重复回放，不修改既有表。

CREATE TABLE IF NOT EXISTS operation_idempotency (
  world_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('pause', 'resume', 'snapshot', 'restore', 'reset')),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  result_json TEXT,
  error_code TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0,
  error_safe_message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, principal_id, operation_id)
);

CREATE INDEX IF NOT EXISTS operation_idempotency_kind
  ON operation_idempotency (world_id, operation_kind, created_at);
