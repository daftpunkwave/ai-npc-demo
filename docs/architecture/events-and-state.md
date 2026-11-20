# 事件、状态、一致性与恢复

> 世界提交、时钟任务、scope、水位、快照与恢复的语义由本文维护。Agent 运行流程的细节见 [runtime](../agent/runtime.md)。

## 1. 一次交互的完整处理流程

~~~mermaid
sequenceDiagram
  participant P as 玩家
  participant W as 世界服务
  participant D as 事件与任务库
  participant G as 感知网关
  participant M as 记忆模块
  participant A as Agent Runtime
  participant L as 模型适配器
  P->>W: 提交交涉 commandId / expectedVersions
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

Agent 自主触发的来源包括发给它的事件、当前 memory 提供的主观计划或提醒任务、有限的巡检时钟，以及玩家的直接交互；不存在每个 tick 让全部 Agent 无差别思考的轮询。正式合同到期任务只做规则结算并发布真实结果，不能向 M0 隐式灌入全部条款，形成提前提醒。调度器按优先级、冷却、每身份互斥和预算合并触发，同时保留原始 trigger IDs；固定唤醒源的实验必须声明这一控制变量。

一次 turn 的固定阶段见 [runtime](../agent/runtime.md) 第 5 节：冻结输入、感知投影、等待记忆、检索、组上下文、视图处理（含必要压缩）、决策与工具有界循环、工具与命令、安全对白、结算。模块可以实现阶段，不能私自跳过最终检查。上面时序图中的感知网关与记忆摄入发生在 turn 触发之前；turn 内阶段 2 只把已冻结的授权投影解析成本 turn 的 AgentObservation，不重新决定事件对谁可见。

工具循环里可以读授权地图、查已知情报、提出协议、请求派遣等。每次有副作用的工具调用都提交标准 command；不能既让工具显示“已派遣”，又在 turn 结束后再执行同一 action。副作用用稳定的 operationId 关联 commandId，终态只返回引用。

ambient 世界读取、既有观察、会话和记忆都绑定 [InputFrontier](contracts.md)。本 turn 自身合法工具的 receipt 可以在 frontier 之后作为有界因果追加，用 toolCallId/operationId/acceptedEventIds 绑定；但不能借这种方式刷新整个世界，或回填已经冻结的 memory revision。主动侦察产生的新见闻进入后续观察和 turn。

对话流式 token 只用于研究预览；玩家收到的必须是通过权限与格式校验并已持久化的完整话语。前端展示正在输入时，只展示状态即可，不提前泄露尚未裁决的内容。

## 2. 世界事务、投递与恢复

### 单次提交的事务边界

同一个数据库事务完成 command receipt、aggregate state/version、领域事件、outbox 和由事件直接确定的 timer jobs。成功之后才返回 accepted。拒绝也写 receipt 和拒绝原因，但不生成成功世界事实。

按 (worldId, branchId, principalId, commandId) 去重，并绑定 payloadHash。键和请求都相同的返回原 receipt；键相同但 payload 不同的返回 idempotency-conflict。异步 action 的 commandStatus=accepted 不等于 taskStatus=completed，客户端要分别展示。

outbox 按至少一次投递，consumer 以 (consumerId, branchId, eventId) 建立 inbox；处理结果、投影与记忆变化、水位在各自的事务内原子提交。进程在提交后、确认前崩溃会触发重投，但不会重复记忆、重复扣物资或重复强化。这里不承诺网络上的 exactly-once。

逻辑 timer 同样保存 jobId、dueTick、状态和幂等键。重启时依据持久化的 tick 与任务状态恢复，不把进程内 setTimeout 当作权威计时。LLM 任务通过短租约认领；租约过期可以重试，旧 attempt 的结果不能再次提交。

### 世界与记忆的最终一致性

世界事件先提交，记忆随后投影，两者不要求跨外部模型事务。每个 Agent 的感知投递维护 observationSeq 和对应的 branch event frontier；未授权事件也会推进内部扫描 frontier，但不会作为一条空白的秘密事件发给模型。

memory 维护 durableThroughSeq 与 derivedThroughSeq：前者表示即时经历和基础索引已经完成，后者表示按策略到期应做的反思、压缩、整理已经完成。两者使用对应 branch 的 worldSeq，并映射到 observationSeq；profile 声明本次 turn 的 required readiness，M0 也要记录已消费游标，不能没有因果边界。

这两个世界序号只是进度摘要，checkpoint 还必须保存它们覆盖的 observationSeq、perceptionRevision 和知识授权版本；readiness 校验的是完整 InputFrontier。同一个 worldSeq 下迟到的观察，不能因为世界水位没变就被当成已摄入或已整理。

turn 冻结 inputFrontier 后等待必要水位；超时在正式实验中算失败或标为 invalid，在线可以选择已声明的 fallback 并显式标记。不能只读到一半旧记忆，却把该样本记为完整方案。检索必须绑定该 frontier 对应的不可变 memory revision，并且所有来源 observation 的获知水位都不晚于 frontier；只靠当前表按 createdAtFrontier 过滤，不足以恢复已被覆盖或遗忘的旧版本。取不到对应 revision 就返回 not-ready/invalid，不能混用未来的摘要。

同一 Agent 的短状态转移和 memory 发布由身份 actor 队列和 revision CAS 串行化。水位等待、模型调用和后台整理计算必须放在 actor 锁外，避免 turn 等待一个被自身队列堵住的 memory job。发布时验证 baseRevision/frontier；过期结果要么重算要么拒绝，不能覆盖新记录。

