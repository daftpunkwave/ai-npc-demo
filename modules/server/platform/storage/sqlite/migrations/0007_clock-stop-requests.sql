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

-- 升级旧库时为已经完成评估的 campaign 补建停止点，避免升级后恢复时钟越过章节终点。
-- requested_at_tick 取该分支当前持久 tick；旧库在评估成功后已暂停，因此与终点 tick 一致。
INSERT INTO clock_stop_requests (branch_id, request_id, reason, requested_at_tick, created_at)
SELECT
  aggregate_state.branch_id,
  'chapter-evaluated',
  '升级补建：章节评估已完成，保持终点暂停',
  COALESCE(
    (SELECT clock.world_tick FROM clock WHERE clock.branch_id = aggregate_state.branch_id),
    0
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM aggregate_state
WHERE aggregate_state.aggregate_type = 'campaign'
  AND aggregate_state.aggregate_id = 'campaign'
  AND json_extract(aggregate_state.state_json, '$.status') = 'evaluated';

