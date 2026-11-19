-- 热路径 job 查询索引：每次推进只读取最早到期的一条 scheduled job。
-- 0001 的 jobs_due 覆盖了全部状态；分支历史增长后，已完成行仍会留在索引里。
-- 本迁移把它替换为只收录待执行行的部分索引，并保留分支、状态、到期 tick 与创建序号的列顺序，
-- 让 (dueTick, seq) 的受控查询走同一索引。只追加迁移，不改 0001。
DROP INDEX jobs_due;
CREATE INDEX jobs_status_due_seq ON jobs (branch_id, status, due_tick, seq) WHERE status = 'scheduled';
