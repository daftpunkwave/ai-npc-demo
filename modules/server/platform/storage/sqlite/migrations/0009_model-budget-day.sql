-- 记录模型尝试计入的游戏日并索引预算账本的实际查询路径。
-- 游戏日由工作冻结时的 tick 派生，既有运行级记录仍按原键保留。
-- 不重写运行清单、既有预算条目或世界事实。
ALTER TABLE budget_ledger ADD COLUMN world_day INTEGER;
CREATE INDEX budget_ledger_run ON budget_ledger (run_id);
CREATE INDEX budget_ledger_agent_day ON budget_ledger (run_id, agent_id, world_day);
CREATE INDEX budget_ledger_work ON budget_ledger (run_id, work_ref);
CREATE INDEX model_attempts_work ON model_attempts (run_id, work_ref);
CREATE INDEX model_attempts_status ON model_attempts (status);
CREATE INDEX tool_calls_turn ON tool_calls (run_id, turn_id);
