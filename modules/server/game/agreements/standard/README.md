# game.agreements.standard

标准协议服务。追踪结构化条款的真实履约情况，不替角色记忆承诺。

## 边界

- 提供能力：`game.agreements`（`exactly-one`，run 作用域）。
- 拥有聚合：`agreement`。
- 依赖：`game.world`、`game.map`、`game.actions`、`game.comms`。
- 命令：`agreement.propose`、`agreement.respond`；job：过期、条款违约检查。
- 时钟步骤：章节终点调用 `game.world` 的章节评估操作，并传入 `countsAsOf(tick)` 的履约/违约计数。
- 订阅：`TaskCompleted`、`InformationShared`、`PolicyChanged`。

## 规则

- 提出者在提出时视为已接受；其余当事人 accept 后生效；reject 关闭；counter 生成 version+1 的新提案。
- 当事人至少两个且互不相同，必须包含提出者；义务人必须是当事人；截止 tick 必须在当前 tick 之后 168 tick 内。
- `delegate` 生效即履约。`grant-passage`、`water-allocation` 生效即记为履约，但义务期内仍有持续义务：`untilTick` 未过时协议保持 `active`，由 `untilTick + 1` 的期限 job 复核政策/道路状态后收尾。
- 其余条款在 `byTick + 1` 的期限 job 先按已提交事实（已完成任务、已提交分享）复核，满足即补记履约；不满足才违约。
- 事件订阅一律按事件发生的 tick 判定生效前/截止前：`InformationShared`、`PolicyChanged` 用 `event.worldTick`，任务类用任务的权威完成 tick。
- 履约后提交 `AgreementTermFulfilled`，全部条款履约且没有未到期持续义务后 `AgreementFulfilled`。
- 任一条款违约后协议状态为 `breached`，其余条款继续追踪，不自动关闭；已记录的违约不会被后续履约或政策恢复改写。

## 参数与限制

- 过期默认 24 tick，显式 `expiresInTicks` 上限 168。
- `delegate` 条款的 `stockpileId` 目前要求非空：世界委托聚合的 `stockpileId` 仍为非空字符串；规则文档允许 null，这是已报告的实现/规范冲突，待后续步骤统一。
- 本模块只读取任务完成事实；不直接修改行动、地图或世界聚合，效果通过端口提交。
