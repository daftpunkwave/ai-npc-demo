-- 把既有通信聚合改写为索引化形态，保持对白顺序、投递名单与授权语义不变：
-- 1) 会话聚合剥离内嵌 lines 为 conversation-line 行聚合（键 = 会话:补零序号，状态即原行 JSON）；
-- 2) 按会话参与者补写 conversation-membership 成员索引（键 = 主体:会话）；
-- 3) 会话聚合状态移除 lines，保留参与者与 lastSeq；
-- 4) 每条消息按冻结投递名单补写 message-delivery 投递索引
--    （键 = 主体:补零送达 tick:补零提交 tick:消息 ID，与收件箱排序键一致）；
-- 5) 知识授权主键从授权 ID 改写为主体:条目:途径，授权本体状态不变。
-- 源行一律先经 MATERIALIZED CTE 物化再插回 aggregate_state：同表 INSERT ... SELECT 的扫描
-- 游标在写入过程中不保证稳定，直接自插会重读行并产生主键冲突或畸形 JSON。
-- 键组件取自运行 ID 与内容 ID 契约（非空可打印 ASCII 且不含冒号）；旧库中的主体与会话 ID
-- 由内容包与身份装配产生，满足同一字符集。旧 conversation_lines 表从未有生产读写方，
-- 已由上一迁移删除，本迁移不读取它。
INSERT INTO aggregate_state (branch_id, aggregate_type, aggregate_id, version, state_json)
WITH conversation_lines (branch_id, conversation_id, line_seq, line_json) AS MATERIALIZED (
  SELECT s.branch_id, s.aggregate_id, json_extract(l.value, '$.seq'), json(l.value)
  FROM aggregate_state s, json_each(s.state_json, '$.lines') l
  WHERE s.aggregate_type = 'conversation'
    AND json_type(s.state_json, '$.lines') = 'array'
)
SELECT branch_id, 'conversation-line', conversation_id || ':' || printf('%010d', line_seq), 1, line_json
FROM conversation_lines;

INSERT INTO aggregate_state (branch_id, aggregate_type, aggregate_id, version, state_json)
WITH memberships (branch_id, principal_id, conversation_id) AS MATERIALIZED (
  SELECT s.branch_id, p.value, s.aggregate_id
  FROM aggregate_state s, json_each(s.state_json, '$.participants') p
  WHERE s.aggregate_type = 'conversation'
)
SELECT branch_id, 'conversation-membership', principal_id || ':' || conversation_id, 1, '{}'
FROM memberships;

UPDATE aggregate_state
SET state_json = json_remove(state_json, '$.lines')
WHERE aggregate_type = 'conversation'
  AND json_type(state_json, '$.lines') = 'array';

INSERT INTO aggregate_state (branch_id, aggregate_type, aggregate_id, version, state_json)
WITH deliveries (branch_id, principal_id, deliver_at_tick, committed_at_tick, message_id) AS MATERIALIZED (
  SELECT s.branch_id,
         d.value ->> 'principalId',
         d.value ->> 'deliverAtTick',
         s.state_json ->> 'committedAtTick',
         s.state_json ->> 'messageId'
  FROM aggregate_state s, json_each(s.state_json, '$.deliveries') d
  WHERE s.aggregate_type = 'message'
)
SELECT branch_id, 'message-delivery',
       principal_id
         || ':' || printf('%010d', deliver_at_tick)
         || ':' || printf('%010d', committed_at_tick)
         || ':' || message_id,
       1,
       json_object('messageId', message_id, 'deliverAtTick', deliver_at_tick)
FROM deliveries;

INSERT INTO aggregate_state (branch_id, aggregate_type, aggregate_id, version, state_json)
WITH grants (branch_id, version, state_json, principal_id, item_id, via) AS MATERIALIZED (
  SELECT branch_id, version, state_json,
         state_json ->> 'principalId',
         state_json ->> 'itemId',
         state_json ->> 'via'
  FROM aggregate_state
  WHERE aggregate_type = 'knowledge-grant'
    AND aggregate_id NOT LIKE '%:%'
)
SELECT branch_id, 'knowledge-grant', principal_id || ':' || item_id || ':' || via, version, state_json
FROM grants;

DELETE FROM aggregate_state
WHERE aggregate_type = 'knowledge-grant'
  AND aggregate_id NOT LIKE '%:%';
