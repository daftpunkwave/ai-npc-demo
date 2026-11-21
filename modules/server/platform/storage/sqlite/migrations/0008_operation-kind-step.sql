-- 扩展运营幂等操作的种类：受控单步推进（step）也纳入 operationId 去重。
-- SQLite 不能直接修改 CHECK 约束，按同结构重建部署级表并迁移既有行；不改变主键与列集合，
-- 重建后恢复 kind 索引。该表不含 branch_id，不参与分支复制。
CREATE TABLE operation_idempotency_rebuilt (
  world_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('pause', 'resume', 'step', 'snapshot', 'restore', 'reset')),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  result_json TEXT,
  error_code TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0,
  error_safe_message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, principal_id, operation_id)
);

INSERT INTO operation_idempotency_rebuilt (
  world_id, principal_id, operation_id, operation_kind, request_hash, status,
  result_json, error_code, error_retryable, error_safe_message, created_at
)
SELECT
  world_id, principal_id, operation_id, operation_kind, request_hash, status,
  result_json, error_code, error_retryable, error_safe_message, created_at
FROM operation_idempotency;

DROP TABLE operation_idempotency;

ALTER TABLE operation_idempotency_rebuilt RENAME TO operation_idempotency;

CREATE INDEX operation_idempotency_kind
  ON operation_idempotency (world_id, operation_kind, created_at);
