# platform.operations.standard

在线世界运营编排：暂停、继续、一致快照、恢复与重新开局。

## 接口

- `OperationsService.pause(expectedRunVersion)`
- `OperationsService.resume(expectedRunVersion)`
- `OperationsService.snapshot(label, createdBy)`：运行中先暂停，再保存。
- `OperationsService.restore(snapshotId, createdBy)`
- `OperationsService.reset()`

## 依赖

由宿主注入 `OperationsDriver`：clock/pause/resume/snapshot/restore/reset。模块本身不写存储、不创建分支。

## 限制

- 未实现配额 dry-run、席位 epoch/租约、旧分支激活配额释放。
- reset 的“空分支 + 归档旧分支 + 别名切换”仍由宿主驱动实现。