模型决策提交时再次核对关键的 aggregateVersion、controllerEpoch、turnLeaseEpoch 与 profileHash。读取之后无关的世界变动不必让所有决策失败；runtime 和工具网关记录真实的版本读集，command handler 补齐规则要求的必需依赖并校验，不能依赖 LLM 自报的读集。版本冲突可以重新计划，重试次数按预算封顶，不能未经检查沿用已经失效的授权。

## 3. 事实、信念与信息安全

所有 Agent 读取同一版 lore。动态世界先经过内核 ACL 和可见投影，再交给 perception 模块；模块只能在此基础上减弱、延迟、模糊，或生成有明确来源的观测，不能扩大权限。scope 字符串和依赖注入本身都不构成安全隔离。

记忆分 verified-event、reported-claim、inference：“玩家说根庭袭击了运输队”首先是 reported-claim。服务端能核对世界事件，不等于 NPC 已经拿到核对证据。推断必须指向合法的 observations，并保留置信与有效时间；反思不能晋升成世界事实。

记忆派生的保密标签取来源权限的保守交集。正式共享必须通过 InformationShared 和授权规则，不能把某派系的 memory table 当作全局可读缓存。共享编年史只包含已发布事实。

已知秘密和可公开内容必须分开处理。policy 可以在授权范围内参考秘密来选择结构化行动，但只输出受约束的对白意图枚举和合法的公开证据引用，不把自由文本理由直接传给对白模型。对外台词由宿主另起一次生成调用，只含目标受众的合法素材和已裁决的 receipt，禁止复用携密会话或缓存前缀，安全模板也可以承担这一步。两个阶段都计入同一 turn 的预算与 trace，不增加新的 Agent。混合了公私素材的摘要不能直接公开，最终 gate 还要复核引用和传播权限。只靠模型写 sourceRefs 不能证明不会泄密。

玩家文本、剧情文本、memory 文本和工具结果都作为标注了来源的数据块处理，没有提升系统权限的能力。首版只加载可信的内置模块包，不提供任意上传或执行插件；以后要支持第三方，需要独立进程或容器隔离的另行设计，manifest 不能替代沙箱。

## 4. 存储与快照

下表是逻辑数据集合，可以共享一个 SQLite 文件，由 storage port 隔离；模块不能各自随意创建世界数据库。物理表结构、索引与分支复制算法见 [存储](storage.md)。

| 集合 | 关键内容 |
|---|---|
| worlds / branches / runs | lore、规则、profile、控制模式、父快照、运行清单及状态 |
| domain_events / aggregate_state / command_receipts | branch 内有序事实、当前权威状态、幂等响应 |
| outbox / consumer_inbox / jobs | 投递、消费与任务恢复，包含重试/租约/fencing |
| observations / knowledge_grants | Agent 所知、获知时点、传播权限与来源 |
| memory_records / memory_revisions / memory_watermarks | 分主体/分策略的记忆、派生版本、就绪水位 |
| turn_runs / model_attempts / tool_calls / context_artifacts | 每阶段输入输出、attempt、最终有效请求、原始工具结果与模型视图 |
| controller_leases / snapshots / experiment_results | 真人接管、恢复点、评估协议和评分依据 |

唯一键与索引必须包含必要的 scope；跨分支检索会被 port 拒绝。每个实验 run（包括开环）分配独占的 branchId；branch 激活期间绑定一个 profileHash，禁止两个 run 并发复用。在线世界更新配置时也创建后继分支和 run，在维护边界切换在线别名，并保留旧分支。embedding 这类可选索引属于派生数据，可以从已授权记忆重建；索引构建版本和 ready 水位要纳入实验记录。

快照在 branch 静默（quiescing）之后生成：暂停接收变更命令，fence 或 cancel 在途 turn 并排空短提交，冻结输入 frontier；等所选策略的必要 memory 水位到齐后冻结 maintenance 发布，记录未完成动作、timer、控制权与状态版本。世界、memory、job 和 manifest 必须来自同一个逻辑恢复点。只复制世界表不算可复现的实验快照；首版的实现方式是把静默后的分支整体复制成一个冻结分支（[存储](storage.md) 第 3 节）。

事件、原始模型记录和原始工具结果按 run 保留；memory 遗忘只影响 Agent 可读的那一层。细节淘汰可以按显式策略保留概括；来源撤回或彻底遗忘则要沿 provenance 级联更新，不能让被撤回的秘密继续通过旧摘要读到。研究员可以从审计库重建，不代表 NPC 有权访问审计库。

首版 SQLite 使用事务和 WAL、单写队列、busy 超时，以及备份恢复流程；不在网络共享盘上运行。备份使用一致性快照，不能在写入过程中直接复制单个数据库文件。部署容量不足时，先测写延迟和队列积压，再更换 storage adapter。


## 5. 单玩家暂停与配置切换

暂停会递增调度和 turn 的 fencing 代次，停止逻辑 tick 与新增自主 turn；已接受的世界命令排空短提交，已接受的延时动作保留为待恢复任务。水位追齐和快照只处理冻结 frontier 以内的工作，不产生未来剧情。模型结果被取消后，提交处仍要校验 epoch。

离线默认暂停，单步推进用于调试和实验。所有正式与实验分支共享部署的 15 个身份激活配额，满员时先停正式运行，再逐分支做实验。配置改变会创建新 run 和独占的后继 branch；不在原分支中途覆盖策略、挂载或工具权限。

## 6. 关键故障验收

提交后、确认前崩溃不重复世界写入；outbox 重投不重复记忆；timer 恢复不重复完成任务；旧 controller 和 turn lease 不生效；不可变 revision 无法取得时明确 not-ready；水位等待不占 actor 锁；快照恢复后 world、memory、jobs 与 manifest hash 对得上。
