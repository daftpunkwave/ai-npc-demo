-- 删除未接入生产读写的 conversation_lines 表：通信模块的对白与消息都存放在 aggregate_state，
-- 该表自创建起没有任何生产读写方，只在分支复制时被整表拷贝，徒增复制成本。
-- 对白的按主体索引读取由通信聚合承担，本迁移不迁移任何数据行。
DROP TABLE conversation_lines;
