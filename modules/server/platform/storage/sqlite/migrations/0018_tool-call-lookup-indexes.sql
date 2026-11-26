-- 让工具调用的配额检查与结果查找走覆盖索引，而不是按 (run_id, turn_id) 前缀再逐行过滤。
-- 既有的 tool_calls_turn 只覆盖 (run_id, turn_id)：配额检查还要按 tool_id 过滤并计数，
-- 结果查找按 (run_id, turn_id, attempt_id, provider_call_id) 定位首行，两者都只能靠前缀扫描后回表。
-- 只新增两个索引，不改表结构、列语义或既有迁移；tool_calls 每行由一次工具调用追加且不裁剪，
-- 因此索引前缀必须与查询条件逐列对齐，避免随会话累计行数增长回退成全表扫描。
CREATE INDEX tool_calls_turn_tool ON tool_calls (run_id, turn_id, tool_id);
CREATE INDEX tool_calls_attempt_call ON tool_calls (run_id, turn_id, attempt_id, provider_call_id, created_at);
