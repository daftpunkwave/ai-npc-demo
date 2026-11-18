# game.comms.standard

标准通信服务。拥有会话与知识授权，负责按中继状态冻结逐主体送达时间。

## 边界

- 提供能力：`game.comms`（`exactly-one`，run 作用域）。
- 拥有聚合：`conversation`、`knowledge-grant`。
- 依赖：`game.world`，只读指标与角色位置。
- 命令：`dialogue.say`、`speech.commit`、`seat.say`、`information.share`。
- `campaign.start` 后续钩子提交开局消息与内容包 `heldBy` 知识授权。

## 规则

- 同节点与发送者回显立即送达；定向消息/证据分享在中继正常时 +1、降级时 +3，中断时拒绝。
- 对话在中继正常时立即、降级时 +2，中断时拒绝。
- 广播在中断时只保留同节点收件者；开局消息固定 tick 0。
- 投递名单按 principalId 排序去重并随事件冻结；`speech.commit` 只接受已批准且主体/分支/受众完全匹配的对白。

## 参数与限制

- 模块没有独立配置；中继状态由世界指标推导。
- 会话只保存参与者和最后序号；逐行对话投影由宿主事件投影在后续装配步骤读取。
- 通信模块不判断任务、协议或剧情合法性，只执行送达与知识写入。
