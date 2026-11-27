# game.save.sqlite

SQLite 存档服务。把在线分支复制为冻结快照，并从快照创建后继在线分支。

## 边界

- 提供能力：`game.save`（`exactly-one`，run 作用域）。
- 不拥有规则聚合。
- 依赖：`requires` 只声明 `platform.storage`（分支复制与 `snapshots`、`branches`、`runs`、`world_aliases` 读写）；另用宿主 ID 与时间服务；不依赖其他游戏模块。
- 检查点查询由宿主在绑定端口时注入：分支 tick（`worldTick`）由宿主以时钟端口的 `readInTransaction` 提供，分支事件前沿（`eventFrontier`）是 authority 的 `branchEventFrontier`；模块不直接读取 `clock` 或 `domain_events` 表。
- 公开端口：实例端口是 module-sdk 声明的 `SaveModulePort`，宿主调用 `bind({ eventFrontier, worldTick })` 取得 `SavePort`；宿主与测试只经该端口使用存档能力，包入口不导出实现类。
- 调用方（运营编排）负责先暂停时钟并排空 job，再调用 `createSnapshot`。

## 操作

- `createSnapshot` / `createSnapshotInTransaction`：读取源分支、`forkBranch(kind=snapshot)`、写 `snapshots` 行；源分支不变。
- `listSnapshots`：读取当前 campaign 关联分支的 `snapshots` 记录（按 `campaignBranchIds` 过滤）。
- `inspectRestore` / `inspectRestoreInTransaction`：只读 dry-run 预检，校验快照完整性、源 run 与世界/检查点绑定。
- `restoreSnapshotInTransaction`：在调用方事务内读取快照的冻结分支，写入后继 `kind=online` 分支与新 run、结束旧 run、将旧分支置为 `archived` 并切换 `world_aliases('online')`。

## 限制

- 时钟暂停、job 排空与投影重推由宿主运营流程编排；`restoreSnapshotInTransaction` 在调用方的同一存储事务内完成别名与分支状态切换。
- 注入的 tick 查询以 `not-found` 表示分支没有时钟行，存档把它按快照数据不完整报告为 `invalid-state`（沿用「缺少时钟记录」文案），恢复预检据此判为完整性检查失败。
- `snapshots` 表没有 `campaign_id`；按 campaign 过滤通过分支与 `aggregate_state` 关联实现。
- `inspectRestore` 校验快照完整性与源 run 关联，部署级配额预检由宿主开局/恢复事务承担。
