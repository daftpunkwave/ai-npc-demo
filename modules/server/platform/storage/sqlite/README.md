# platform.storage.sqlite

单写 SQLite 存储适配器。首版只有一个数据库文件 `dataDir/world-prism.db`，由本模块独占；其他模块只经 `platform.storage` 端口访问，不持有连接。

## 能力与端口

- 提供能力 `platform.storage`（`exactly-one`，deployment 作用域），不依赖其他能力。
- 端口在 `packages/contracts` 的 `storage.ts` 中定义：同步事务、保存点、原始查询、表级 scope 读写、分支复制、整库备份与 artifact 大正文文件（`artifactFiles`）。
- `rows(table)` 只能访问部署级与运行级表；分支级表必须经 `branch(branchId)` 访问，读写自动限定 `branch_id`。`rows()` 与 `branch()` 返回的句柄绑定事务生命周期，提交或回滚后继续读写会以 `invalid-state` 失败。分支级表清单从迁移推导，打开时与代码常量比对，迁移新增分支级表却漏拷会启动失败。
- JSON 列按命名约定（`_json` 后缀）以规范 JSON 文本存取；BLOB 保持字节数组；表名与列名只能来自迁移目录，不接受调用方拼接 SQL。

## 配置

```yaml
dataDir: ./data                          # 宿主从部署环境并入
inlineArtifactMaxBytes: 65536            # 装配配置块提供
retentionDays:                           # 可选；缺省表示永久保留全部数据
  trace_spans: 30                        # 只接受可轮转的观测表，1–36500 的整数天
```

`retentionDays` 没有默认值，未配置时解析结果不含该键，不改变已冻结 manifest 中的模块配置摘要。

数据库文件为 `dataDir/world-prism.db`，备份写入 `dataDir/backups`，超过 `inlineArtifactMaxBytes` 的 artifact 正文写入 `dataDir/artifacts`。打开时应用 `journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。

## 迁移

- 迁移文件位于 `migrations/NNNN_<name>.sql`，启动时按编号连续执行，已执行版本与 SQL 内容校验和写入 `schema_migrations`。
- 迁移只追加，不修改已发布文件；编号必须从 1 连续递增，数据库已应用但目录缺失的版本会让启动失败。已应用版本的内容校验和不一致时，启动失败并报告版本。
- 分支复制按 `BRANCH_TABLES` 的固定顺序复制 19 张分支级表，随后把时钟置为 `paused` 并递增 `run_version`、控制租约 epoch 递增、未完结 turn 消费的 trigger 释放、已完成 turn 消费的 trigger 删除、Agent 激活状态置为 `dormant`。

## 生命周期与限制

- 连接只在模块 `start` 中打开、`dispose` 中关闭；`create` 不访问文件系统。端口方法在未打开时返回 `not-ready`。
- 事务回调必须同步；返回 Promise 会回滚并抛错。嵌套事务被拒绝，事务内部分写入使用 `savepoint`。
- 预编译语句在连接级缓存：原始查询与表级 scope 读写共用同一份缓存，同一 SQL 跨事务只预编译一次；条目上限 256，达到上限时整体清空后重新装入，不做逐条淘汰；连接关闭时缓存随之清空。
- `backup()` 使用 `VACUUM INTO` 生成一致副本，不能在事务内执行。
- 配置了保留天数时，`start` 后立即排入一轮清理，此后每轮结束隔 1 小时再排下一轮；每批最多删除 500 行过期跨度，每批是独立的短事务，删除与 `lifecycle_events` 中的 `StorageRetentionPruned` 记录同事务提交。`dispose` 先停止调度再关闭连接。表的保留分类与读取方分析见 [存储 — 数据保留与轮转](../../../../../docs/architecture/storage.md#6-数据保留与轮转)。
- `forkBranch()` 只写入新 `branches` 行并复制分支级数据；`online`/`experiment` 的 `runs` 行、`online` 别名切换与 Agent 配额激活由存档或宿主编排完成。
- 原始查询通道（`get`/`all`/`run`）只面向宿主固定机制的跨分支与范围查询；模块状态读写使用分支 scope 表接口，不持有连接。
- 模块不持有按主体隔离的 JSON 状态，`stateSchemaVersion` 为 `null`；数据库 schema 版本由 `schema_migrations` 管理。
- `artifactFiles` 向 `StoredAgentArtifactStore` 提供内联上限（`inlineArtifactMaxBytes`）与正文文件读写：正文先写暂存文件再以硬链接独占发布为 `dataDir/artifacts/<artifact_id>`，同名文件已存在时拒绝覆盖；登记路径固定为 `artifacts/<artifact_id>`，读取与删除时按不可信输入校验，不接受目录外路径。文件读写只在事务外调用。
- `backup()` 只复制数据库；`dataDir/artifacts` 中的正文文件写入后不再改变，按 artifact ID 命名，迁移或恢复数据目录时需与备份一并保留。
