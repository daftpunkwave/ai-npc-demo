# 事件、状态、一致性与恢复

> 本篇拥有世界提交、时钟任务、scope、水位、快照与恢复语义。Agent 运行流程的细节由 [runtime](../agent/runtime.md) 维护。

## 1. 一次交互的完整链路

~~~mermaid
sequenceDiagram
  participant P as 玩家
  participant W as 世界服务
  participant D as 事件与任务库
  participant G as 感知网关
  participant M as 记忆模块
  participant A as Agent Runtime
  participant L as 模型适配器
  P->>W: 提交交涉 commandId / expectedVersion
  W->>W: 鉴权、去重、规则校验
  W->>D: 原子写 receipt / facts / state / outbox
  D-->>P: accepted / rejected 与授权投影
  D->>G: 已提交事实（至少一次投递）
  G->>G: 硬权限过滤，再运行感知策略
  G->>M: 带来源的 AgentObservation
  M->>D: 幂等记忆写入与水位
  A->>D: 冻结 turn 输入 frontier 与 profile
  A->>M: 等待必要水位，再检索
  A->>L: 归档后的最终模型请求
  L-->>A: 结构化行动、对白意图与证据引用
  A->>W: 按提交时权限、版本、epoch 再校验
  W->>D: 原子提交新事实与后续任务
  W-->>A: accepted / rejected receipt
  A->>L: 仅含目标受众合法素材的独立对白请求
  L-->>A: 对外对白候选
  A->>W: 校验传播权限并提交对白
~~~

Agent 自主触发来自发给它的事件、当前 memory 提供的主观计划/提醒任务、有限巡检时钟或玩家直接交互；不存在每个 tick 让全部 Agent 无差别思考的轮询。正式合同到期任务只做规则结算并发布真实结果，不能向 M0 隐式灌入全部条款形成提前提醒。调度器按优先级、冷却、每身份互斥和预算合并触发，同时保留原始 trigger IDs；固定唤醒源的实验须声明这一控制变量。

一次 turn 的阶段固定为：冻结输入 → 感知投影 → 等待记忆就绪 → 查询/排序记忆 → 组上下文 → 工具视图处理 → 必要压缩 → 最终预算与协议检查 → 决策/工具有界循环（每轮可产生候选决策）→ 命令裁决 → 安全对白生成与提交 → 记忆消费记录。模块可以实现阶段，不能私自跳过最终检查。

工具循环可读授权地图、查已知情报、提出协议、请求派遣等。每次有副作用的工具调用均提交标准 command；不同时允许“工具已派遣”和 turn 结束后再次执行同一 action。副作用使用稳定 operationId 关联 commandId，终态只返回引用。

ambient 世界读取、既有观察、会话和记忆绑定 [InputFrontier](contracts.md)。本 turn 自身合法工具的 receipt 可以在 frontier 后作为有界因果追加，用 toolCallId/operationId/acceptedEventIds 绑定；不能借此刷新全世界或回填冻结 memory revision。主动侦察产生的新见闻进入后续观察/turn。

对话流式 token 仅为研究预览；玩家只接收通过权限与格式校验、已持久化的完整话语。若前端展示正在输入，展示状态即可，不提前泄露尚未裁决的内容。

## 2. 世界事务、投递与恢复

### 单次提交的事务边界

同一个数据库事务完成 command receipt、aggregate state/version、领域事件、outbox 和由事件直接确定的 timer jobs。成功后才返回 accepted。拒绝也写 receipt 和拒绝原因，但不生成成功世界事实。

按 (worldId, branchId, principalId, commandId) 去重，绑定 payloadHash。相同键且相同请求返回原 receipt；相同键不同 payload 返回 idempotency-conflict。异步 action 的 commandStatus=accepted 不等于 taskStatus=completed，客户端分别展示。

outbox 至少一次投递，consumer 以 (consumerId, branchId, eventId) 建立 inbox；处理结果、投影/记忆变化和水位在其自己的事务内原子提交。进程在提交后确认前崩溃会重投，但不会重复记忆、重复扣物资或重复强化。这里不宣称网络 exactly-once。

逻辑 timer 也存 jobId、dueTick、状态和幂等键。重启根据持久 tick 与任务状态恢复，不使用进程内 setTimeout 作为权威计时。LLM 任务通过短租约认领；过期可重试，旧 attempt 的结果不能再次提交。

### 世界与记忆的最终一致性

世界事件先提交，记忆随后投影，二者不要求跨外部模型事务。每个 Agent 的感知投递维护 observationSeq 及对应 branch event frontier；未授权事件也推进内部扫描 frontier，但不会作为空白秘密事件发送给模型。

memory 维护 durableThroughSeq 与 derivedThroughSeq：前者表示即时经历/基础索引已完成，后者表示按策略到期应完成的反思/压缩/整理已完成。两者使用对应 branch 的 worldSeq，并映射 observationSeq；profile 声明本次 turn 的 required readiness，M0 也记录已消费游标，不能没有因果边界。

这两个世界序号只是进度摘要，checkpoint 还须保存其覆盖的 observationSeq、perceptionRevision 和知识授权版本；readiness 校验完整 InputFrontier。同一个 worldSeq 下迟到的观察不能因世界水位未变就被误认成已摄入或已整理。

turn 冻结 inputFrontier 后等待必要水位；超时在正式实验中失败或标为 invalid，在线可选择已声明 fallback 并显式标记。不能读到一半旧记忆却把该样本记录为完整方案。检索必须绑定该 frontier 对应的不可变 memory revision，且所有来源 observation 的获知水位均不晚于 frontier；当前表过滤 createdAtFrontier 不足以恢复已覆盖/遗忘的旧版本。无法取得对应 revision 就返回 not-ready/invalid，不能混用未来摘要。

