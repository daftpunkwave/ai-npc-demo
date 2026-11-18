# game.agreements.standard

标准协议服务。追踪结构化条款的真实履约情况，不替角色记忆承诺。

## 边界

- 提供能力：`game.agreements`（`exactly-one`，run 作用域）。
- 拥有聚合：`agreement`。
- 依赖：`game.world`、`game.map`、`game.actions`、`game.comms`。
- 命令：`agreement.propose`、`agreement.respond`；job：过期、条款违约检查。
- 订阅：`TaskCompleted`、`InformationShared`、`PolicyChanged`。

## 规则

- 提出者在提出时视为已接受；其余当事人 accept 后生效；reject 关闭；counter 生成 version+1 的新提案。
- 当事人至少两个且互不相同，必须包含提出者；义务人必须是当事人；截止 tick 必须在当前 tick 之后 168 tick 内。
- `grant-passage`、`water-allocation`、`delegate` 生效即履约；其余条款在 `byTick + 1` 检查违约，履约后提交 `AgreementTermFulfilled`，全部履约后 `AgreementFulfilled`。
- 任一条款违约后协议状态为 `breached`，其余条款继续追踪，不自动关闭。

## 参数与限制

- 过期默认 24 tick，显式 `expiresInTicks` 上限 168。
- `delegate` 条款的 `stockpileId` 目前要求非空：世界委托聚合的 `stockpileId` 仍为非空字符串；规则文档允许 null，这是已报告的实现/规范冲突，待后续步骤统一。
- 本模块只读取任务完成事实；不直接修改行动、地图或世界聚合，效果通过端口提交。
