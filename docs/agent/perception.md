# 世界感知模块详细设计

> 状态：目标规范，尚未实现。perception 决定“角色在何时、通过何种渠道获得哪些观察”，让同一世界中的不同角色拥有不同知识。世界唯一不等于角色全知。

## 1. 职责与输入边界

权威世界先计算可见性和权限，再将合法候选交给 perception 插件。插件可以在候选范围内筛选、延迟、模糊或聚合；不能读取后台秘密、他人私人记忆、未来事件或未授权世界真值。

单玩家选择五个人类派系之一开局，不会将该派系战略 Agent 的所有感知授予玩家。默认20 个 gameplay Agent 包括5 个人类派系战略、3 个非人类势力战略和12 个可交互角色；每个主体均有独立 scope、位置/职责与授权，详见 [角色](../game/characters.md)。

perception 不负责记忆的遗忘/检索、情绪持久化、完整 prompt 或行动结算。它给 memory/runtime 提供观察；读取完整世界日志做评分的研究员不属于 NPC 感知链路。

## 2. 三层知识边界

| 层 | 谁决定 | 示例 |
|---|---|---|
| 世界事实 | authority | 护送队确于 tick 42 抵达 |
| 可获知范围 | 内核 ACL、位置/渠道规则、已发布内容 | 在场者可见、派系收到正式简报、私人来信只给收件人 |
| 实际观察 | perception 策略 | 看见抵达、只听到车声、三 tick 后收到摘要 |

角色当前位置、身份和当前行动必要 receipt 是宿主固定输入；策略不得让 Agent 因未看见自己的接受回执而重复执行副作用。可调整的是声明为实验维度的环境/事件信息，不是绕过平台协议。

所有 Agent 读同一版本公开 lore；隐藏历史真相或未来剧情属于未发布内容，不放进共享 lore 后再要求角色假装不知道。派系与角色即使政治立场相近，也不自动共用感知数据库。

## 3. 输入输出契约

| `PerceptionRequest` 字段 | 含义 |
|---|---|
| scope、runId、profileHash | worldId/branchId/agentId；一 run 独占 branch |
| candidateBatchId、候选版本 | 宿主授权后的事实/投影引用，不提供原始全局查询口 |
| branch frontier、截止 worldTick | 本次允许处理的因果边界与逻辑时间 |
| grants、channel、observerState | 宿主核验的权限、感官/通信渠道、位置和职责 |
| pluginConfig、baseRevision | 固定配置与感知状态版本 |

| `AgentObservation` 字段 | 规范 |
|---|---|
| observationId、scope、observationSeq | 宿主生成，本 Agent 本地单调序列 |
| sourceEventIds/sourceObservationIds | 亲历指向事件；转述指向合法消息/来源观察 |
| occurredAtTick、sensedAtTick、knownAtTick | 原事发生、被感知、角色实际获知三个时点 |
| channel、epistemic、confidence | 渠道、witnessed/reported/inferred、0–1 置信 |
| releasePolicyId、content | 传播权限和结构化观察，权限由宿主合成 |

PerceptionPlan 返回新增观察候选、延迟队列操作、聚合变更、舍弃原因及 scannedThroughSeq。宿主校验后在同一 scoped transaction 提交观察、inbox、状态 revision 与水位。

scannedThroughSeq 是内部扫描 frontier，不发送模型；它可跨过没有获准观察的事件。observationSeq 与 worldSeq 分别表示角色观察序和 branch 事实序，不能数值混比或跨 branch 当全局时钟。

输入事件信封统一使用 `causationIds`，观察以来源引用保留链路。模型使用不透明来源 ID，不能凭连续全局序号推测发生了多少秘密事件。

## 4. 三个初始策略

