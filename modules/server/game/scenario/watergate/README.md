# game.scenario.watergate

首章剧情卡服务，另提供 `game.scenario.watergate-escalating` 替换实现。

## 边界

- 提供能力：`game.scenario`（`exactly-one`，run 作用域）。
- 拥有聚合：`scenario-card`、`scenario-run`。
- 依赖：`game.world`、`game.map`、`game.resources`、`game.comms`、`game.actions`。
- 命令：`scenario.publish`、`scenario.withdraw`、`scenario.compensate`、`scenario.override`。
- 后续钩子：`campaign.start` 安排内容包默认剧情的卡片 job。
- job：`scenario.card`；升级版订阅 `TaskCompleted`、`DayPassed`。

## 规则

- 每张卡最多触发一次，job 幂等键为 `scenario-card:<cardId>@<version>`。
- 标准节奏使用卡片 `atTick`；升级版使用 `floor(atTick * 0.75)`。
- 效果白名单：广播、定向消息、传闻、叙事事实、库存调整、唤醒 Agent；剧情卡不修改指标或道路状态。
- 覆盖命令额外允许指标设置与道路状态设置，并提交 `ScenarioOverrideApplied`。
- 升级版在 `card-relay-alarm` 已触发且尚未完成修复时，每个 `DayPassed` 额外降低 `relay.stability` 2。

## 参数与限制

- 草稿由运营 API 写入 `scenario-card` 状态；本模块的 `scenario.publish` 只发布已有草稿。
- 当前运行表没有污染字段，覆盖命令只提交事件；`contaminated` 标记由后续宿主/评估步骤接线。
- 内容包默认剧情来自 `GameContent.defaultScenario`。
