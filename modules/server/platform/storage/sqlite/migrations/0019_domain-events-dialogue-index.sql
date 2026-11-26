-- 核心职责：让「按对白 ID 取 DialogueSubmitted 提交序号」走索引，而不是按 (branch_id, type) 收窄后逐行解析 payload_json。
-- 交互契约：仅新增一个表达式索引，不改表结构、不改 payload_json 的既有形状。
-- 约束与禁忌：索引里的表达式必须与查询中的写法逐字一致，否则优化器不会采用本索引；
--   仓库有测试按生产查询的形状断言查询计划命中本索引。

-- domain_events 只追加，每个分支累积全部历史事件。
-- 会话读取需要按一批对白 ID 找回各自的提交事件序号 world_seq；原查询只能靠 domain_events_type
-- 收窄到 (branch_id, type)，再对每一行 DialogueSubmitted 解析 JSON 比对 dialogueId，
-- 成本随该分支的对白事件数线性增长。把 dialogueId 提升为索引列后，查找与按对白取最大序号
-- 都在索引内完成，访问的行数只与命中的对白数量相关。
--
-- 表达式用 CASE 先做 json_valid 守卫再取 dialogueId：SQLite 的表达式索引对每一行求值，
-- 历史数据或诊断写入可能留下非法 JSON 文本（没有额外约束阻止这种写入），
-- 直接 json_extract 会让建索引与后续写入失败。JSON 合法时 CASE 的类型与传参一致，
-- 优化器仍能把等值条件匹配到本索引。
CREATE INDEX domain_events_dialogue ON domain_events (
  branch_id,
  type,
  CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.dialogueId') END,
  world_seq
);
