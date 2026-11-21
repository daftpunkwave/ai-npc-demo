-- 记录 job、事件消费者与时钟步骤的失败尝试；同一主体按阶段与明细累计次数并保存最后错误，
-- 达到重试上限后保留为 failed 供健康检查与审计查询，避免毒丸永久阻塞后续队列。
-- 成功路径删除对应记录，正常推进不留下失败行。
CREATE TABLE rule_failures (
  branch_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('job', 'event', 'clock-step', 'worker')),
  subject_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  last_error TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('retrying', 'failed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, phase, subject_id, detail)
);
CREATE INDEX rule_failures_status_updated ON rule_failures (branch_id, status, updated_at);
