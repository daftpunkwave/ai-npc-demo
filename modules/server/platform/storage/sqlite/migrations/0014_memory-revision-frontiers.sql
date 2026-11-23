-- 核心职责：为不可变记忆 revision 保存公共版本边界与派生观察水位。
-- 交互契约：仅追加非负整数字段，旧 revision 使用保守的零边界。
-- 约束与禁忌：禁止修改既有迁移、历史记忆行或跨 Agent 比较局部 revision。
ALTER TABLE memory_revisions ADD COLUMN public_revision INTEGER NOT NULL DEFAULT 0 CHECK (public_revision >= 0);
ALTER TABLE memory_revisions ADD COLUMN derived_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (derived_through_seq >= 0);
