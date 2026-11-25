-- 核心职责：为 Agent 热路径补齐缺失索引，让高频轮询只读活跃集而不是累计历史。
-- 交互契约：仅新增索引，不改既有表结构、列语义或已发布迁移。
-- 约束与禁忌：禁止改写 0001 与已发布迁移；部分索引的过滤条件必须与代码查询逐字一致，
--   否则优化器不会采用该索引；仓库有测试比对这里的条件与代码中的状态集合。

-- triggers 只追加，已消费行占绝大多数；真正被轮询的是未消费集合。
-- 只索引 branch_id：同一分支的索引项按 rowid 有序，调度器按 rowid 取触发器时无需额外排序。
CREATE INDEX triggers_pending ON triggers (branch_id) WHERE consumed_by_turn_id IS NULL;

-- turn_runs 的取消与过期恢复只关心非终态行；终态行会永久累积。
-- 过滤条件与非终态集合逐字一致，查询必须显式带上同一 status 列表才会命中本索引。
CREATE INDEX turn_runs_active ON turn_runs (branch_id, lease_expires_at)
  WHERE status IN ('queued', 'preparing', 'waiting', 'deciding', 'executing', 'speaking', 'settling');

-- maintenance_runs 原先只有主键；三处热查询分别按分支到期、运行与角色到期、任务去重读取。
CREATE INDEX maintenance_runs_due ON maintenance_runs (branch_id, due_tick, created_at, maintenance_id);
CREATE INDEX maintenance_runs_run_agent_due ON maintenance_runs (run_id, agent_id, due_tick);
CREATE INDEX maintenance_runs_task ON maintenance_runs (branch_id, agent_id, trigger, due_tick);
