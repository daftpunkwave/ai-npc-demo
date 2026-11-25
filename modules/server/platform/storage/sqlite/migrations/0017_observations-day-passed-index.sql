-- 核心职责：让「取最近一次 DayPassed 观察」走索引，而不是按分支与角色全量读表后逐行解码。
-- 交互契约：仅新增一个表达式部分索引，不改表结构、不改 content_json 的既有形状。
-- 约束与禁忌：索引的过滤表达式必须与查询里的 json_extract 条件逐字一致，
--   否则优化器不会采用；仓库有测试按实际查询形状断言查询计划命中本索引。

-- observations 只追加，每个事件对每个相关 Agent 都产生行。
-- 原先的查询把该 Agent 的全部观察按 known_at_tick 降序读进内存，再逐行解析 JSON 找第一条
-- DayPassed；行数随会话线性增长，而调用点在启动与日常结算路径上。
-- 用表达式部分索引把索引范围限定在 DayPassed 行，并按倒序存 tick 与序号，
-- 查询即可直接取第一条。
CREATE INDEX observations_day_passed ON observations (branch_id, agent_id, known_at_tick DESC, observation_seq DESC)
  WHERE json_extract(content_json, '$.eventType') = 'DayPassed';