同一 Agent 的短状态转移与 memory 发布通过身份 actor 队列和 revision CAS 串行化。水位等待、模型调用和后台整理计算必须在 actor 锁外，避免 turn 等待被自身队列阻塞的 memory job。发布时验证 baseRevision/frontier；过期结果重算或拒绝，不能覆盖新记录。

模型决策提交时再次核对关键 aggregateVersion、controllerEpoch、turnLeaseEpoch 与 profileHash。读取后无关的世界变动不必让所有决策失败；runtime/工具网关记录真实版本读集，command handler 补齐规则要求的必需依赖并校验，不能依赖 LLM 自报读集。版本冲突可重新计划，最多按预算重试，不能未经检查沿用已失效的授权。

## 3. 事实、信念与信息安全

所有 Agent 可读取同版 lore。动态世界先经过内核 ACL/可见投影，再交给 perception 模块；模块只可在此上减弱、延迟、模糊或生成有明确来源的观测，不能扩大权限。scope 字符串和依赖注入本身不构成安全隔离。

记忆分 verified-event、reported-claim、inference；“玩家说根庭袭击了运输队”首先是 reported-claim。服务端能核对世界事件，不意味着 NPC 已经获得核对证据。推断必须指向合法 observations，保持置信与有效时间；反思不能晋升成世界事实。

记忆派生的保密标签取来源权限的保守交集。正式共享必须通过 InformationShared 和授权规则，不能把某派系 memory table 当全局可读缓存。共享编年史只包含已发布事实。

已知秘密与可公开内容必须分开处理：policy 可以在授权范围内参考秘密选择结构化行动，但只输出受约束的对白意图枚举和合法公开证据引用，不把自由文本理由直接传给对白模型。对外台词由宿主另起仅含目标受众合法素材、已裁决 receipt 的生成调用，禁止复用携密会话或缓存前缀；也可由安全模板表达。两阶段均计入同一 turn 的预算与 trace，不增加新 Agent。混合公私素材的摘要不能直接公开；最终 gate 复核引用与传播权限。仅靠模型写 sourceRefs 不能证明不会泄密。

玩家文本、剧情文本、memory 文本与工具结果均作为数据块标注来源，不具有提升系统权限的能力。首版只加载可信内置模块包，不提供任意上传/执行插件；以后支持第三方需要独立进程/容器隔离的另行设计，manifest 不能替代沙箱。

## 4. 存储与快照

下表是逻辑数据集合，可共享一个 SQLite 文件，由 storage port 隔离；模块不各自随意创建世界数据库。

| 集合 | 关键内容 |
|---|---|
| worlds / branches / runs | lore、规则、profile、控制模式、父快照、运行清单及状态 |
| domain_events / aggregate_state / command_receipts | branch 内有序事实、当前权威状态、幂等响应 |
| outbox / consumer_inbox / jobs | 投递、消费与任务恢复，包含重试/租约/fencing |
| observations / knowledge_grants | Agent 所知、获知时点、传播权限与来源 |
| memory_records / memory_revisions / memory_watermarks | 分主体/分策略的记忆、派生版本、就绪水位 |
| turn_runs / model_attempts / tool_calls / context_artifacts | 每阶段输入输出、attempt、最终有效请求、原始工具结果与模型视图 |
| controller_leases / snapshots / experiment_results | 真人接管、恢复点、评估协议和评分依据 |

唯一键与索引必须包含必要 scope；跨分支检索被 port 拒绝。每个实验 run（包括开环）分配独占 branchId；branch 激活期间绑定一个 profileHash，禁止两个 run 并发复用。在线世界更新配置也创建后继分支/run，在维护边界切换在线别名，保留旧分支。embedding 等可选索引属于派生数据，可从已授权记忆重建；索引构建版本和 ready 水位纳入实验记录。

快照在 branch quiescing 后生成：暂停接收变更命令，fence/cancel 在途 turn 并排空短提交，冻结输入 frontier；等待所选策略的必要 memory 水位后冻结 maintenance 发布，记录未完成动作、timer、控制权与状态版本。世界、memory、job 和 manifest 必须来自同一逻辑恢复点。仅复制世界表不叫可复现实验快照。

事件、原始模型记录与原始工具结果按 run 保留；memory 遗忘只影响 Agent 可读层。细节淘汰可按显式策略保留概括；来源撤回/彻底遗忘则沿 provenance 级联更新，不能让被撤回的秘密继续通过旧摘要可读。研究员可从审计库重建，不代表 NPC 有权访问审计库。

首版 SQLite 使用事务和 WAL、单写队列、busy 超时及备份恢复流程；不在网络共享盘运行。备份使用一致性快照，不能在写入中简单复制单个数据库文件。部署容量不足时先测写延迟与队列积压，再换 storage adapter。


## 5. 单玩家暂停与配置切换

暂停递增调度/turn fencing 代次，停止逻辑 tick 和新增自主 turn；已接受世界命令排空短提交，已接受延时动作保留为待恢复任务。水位追齐和快照只处理冻结 frontier 以内的工作，不产生未来剧情。模型结果取消后仍须在提交处校验 epoch。

离线默认暂停；单步推进用于调试与实验。所有正式/实验分支共享部署的 20 身份激活配额，满员时先停正式运行再逐分支实验。配置改变创建新 run 和独占后继 branch；不在原分支中途覆盖策略、挂载或工具权限。

## 6. 关键故障验收

提交后确认前崩溃不重复世界写入；outbox 重投不重复记忆；timer 恢复不重复完成任务；旧 controller/turn lease 不生效；不可变 revision 无法取得时明确 not-ready；水位等待不占 actor 锁；快照恢复后 world、memory、jobs 与 manifest hash 对得上。