| 插件 | 行为 | 对照问题 |
|---|---|---|
| `perception.local` | 在场/邻接视听＋定向来信＋明确公开广播 | 空间距离和转述是否产生可信的信息差 |
| `perception.briefing` | 本地感知不变，职责内事件按周期形成简报 | 战略 Agent 能否凭有限简报形成长期政策 |
| `perception.attention` | 在合法候选中按话题、距离和身份显著度限量选择 | 注意力预算是否改善成本并保留关键行为 |

不存在默认供 NPC 使用的全知 oracle 实现。研究真值可以用于评分或构造已授权的探针，不能通过“调试感知”插回正常 NPC 输入。

首版筛选和聚合采用确定性规则，不对每条观察调用 LLM。如未来引入语义注意力，应新增明确 model purpose/capability，经统一模型池和预算管理，不让插件自持网络客户端。

## 5. 处理流程

```text
已提交世界事件/已发布内容
  → 内核按主体、地点、渠道和授权生成合法候选
  → perception 门控/延迟/聚合计划
  → 宿主来源/权限/时间校验
  → 幂等提交观察与last-known投影
  → memory摄入/turn触发
```

1. 内核确认 observer 和候选属于同一 world/branch；客户端或模型提交的“我在场”不能替代位置事实。
2. 候选按 sourceEventId、渠道与接收者形成稳定投递键；重投不会产生两次“第一次听说”。
3. 过滤结果记录 selected/ignored/delayed/aggregated 及原因；遗漏是明确策略结果，不是无声丢消息。
4. 延迟项使用持久 job 和 dueTick；到期重新检查收件权限、渠道有效性及来源撤回状态。
5. 观察已提交后再通知 memory 与调度器；失败重试不先发送临时观察给模型。
6. 感知策略变化新建 run/branch，旧投递任务不能按新策略静默重放。

单一事实可产生不同合法观察。看到队伍回港可以确认“队伍抵达”；听到欢呼最多支持“港口似有好消息”，不能自动得到运输物资数量和秘密路线。

## 6. 信息传播与传闻

公开广播、派系简报、当面对话和私信都是显式渠道。A 将情报交给 B，先提交 InformationShared 命令；authority 检查发送者知识依据、允许受众和渠道，再形成 B 可获知的新事件。

转述观察保留原声称者、直接发送者、时间和置信度。“伊诺转来巡裔的说法”不能压成“伊诺亲眼看见袭击”。多级转述保留链路摘要与来源引用，传播跳数/置信策略可配置。

根庭通过根网共享信息也是世界规则赋予的渠道，不是直接查询其他根庭角色的 memory table。渠道可以断开、限速或仅覆盖部分地点；既定生物能力放在版本化规则中，不能由 Agent 自行扩展。

自然语言谣言只作为 reported；校验器知道它不真，不代表 NPC 能识破。角色需要可获知反证或求证行动，才更新认识。推断始终标 inferred，不在感知阶段伪造已发生事件。

## 7. 当前视图与主动感知

角色世界视图来自其 last-known 投影，不是每轮从完整数据库刷新。每个字段携带 asOf、渠道和来源；过时信息可以驱动误判，但展示为过去所知，不能冒充刚刚看见。

环境读取工具复用同一授权/感知边界。若“限视野”组仍可用普通地图工具直接读全部据点即时状态，该对照无效；允许主动侦察时将其作为明确行动、成本和新观察记录。

首版 turn 的被动输入和世界读取工具均使用冻结 inputFrontier；侦察等新动作提交后，其结果形成后续观察/turn。开环使用同一检查点工具快照；不在重决策途中偷偷引入新世界事实。裁决仍以提交时合法前置条件检查，陈旧感知不能保证行动成功。

本 turn 自己发起的合法副作用工具 receipt 是有限追加输入，允许在 frontier 之后产生；用 toolCallId、operationId、acceptedEventIds 绑定操作与结果。它可供同 turn 后续模型/speech 了解受理/拒绝状态，但不刷新 ambient 世界视图，不回写冻结 memory revision；新侦察见闻仍属于后续 turn。

