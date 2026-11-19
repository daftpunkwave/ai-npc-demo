# game.comms.standard

标准通信服务。拥有会话、通信日志、知识授权与证据分享事实，负责按中继状态冻结逐主体送达时间。

## 边界

- 提供能力：`game.comms`（`exactly-one`，run 作用域）。
- 拥有聚合：`conversation`、`message`、`knowledge-grant`、`share`。
- 依赖：`game.world`，只读指标与角色位置。
- 命令：`dialogue.say`、`speech.commit`、`seat.say`、`information.share`。
- `campaign.start` 后续钩子提交开局消息与内容包 `heldBy` 知识授权。
- 事件消费者 `comms-rumor-log` 把公开传闻 `RumorSpread` 物化为 `reported` 渠道的通信日志。

## 规则

- 同节点与发送者回显立即送达；定向消息/证据分享在中继正常时 +1、降级时 +3，中断时拒绝。
- 对话在中继正常时立即、降级时 +2，中断时拒绝。
- 广播在中断时只保留同节点收件者；开局消息固定 tick 0。
- 投递名单按 principalId 排序去重并随事件冻结；`speech.commit` 只接受已批准且主体/分支/受众完全匹配的对白。
- 证据分享在同一事务内写入 `share` 聚合（分享者、证据、受众、提交 tick），协议期限 job 与章节统计据此复核已提交的分享事实。
- 已提交的消息与对白在同一事务内写入 `message` 与 `conversation` 聚合：正文、渠道与冻结投递名单都按提交 tick 固化，供投影与读接口按送达 tick 过滤。

## 参数与限制

- 模块没有独立配置；中继状态由世界指标推导。
- 会话按 `seq` 保存逐行正文与投递名单；通信日志保存正文、渠道与投递名单，二者都只由命令处理器与传闻消费者写入。
- 通信模块不判断任务、协议或剧情合法性，只执行送达与知识写入。
