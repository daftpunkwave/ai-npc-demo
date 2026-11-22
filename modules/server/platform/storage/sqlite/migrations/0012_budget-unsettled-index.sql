-- 为预算启动清理补索引：宿主启动时按 settled_at IS NULL 关闭崩溃遗留预留。
-- 只新增部分索引，不重写已结算账目、预算估值或世界事实；
-- 未结算行只在进程崩溃窗口内存在，部分索引因此保持很小。
CREATE INDEX budget_ledger_unsettled ON budget_ledger (settled_at) WHERE settled_at IS NULL;
