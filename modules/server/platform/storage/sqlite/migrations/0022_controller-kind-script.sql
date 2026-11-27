-- 扩展控制者种类：实验执行器在闭环实验分支上为脚本步骤临时取得 Agent 的控制权，记为 'script'。
-- SQLite 不能直接修改 CHECK 约束，按同结构重建分支级表并迁移既有行；列顺序、主键与列集合不变，
-- 分支复制按迁移推导的列清单拷贝，不受重建影响。该表没有索引、视图、触发器或外键引用。
CREATE TABLE controller_leases_rebuilt (
  branch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  controller_kind TEXT NOT NULL CHECK (controller_kind IN ('agent', 'human', 'script')),
  controller_principal_id TEXT,
  controller_epoch INTEGER NOT NULL,
  lease_expires_at TEXT,
  PRIMARY KEY (branch_id, agent_id)
);

INSERT INTO controller_leases_rebuilt (
  branch_id, agent_id, controller_kind, controller_principal_id, controller_epoch, lease_expires_at
)
SELECT
  branch_id, agent_id, controller_kind, controller_principal_id, controller_epoch, lease_expires_at
FROM controller_leases;

DROP TABLE controller_leases;

ALTER TABLE controller_leases_rebuilt RENAME TO controller_leases;
