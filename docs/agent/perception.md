# 世界感知模块详细设计

> perception 决定角色在何时、通过何种渠道获得哪些观察。交付进度见 [IMPLEMENTATION-STATUS.md — 总览](../IMPLEMENTATION-STATUS.md#1-总览)。

## 1. 职责与输入边界

权威世界先计算可见性和权限，再将合法候选交给 perception 插件。插件可以在候选范围内筛选、延迟、模糊或聚合；不能读取后台秘密、他人私人记忆、未来事件或未授权世界真值。

序章玩家是公社党魁，不会把公社 AI 党魁的全部感知授予玩家。15 个 gameplay Agent 包括 8 名公社支持者、4 名 AI 党魁和 3 名外域 Agent；每个主体都有独立的 scope、位置/职责与授权，详见 [角色](../game/characters.md)。

perception 不负责记忆的遗忘/检索、情绪持久化、完整 prompt 或行动结算。它给 memory/runtime 提供观察；读取完整世界日志做评分的研究员不属于 NPC 感知流程。

## 2. 三层知识边界

| 层 | 谁决定 | 示例 |
|---|---|---|
| 世界事实 | authority | 护送队确于 tick 42 抵达 |
| 可获知范围 | 内核 ACL、位置/渠道规则、已发布内容 | 在场者可见、派系收到正式简报、私人来信只给收件人 |
| 实际观察 | perception 策略 | 看见抵达、只听到车声、三 tick 后收到摘要 |

角色当前位置、身份和当前行动必要 receipt 是宿主固定输入；策略不得让 Agent 因未看见自己的接受回执而重复执行副作用。策略能调整的只有声明为实验维度的环境与事件信息，不能借此绕过平台协议。

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
| channel、epistemic、confidence | 渠道、witnessed/reported/inferred、0 到 1 置信 |
| releasePolicyId、content | 传播权限和结构化观察，权限由宿主合成 |

PerceptionPlan 返回新增观察候选、延迟队列操作、聚合变更、舍弃原因及 scannedThroughSeq。宿主校验后在同一 scoped transaction 提交观察、inbox、状态 revision 与水位。

scannedThroughSeq 是内部扫描 frontier，不发送模型；它可跨过没有获准观察的事件。observationSeq 与 worldSeq 分别表示角色观察序和 branch 事实序，不能数值混比或跨 branch 当全局时钟。

输入事件信封统一使用 `causationIds`，观察以来源引用保留因果追溯链。模型使用不透明来源 ID，不能凭连续全局序号推测发生了多少秘密事件。

## 4. 三个初始策略

| 插件 | 行为 | 对照问题 |
|---|---|---|
| `perception.local` | 在场或邻接的视听、定向来信、明确公开广播 | 空间距离和转述是否产生可信的信息差 |
| `perception.briefing` | 本地感知不变，职责内事件按周期形成简报 | 战略 Agent 能否凭有限简报形成长期政策 |
| `perception.attention` | 在合法候选中按话题、距离和身份显著度限量选择 | 注意力预算是否改善成本并保留关键行为 |

不存在默认供 NPC 使用的全知 oracle 实现。研究真值可以用于评分或构造已授权的探针，不能通过“调试感知”插回正常 NPC 输入。

首版筛选和聚合采用确定性规则，不对每条观察调用 LLM。如未来引入语义注意力，应新增明确 model purpose/capability，经统一模型池和预算管理，不让插件自持网络客户端。

## 5. 处理流程

处理流程是：已提交的世界事件或已发布内容先由内核按主体、地点、渠道和授权生成合法候选，perception 再给出筛选、延迟或聚合计划，宿主校验来源、权限与时间；通过后幂等提交观察与 last-known 投影，最后触发 memory 摄入或 turn。

1. 内核确认 observer 和候选属于同一 world/branch；客户端或模型提交的“我在场”不能替代位置事实。
2. 候选按 sourceEventId、渠道与接收者形成稳定投递键；重投不会产生两次“第一次听说”。
3. 过滤结果记录 selected/ignored/delayed/aggregated 及原因；遗漏是明确策略结果，不是无声丢消息。
4. 延迟项使用持久 job 和 dueTick；到期重新检查收件权限、渠道有效性及来源撤回状态。
5. 观察已提交后再通知 memory 与调度器；失败重试不先发送临时观察给模型。
6. 感知策略变化新建 run/branch，旧投递任务不能按新策略静默重放。

单一事实可产生不同合法观察。看到队伍回港可以确认“队伍抵达”；听到欢呼最多支持“港口似有好消息”，不能自动得到运输物资数量和秘密路线。

## 6. 信息传播与传闻

公开广播、派系简报、当面对话和私信都是显式渠道。A 将情报交给 B，先提交 InformationShared 命令；authority 检查发送者知识依据、允许受众和渠道，再形成 B 可获知的新事件。

转述观察保留原声称者、直接发送者、时间和置信度。“伊诺转来巡裔的说法”不能压成“伊诺亲眼看见袭击”。多级转述保留传播链条摘要与来源引用，传播跳数/置信策略可配置。

根庭通过根网共享信息也是世界规则赋予的渠道，不是直接查询其他根庭角色的 memory table。渠道可以断开、限速或仅覆盖部分地点；既定生物能力放在版本化规则中，不能由 Agent 自行扩展。

自然语言谣言只作为 reported；校验器知道它不真，不代表 NPC 能识破。角色需要可获知反证或求证行动，才更新认识。推断始终标 inferred，不在感知阶段伪造已发生事件。

## 7. 当前视图与主动感知

角色世界视图来自其 last-known 投影，不是每轮从完整数据库刷新。每个字段携带 asOf、渠道和来源；过时信息可以驱动误判，但展示为过去所知，不能冒充刚刚看见。

环境读取工具复用同一授权/感知边界。若“限视野”组仍能用普通地图工具直接读全部据点的即时状态，这个对照就无效；允许主动侦察时，应把侦察作为明确行动，计入成本并生成新观察记录。

首版 turn 的被动输入和世界读取工具均使用冻结 inputFrontier；侦察等新动作提交后，其结果形成后续观察/turn。开环使用同一检查点工具快照；重决策途中不引入新的世界事实。裁决仍以提交时合法前置条件检查，陈旧感知不能保证行动成功。

本 turn 自己发起的合法副作用工具 receipt 是有限追加输入，允许在 frontier 之后产生；用 toolCallId、operationId、acceptedEventIds 绑定操作与结果。它可供同 turn 后续模型/speech 了解受理/拒绝状态，但不刷新 ambient 世界视图，不回写冻结 memory revision；新侦察见闻仍属于后续 turn。

回执的 commandStatus 只表示 accepted/rejected，任务推进由独立 taskStatus 投影表达；工具 executionStatus=ok 只表示拿到确定响应，不证明命令获准或任务完成。感知不得混淆这三层状态。

玩家客户端看到的授权地图是玩家投影，不直接作为所有 NPC 的 worldView。视觉渲染遮挡也不是知识权限；灰盒地图的屏幕位置与游戏世界位置分离，见 [架构](../architecture/overview.md)。

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
    visibleGraphDepth: 0
    extraDelayTicks: { broadcast: 0, directed: 0, briefing: 0 }
    maxObservationsPerBatch: 12
    retainUncertainCues: true
```

这是初始参数示例，不是经过验证的最优范围。异地送达的基础延迟由世界规则写在事件逐主体的 `deliveries[].deliverAtTick` 里（见 [规则](../game/rules.md) 第 9 节），`extraDelayTicks` 只是实验用的额外延迟，默认 0，避免重复计算。descriptor 声明单位、能力、稳定随机源与不可变字段；配置继承、阶段冻结和 UI 展示见 [统一配置](../platform/configuration.md)。

## 9. 状态、故障与生命周期

持久状态包含 revision、scannedThroughSeq、每渠道去重键、延迟队列、聚合桶、last-known 投影版本和 source lineage。memory 自己推进 durableThroughSeq/derivedThroughSeq，不能因感知已扫描就伪造记忆已摄入。

| 情况 | 处理 |
|---|---|
| 角色无权看到某事件 | 正常无观察；内部扫描继续，不向模型暴露空白事件 |
| 注意力容量不足 | 按声明策略舍弃/聚合/延迟，保留计数和原因 |
| 来源或消息权限收紧 | 取消尚未交付项；已知资料按撤回规则产生失效传播 |
| 插件失败/队列积压 | 不推进成功水位；正式实验阻止评分，在线运行显式报告故障，或声明使用 fallback |
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

## 11. 首版实现规格：`agent.perception.local`

### 11.1 处理流程

感知消费者按 `worldSeq` 顺序读取新事件，每个事件在一个事务里处理完全部 Agent：

1. 宿主按 [领域模型](../architecture/domain-model.md) 第 7 节计算有资格的 Agent 集合（硬 ACL）。玩家不经过感知模块，玩家投影直接按 ACL 构建。
2. 对每个有资格的 Agent，模块按 11.2 节决定渠道、获知方式、置信度与细度，按 11.3 节决定 `knownAtTick`。
3. `knownAtTick ≤ event.worldTick` 的观察直接写入 `observations`（分配该 Agent 的下一个 `observationSeq`）；更晚的观察暂存于 `perception_state.state_json.pending` 队列，由消费者在后续 tick 推进时 `flush` 写入（当前不额外调度 `perception.deliver` job）。
4. 同一 tick 内的 `maxObservationsPerBatch` 批量聚合、`visibleGraphDepth` 邻接摘要与 `retainUncertainCues` 当前在配置 schema 中保留，实现层暂未启用批量合并与邻接扩散。
5. 推进该 Agent 的 `scanned_through_seq`；没有资格的事件也会推进扫描游标，但不生成任何观察。
6. 事务提交后，通知记忆摄入与调度器（11.5 节）。

### 11.2 渠道、获知方式与细度

对每个有资格的 Agent，按下表**从上到下第一个匹配的行**决定渠道；“自己”指该 Agent。

| # | 情形 | channel | epistemic | confidence | detail | extraDelayTicks 键 |
|---|---|---|---|---|---|---|
| 1 | `DialogueSubmitted`，channel 为 face-to-face，自己不是说话人 | `face-to-face` | witnessed（话语本身）；话语里的说法另记为声称 | 0.6 | full | — |
| 2 | `DialogueSubmitted`（channel relay）或定向 `MessageSent`，自己不是发送者 | `relay` | reported | 0.6 | full | directed |
| 3 | `InformationShared`，自己在受众中且不是分享者 | `evidence` | reported | 0.9 | full | directed |
| 4 | `ProbeAsked`（只在 sandbox 分支） | `probe` | reported | 0.6 | full | — |
| 5 | `MessageSent` channel broadcast | `broadcast` | reported | 0.7 | full | broadcast |
| 6 | `RumorSpread` | `rumor` | reported | 0.3 | full | broadcast |
| 7 | 官方公开通报：`MetersChanged`、`PolicyChanged`、`PassageGranted`、`DayPassed`、危机事件、`Group*`、`CharacterMoved`、`TeamMoved`、`CampaignStarted`、`MotionDecided`、`ChapterStageEvaluated` | `public-notice` | witnessed | 1.0 | full | broadcast |
| 8 | 自己是事件主体：自己发出的命令产生的事件、自己受伤、`AgentsSummoned` 点名自己 | `self` | witnessed | 1.0 | full | — |
| 9 | 其余 `principals` 受众中有自己（协议、邀请、任务、委托等正式通知） | `party` | witnessed | 1.0 | full | — |
| 10 | `node` 受众，自己当时在该节点 | `on-site` | witnessed | 1.0 | summary | — |
| 11 | `faction` 受众（派系简报） | `briefing` | witnessed | 1.0 | full | briefing |

`detail: summary` 时，宿主在调用感知模块前只提供事件类型、主体和节点。任务参数、货物、预留和受邀者等明细只提供给获准读取详情的主体。任务的风险抽样结果在任何情况下都不进入观察。`visibleGraphDepth = 1` 时，相邻节点的角色也能以 `summary` 细度观察到 `TaskDeparted`、`TaskCompleted`、`WorldFactRecorded`；首版默认 0。

### 11.3 获知时间与传播权限

- `occurredAtTick` = 事件的 `worldTick`；`knownAtTick = max(rendered.knownAtTick, nowTick, event.worldTick) + extraDelayTicks[该行的键]`（键为 — 时加 0，其中 `rendered.knownAtTick` 优先取 `payload.deliveries` 中本主体的 `deliverAtTick`）；`sensedAtTick` 在 local 策略下等于 `knownAtTick`。
- `releasePolicyId` 按 [prompts](prompts.md) 第 3 节赋值：public 与 node 受众为 `public`；principals 受众为 `parties:<排序后的名单>`；faction 受众为 `faction:<factionId>`；证据为 `holders:<evidenceId>`。
- `ProbeAsked` 特殊使用 `parties:<排序去重后的 askedBy, agentId>`，而不是仅 agentId；只允许回答提问者，不扩展实际事件 audience。
- 通信事件没有本主体 delivery 时不生成观察；混合受众定向发送的原子拒绝、广播本地子集和逐收件者冻结延迟遵循规则第 9 节，不以最慢接收者统一延迟。
- 来源字段：`sourceEventIds = [eventId]`；转述类观察（对话、消息、传闻）在 `content.claim` 中记录原声称者（`sourceId`）与直接发送者。

### 11.4 观察内容

```ts
interface ObservationContent {
  eventType: string;
  summaryZh: string;            // 由事件类型的模板渲染。
  subjectIds: string[];         // 涉及的 principal。
  nodeId: string | null;
  refs: { agreementId?: string; taskId?: string; evidenceId?: string; conversationId?: string; dialogueId?: string; messageId?: string };
  facts: Json;                  // 细度过滤后保留的 payload 字段。
  claim: { sourceId: string; senderId: string; text: string } | null; // 用于转述对白与传闻。
  detail: "full" | "summary";
}
```

`summaryZh` 仅由授权且按 detail 过滤后的数据渲染。下表是完整的 `prompts/zh-CN.yaml` 中 `observationTemplates` 清单（每行一个键，不能省略 system 事件；system 模板不产生 gameplay 观察）：

| 事件 | 模板 |
|---|---|
| `CampaignStarted` | `战役已开始。` |
| `DelegationCreated` | `已建立委托 {delegationId}。` |
| `KnowledgeGranted` | `已获得一项授权资料。` |
| `MessageSent` | `{fromName}来信：“{text}”` |
| `DialogueSubmitted` | `{speakerName}说：“{text}”` |
| `InformationShared` | `{fromName}分享了证据《{evidenceTitle}》。` |
| `RumorSpread` | `听说（来源：{sourceName}）：{text}` |
| `WorldFactRecorded` | `{text}` |
| `AgentsSummoned` | `你收到一次召集。` |
| `ProbeAsked` | `【{askedByName} 问你】{question}` |
| `AgreementProposed` | `收到协议提案 {agreementId}：{termsText}` |
| `AgreementResponded` | `协议 {agreementId} 收到回应。` |
| `AgreementActivated` | `协议 {agreementId} 生效：{termsText}` |
| `AgreementRejected` | `协议 {agreementId} 被拒绝。` |
| `AgreementExpired` | `协议 {agreementId} 已过期。` |
| `AgreementSuperseded` | `协议 {agreementId} 已被新提案替代。` |
| `AgreementTermFulfilled` | `已履行：{termText}` |
| `AgreementFulfilled` | `协议 {agreementId} 已全部履行。` |
| `AgreementBreached` | `{obligorName}没有按期履行：{termText}` |
| `PassageGranted` | `{roadName}已授予通行许可。` |
| `PolicyChanged` | `{byName}把 {keyName} 改为“{newValueName}”。` |
| `TaskDispatched` | `任务 {taskId} 已安排。` |
| `ResourcesReserved` | `任务 {taskId} 已预留资源。` |
| `ResourcesReleased` | `任务 {taskId} 已释放预留资源。` |
| `TaskInvitationIssued` | `你收到任务 {taskId}（{taskTypeName}）的邀请，tick {departTick} 出发。` |
| `TaskInvitationAnswered` | `任务 {taskId} 的邀请收到回应。` |
| `TaskInvitationExpired` | `任务 {taskId} 的邀请已过期。` |
| `TaskDeparted` | `任务 {taskId} 已出发。` |
| `TaskDelayed` | `任务 {taskId} 因道路风险延误，预计 tick {newCompletionTick} 完成。` |
| `TaskCompleted` | `任务 {taskId}（{taskTypeName}）完成：{effectsText}` |
| `TaskFailed` | `任务 {taskId} 失败：{reasonText}` |
| `TaskCancelled` | `任务 {taskId} 已取消。` |
| `ResourcesTransferred` | `资源运输已结算。` |
| `ResourcesConsumed` | `资源消耗已结算。` |
| `StockpileAdjusted` | `库存已调整。` |
| `CharacterMoved` | `{name}已抵达{toNodeName}。` |
| `TeamMoved` | `{name}已抵达{toNodeName}。` |
| `CharacterInjured` | `{agentName}受伤，预计 tick {untilTick} 恢复。` |
| `CharacterRecovered` | `{agentName}已恢复。` |
| `TeamRecovered` | `{teamName}已恢复。` |
| `EvidenceDiscovered` | `发现证据《{evidenceTitle}》。` |
| `ScoutReported` | `收到{nodeName}的侦察报告。` |
| `GroupRescued` | `{groupName}已获救。` |
| `GroupWorsened` | `{groupName}的状况恶化。` |
| `MetersChanged` | `{changesText}` |
| `RelayDegraded` | `中继已降级。` |
| `RelayDown` | `中继已中断。` |
| `RelayRestored` | `中继已恢复。` |
| `OrchardCrisis` | `果园出现危机。` |
| `OrchardDamaged` | `果园受到损害。` |
| `MigrationCrisis` | `迁徙安全出现危机。` |
| `SupplyShortage` | `供给出现短缺。` |
| `DayPassed` | `第 {day} 日结算完成。` |
| `ChapterStageEvaluated` | `序章评估已完成。` |
| `ScenarioCardTriggered` | `剧情卡状态已更新。` |
| `ScenarioCardPublished` | `剧情卡状态已更新。` |
| `ScenarioCardWithdrawn` | `剧情卡状态已更新。` |
| `ScenarioCompensationApplied` | `剧情卡状态已更新。` |
| `ScenarioOverrideApplied` | `剧情卡状态已更新。` |

序章程序案交付时，`MotionDecided` 已列入 `officialPublicTypes` 公开通报清单，`prompts/zh-CN.yaml` 尚未补充该事件的专用摘要模板（当前按默认通用模板渲染为“事件状态已更新。”）。参见 [domain-model.md — 事件目录](../architecture/domain-model.md#6-事件目录)。

`{termText}` 当前实现由 `termsText()` 渲染为 `<kind>（<obligorId>）`，`AgreementTermFulfilled`/`AgreementBreached` 中的 `{termText}` 暂取固定占位词 `"条款"`，`{groupName}`/`{roadName}` 暂取聚合 ID；`summary` 细度下 `summaryZh` 统一渲染为 `${eventType} · ${nodeName} · ${name}`。以下是 `termTemplates.<kind>` 契约模板（`{termsText}` 为全部条款以“；”连接）：

| kind | 模板 |
|---|---|
| `deliver` | `{obligorName}在 tick {byTick} 前把 {amount} 点{resourceName}从{fromNodeName}送到{toNodeName}` |
| `escort` | `{obligorName}在 tick {byTick} 前护送{roadName}` |
| `rescue` | `{obligorName}在 tick {byTick} 前救出{groupName}` |
| `repair-relay` | `{obligorName}在 tick {byTick} 前修复中继` |
| `share-evidence` | `{obligorName}在 tick {byTick} 前把《{evidenceTitle}》交给{toName}` |
| `grant-passage` | `{obligorName}允许{granteeFactionName}通行{roadName}，直到 tick {untilTick}` |
| `water-allocation` | `{obligorName}把水闸分配保持为“{policyName}”，直到 tick {untilTick}` |
| `delegate` | `{obligorName}把队伍与物资委托给{granteeName}，直到 tick {untilTick}` |

名称（`*Name`）从内容包与 `locale` 取：主体用人格的 `name`（玩家为“党魁”），节点用 `nodes`，道路用“{a 节点}—{b 节点}的道路”。

渲染绑定必须在 detail 过滤之后执行，禁止模板从聚合或未授权 artifact 补回字段。`facts` 也只保留同一过滤结果；summary 的任务完成只渲染“任务 {taskId} 完成”，不含 effects。system 事件先被 ACL 排除，不借模板获得可见性。

- `*Name` 只查内容包公开名称/locale；`name` 对应移动事件的 id。`reasonText` 取 `locale.reasonCodes[reasonCode]`。证据标题仅在授权后查证据索引，KnowledgeGranted 模板不渲染秘密标题或正文。
- `changesText` 按事件 changes 顺序渲染 `observationChange`（`{meterName}：{from} → {to}（{causeName}）`），以“；”连接。`causeName` 用内容包 `causeNames` 的公开分类：daily、task、road-risk、group-deadline、scenario-pressure；生产者把内部原因映射为其中一项，不放卡片/秘密 ID 或隐藏理由。仅这些公开分类进入 MetersChanged.cause；不能用原始 cause 字符串兜底。
- `effectsText` 的输入是 TaskCompleted.effects 的公开结果列表 `{ kind: "transport" | "escort" | "rescue" | "repair" | "scout" }[]`（依结算顺序，至少任务本身一项），按 `effectTemplates.<kind>` 渲染并以“；”连接。数量、库存、证据正文、侦察详细结果与风险抽样均不放入此字段；详细结算由各自授权事件表达，履约查询 task。
- `WorldFactRecorded` 首版仅支持 ConvoyDelayed：text 取授权事件 payload.payload.text（内容包卡片声明的公开正文），不是读取未发布卡片。新增 factType 必须同时声明安全字段绑定。
- 缺少必需绑定或模板是配置/渲染错误，阻止消费并报告；不使用原始 JSON、秘密或空字符串兜底。

### 11.5 唤醒与通知

观察写入后，宿主按下表生成 trigger（调度器合并规则见 [运行时](runtime.md) 第 13 节）。没有列出的观察只进入记忆，不唤醒 Agent。

| 观察 | trigger kind |
|---|---|
| 玩家对自己说话（`DialogueSubmitted` 且说话人为玩家） | `player-dialogue` |
| 收到定向消息、证据 | `message` |
| 收到任务邀请 | `task-invite` |
| 收到协议提案或还价 | `agreement-proposal` |
| 自己参与的任务失败、自己受伤、与自己派系相关的危机（当前实现中观察到的 `TaskFailed`、`CharacterInjured`、`RelayDown`、`OrchardCrisis`、`MigrationCrisis` 均会触发，尚未按派系细分危机） | `alert` |
| `AgentsSummoned` 点名自己 | `scenario` |
| `ProbeAsked` 问自己 | `probe` |

### 11.6 状态

`perception_state.state_json` 当前保存待投递延迟队列 `pending` 与 `lastKnown` 字段（事件去重由 `consumer_inbox` 承担，`lastKnown` 当前在感知消费者中保持原样透传、尚未写入刷新后的指标快照，决策上下文中的“当前局势”由观察与记忆材料装配）。
