# game.world.slg-light

首章“水闸之前”的轻数值世界服务。拥有 campaign、指标、角色、队伍、群体、委托、证据位置与章节统计。

## 边界

- 提供能力：`game.world`（`exactly-one`，run 作用域）。
- 依赖：`game.map`、`game.resources`；只通过端口读写道路与库存。
- 拥有聚合：`campaign`、`meters`、`character`、`team`、`group`、`delegation`、`evidence-placement`、`chapter-stats`。
- 命令：`campaign.start`、`policy.set`；job：群体期限、角色恢复、队伍恢复；时钟步骤：每日结算、章节评估。

## 规则

- `campaign.start` 建立 campaign、三个指标、十二位角色、八支队伍、群体、证据位置与九份委托，并安排群体期限 job。
- 每日结算按水闸分配计算中继与果园，按迁徙季与隘口道路计算迁徙安全，再消耗公共供给；结果截断在 0–100。
- 首次低于阈值才发布危机事件；中继恢复到 30 以上发布恢复事件。每日结算以 `lastDailyTick` 防止同 tick 重复执行。
- 章节评估在 tick 168 执行，结果写入 campaign；评估后进入自由模式，不结束游戏。

## 参数与限制

- 配置仅提供章节长度默认值 168；指标数值来自内容包，修改数值需要新 run。
- 世界模块不读取 Agent 记忆、不生成对白、不自行调用模型。
- 协议履约计数由事件消费者累加；消费者追平前章节评估只看到已提交的计数。
