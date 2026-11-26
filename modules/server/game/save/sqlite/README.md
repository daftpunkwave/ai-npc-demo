# game.save.sqlite

SQLite 存档服务。把在线分支复制为冻结快照，并从快照创建后继在线分支。

## 边界

- 提供能力：`game.save`（`exactly-one`，run 作用域）。
- 不拥有规则聚合。
- 依赖宿主注入 `StoragePort`、ID 与时间服务；不依赖其他游戏模块。
- 调用方（运营编排）负责先暂停时钟并排空 job，再调用 `createSnapshot`。

## 操作

- `createSnapshot`：读取源分支、`forkBranch(kind=snapshot)`、写 `snapshots` 行；源分支不变。
- `listSnapshots`：读取当前 campaign 关联分支的 `snapshots` 记录（按 `campaignBranchIds` 过滤）。
- `inspectRestore`：只读 dry-run 预检，校验快照完整性、源 run 与世界/检查点绑定。
- `restoreSnapshot`：读取快照的冻结分支，在事务内写入后继 `kind=online` 分支与新 run、结束旧 run、将旧分支置为 `archived` 并切换 `world_aliases('online')`。

## 限制

- 时钟暂停、job 排空与投影重推由宿主运营流程编排；`restoreSnapshot` 本身在同一存储事务内完成别名与分支状态切换。
- `snapshots` 表没有 `campaign_id`；按 campaign 过滤通过分支与 `aggregate_state` 关联实现。
- `inspectRestore` 校验快照完整性与源 run 关联，部署级配额预检由宿主开局/恢复事务承担。
