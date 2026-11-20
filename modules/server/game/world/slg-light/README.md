# game.world.slg-light

首章“水闸之前”的轻数值世界服务。拥有 campaign、指标、角色、队伍、群体、委托与证据位置。

## 边界

- 提供能力：`game.world`（`exactly-one`，run 作用域）。
- 依赖：`game.map`、`game.resources`；只通过端口读写道路与库存。
- 拥有聚合：`campaign`、`meters`、`character`、`team`、`group`、`delegation`、`evidence-placement`。
- 命令：`campaign.start`、`policy.set`；job：群体期限、角色恢复、队伍恢复；时钟步骤：每日结算、章节评估。

## 规则

- `campaign.start` 建立 campaign、三个指标、十二位角色、八支队伍、群体、证据位置与九份委托，并安排群体期限 job。
- 每日结算按水闸分配计算中继与果园，按迁徙季与隘口道路计算迁徙安全，再消耗公共供给；结果截断在 0–100。
- 首次低于阈值才发布危机事件；中继恢复到 30 以上发布恢复事件。每日结算以 `lastDailyTick` 防止同 tick 重复执行。
- 同一主体对同一库存点的多份有效委托按 `delegationId` 字典序逐份扣减；资源不足时整笔失败，不留下部分余额变化。`drawAuthority` 的余额按资源合计，委托 ID 取稳定首份，到期 tick 取有效委托中的最早值。
- 章节评估在配置的 `chapterLengthTicks` 到达后执行，默认 tick 168；评估结果写入 campaign，随后暂停时钟并保留存档。

## 参数与限制

- `chapterLengthTicks` 必须为正整数，缺省值为 168；模块创建时读取并校验该配置，非法值在装配阶段失败。指标数值来自内容包，修改数值需要新 run。
- 世界模块不读取 Agent 记忆、不生成对白、不自行调用模型。
- 章节评估经 `game.agreements` 的 `countsAsOf` 同步统计协议，不保留事件累计副本；消费者滞后也按已提交事实计算。
