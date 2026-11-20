-- 为 turn 保存逻辑创建时刻，调度冷却与世界时间使用同一字段而非真实时间字符串。
ALTER TABLE turn_runs ADD COLUMN created_tick INTEGER NOT NULL DEFAULT 0;