回执的 commandStatus 只表示 accepted/rejected，任务推进由独立 taskStatus 投影表达；工具 executionStatus=ok 只表示拿到确定响应，不证明命令获准或任务完成。感知不得混淆这三层状态。

玩家客户端看到的授权地图是玩家投影，不直接作为所有 NPC 的 worldView。视觉渲染遮挡也不是知识权限；2.5D 地图的屏幕位置与游戏世界位置分离，见 [架构](../architecture/overview.md)。

## 8. 配置维度与示例

| 维度 | 可调内容 | 不可变边界 |
|---|---|---|
| 空间 | 邻接深度、视距、声音衰减 | authority 的位置与物种既定能力 |
| 渠道 | 广播订阅、简报周期、通信延迟 | 私信受众、未发布剧情权限 |
| 注意力 | 每批候选数、话题权重、保底类别 | 必要协议回执、来源真实性 |
| 表达 | 字段细度、噪声/模糊程度 | 不凭空创造客观事实或扩权 |
| 传播 | 最大跳数、去重、置信变换 | 不能绕过 releasePolicy |

以下仅展示 perception 槽配置片段，不是完整可启动配置：

```yaml
perception:
  module: agent.perception.local
  config:
    visibleGraphDepth: 1
    broadcastDelayTicks: 0
    directedMessageDelayTicks: 1
    maxObservationsPerBatch: 12
    retainUncertainCues: true
```

这是初始参数示例，不是经过验证的最优范围。descriptor 声明单位、能力、稳定随机源与不可变字段；配置继承、阶段冻结和 UI 展示见 [统一配置](../platform/configuration.md)。

## 9. 状态、故障与生命周期

持久状态包含 revision、scannedThroughSeq、每渠道去重键、延迟队列、聚合桶、last-known 投影版本和 source lineage。memory 自己推进 durableThroughSeq/derivedThroughSeq，不能因感知已扫描就伪造记忆已摄入。

| 情况 | 处理 |
|---|---|
| 角色无权看到某事件 | 正常无观察；内部扫描继续，不向模型暴露空白事件 |
| 注意力容量不足 | 按声明策略舍弃/聚合/延迟，保留计数和原因 |
| 来源或消息权限收紧 | 取消尚未交付项；已知资料按撤回规则产生失效传播 |
| 插件失败/队列积压 | 不推进成功水位；正式实验阻止评分，在线显式故障/声明fallback |
| 旧 job/策略结果晚到 | 检查 branch、profileHash、状态 revision 与租约，拒绝过期发布 |
| drain/恢复 | 停止新处理、保存队列与游标；重启按幂等键续投 |

已获知历史不能因角色后来移动就视为从未看见；遗忘由 memory 策略处理。彻底撤回或权限收紧的派生清理走来源协议，也不能假装已向玩家公开的台词从未出现。

## 10. 验收用例

1. 角色同场、隔墙、远程简报三种情况下获得不同但都有合法来源的观察。
2. 战略派系 Agent 与所属角色不自动互读；玩家改开局派系不获得全派系私密数据库。
3. 私信延迟后只交给收件人；重启和重复投递不多次写入，不暴露秘密事件的连续序号。
4. A 转述 B 的传闻后，接收者保留直接/原始来源与不确定性；未有反证时不因后台真值识破。
5. 限视野组的地图/工具调用不能绕过视野直接刷新全世界；侦察结果产生新的已记录观察。
6. 两分支复用同样输入/种子时规则感知结果一致；不同策略的实际选择和舍弃能逐项比较。
7. perception 故障不能生成空观察并推进为成功，memory 水位也不能被错误推进。
8. 已关闭/撤回渠道的旧任务不能晚到泄露；恢复运行与快照保留 pending 队列。

相关事件、快照与来源结构见 [事件和状态](../architecture/events-and-state.md)；感知准确度、知情泄露与行为影响采用 [评估](../platform/evaluation.md) 的共同分母和失败口径。
