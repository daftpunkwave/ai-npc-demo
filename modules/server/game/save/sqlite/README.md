# game.save.sqlite

SQLite 存档服务。把在线分支复制为冻结快照，并从快照创建后继在线分支。

## 边界

- 提供能力：`game.save`（`exactly-one`，run 作用域）。
- 不拥有规则聚合。
- 依赖宿主注入 `StoragePort`、ID 与时间服务；不依赖其他游戏模块。
- 调用方（运营编排）负责先暂停时钟并排空 job，再调用 `createSnapshot`。

## 操作

- `createSnapshot`：读取源分支、`forkBranch(kind=snapshot)`、写 `snapshots` 行；源分支不变。
- `listSnapshots`：读取 `snapshots` 表。
- `restoreSnapshot`：读取快照的冻结分支，按源分支 run 创建 `kind=online` 新分支；旧分支保留。

## 限制

- 本模块只做分支复制与快照行写入；暂停、静默、切换在线别名、投影重推由后续宿主/运营步骤编排。
- `snapshots` 表没有 campaign_id；按 campaign 过滤由运营层通过源分支/运行关系完成。
- 恢复不做 dry-run 预检；调用方需先确认快照冻结分支与 run 绑定。
