# platform.operations.standard

在线世界运营编排：暂停、继续、一致快照、恢复、重新开局与在线名册休眠/唤醒。

## 接口

- `OperationsService.pause(expectedRunVersion, operation?)`
- `OperationsService.resume(expectedRunVersion, operation?)`
- `OperationsService.step(expectedRunVersion, ticks, operation?)`：受控单步推进，从 `paused` 进入 `stepping`。
- `OperationsService.snapshot(label, createdBy, operation?)`：运行或单步中先暂停，再保存。
- `OperationsService.validateRestore(snapshotId)`：只读恢复预检。
- `OperationsService.restore(snapshotId, createdBy, runId?, operation?)`
- `OperationsService.reset(operation?)`
- `OperationsService.rosterState()`、`hibernateRoster(operation)`、`wakeRoster(operation)`：在线名册状态、休眠与唤醒；驱动未提供 `roster` 时按 `not-ready` 拒绝。

## 依赖

由宿主注入 `OperationsDriver`（clock/pause/resume/step/snapshot/validateRestore/restore/reset 及可选的 `idempotent` 与 `roster` 驱动）。模块本身不写存储、不创建分支。

## 限制

- 尚未实现席位 epoch/租约接管；`validateRestore` 当前只校验快照完整性、源 run 与世界/检查点，未含配额 dry-run。
- `reset` 的“空分支 + 归档旧分支 + 别名切换”以及 `restore` 时的旧分支归档与新分支激活由宿主驱动实现；旧分支置为 `archived` 后会退出部署级活动身份配额统计。
