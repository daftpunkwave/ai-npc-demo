-- 核心职责：为 artifacts 建立 (storage, byte_size) 覆盖索引，让存储占用测量按存放方式汇总正文字节时只读索引。
-- 交互契约：只新增索引，不改表结构与既有行；测量语句按 storage 分组对 byte_size 求和并计数。
-- 约束与禁忌：索引不得改变 artifact 的写入与读取语义，也不得被当作正文存放位置的唯一来源。

-- artifacts 行内联保存最多 64 KiB 的正文，直接汇总 byte_size 要逐页读完整张表，
-- 读取量随正文总字节增长；覆盖索引每行只有两个短列，汇总成本只与行数相关。
CREATE INDEX artifacts_storage_bytes ON artifacts (storage, byte_size);
