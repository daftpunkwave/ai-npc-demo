# game.clock.controlled

受控时钟服务。实时运行、暂停与单步共用同一条 `clock` 表，不启动独立计时器。

## 边界

- 提供能力：`game.clock`（`exactly-one`，run 作用域）。
- 依赖：`platform.storage`，只读写分支级 `clock` 表。
- 控制端口：`read`、`start`、`pause`、`step`、`finishStep`、`setTick`。
- 时钟表由宿主在创建分支时写入初值；模块不自动把世界置为 running。

## 规则

- 每次模式变化递增 `runVersion`；控制接口可用 `expectedRunVersion` 做乐观并发检查。
- 单步只允许 1–24 tick，从 paused 进入 stepping，由宿主在收敛后调用 `finishStep` 回到 paused。
- `setTick` 只能前进，且只在 running 或 stepping 下允许；回退或暂停推进直接报错。

## 参数与限制

- 配置提供 `secondsPerTick`、`maxStepTicks` 与 `autoPauseAfterDisconnectMs`，默认 20 秒、24 tick 与 60000 毫秒。
- 时钟模块不执行 job、时钟步骤或事件消费；这些由 authority 的固定执行器按顺序驱动。
- 离线自动暂停与“客户端开局后自动继续”属于宿主运营流程，不在本模块内实现。
