-- 持久化规则处理器请求的时钟停止点：章节评估等终局步骤在业务事务内登记，重启后仍能补做暂停。
-- 与评估结果同事务提交；advanceWorldTick 在推进前读取该表并拒绝越过终局。
CREATE TABLE clock_stop_requests (
  branch_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, request_id)
);
