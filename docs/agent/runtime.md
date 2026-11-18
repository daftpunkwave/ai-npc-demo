# Agent Runtime：事件到行为的宿主管线

> 状态：待实现规范。TypeScript 全栈、Node 模块化单体、SQLite 单写者；状态、接口和任务名称都是目标契约。

## 1. 运行边界

首版是单玩家、单权威世界；玩家从五个人类派系中选择立场。世界观统一，动态知识按主体授权，选择派系不会复制世界真值或 NPC 人格。

完整 roster 为 5 个人类派系战略 Agent、3 个非人类势力战略 Agent、12 个角色 Agent，共 20 个。在线世界与实验分支的活跃身份合计不得超过 20；20 个身份不等于同时发出 20 个模型请求。

完整 20 个 Agent 实验需要暂停在线运行，再逐分支执行。休眠快照不占活跃名额，恢复前原子预留名额；policy、speech 和记忆整理属于同一身份的任务，不额外创造 Agent。

Runtime 负责推进统一管线、预算、租约和证据；模块（插件）实现各阶段策略。世界服务独立裁决行动，renderer 只显示结果，模型响应不能直接改 SQLite 世界状态。感知、记忆、上下文、压缩、工具视图与决策都通过与其他职能相同的 ModuleDefinition/catalog 注册，实例作用域为 agent；调度作用在整次 run 上，实例作用域为 run。runtime 本身是宿主固定管线，不在模块目录中。

配套边界见 [架构总览](../architecture/overview.md)、[模块责任](../architecture/modules.md) 与 [角色 roster](../game/characters.md)。

## 2. 身份与因果标识

| 标识 | 用途与限制 |
|---|---|
| worldId / branchId / agentId | 所有输入、记忆、工具与任务的 scope；每个 run 独占 branchId |
| worldSeq / worldTick | 前者仅在 branch 内排序，后者用于剧情、任务与记忆衰减 |
| turnId / triggerIds | 一次决策与原始唤醒原因；合并唤醒仍保留全部 triggerIds |
| causationIds / correlationId | 多因多果关联与业务链定位，不能替代权限或排序 |
| controllerEpoch | 该身份当前控制权代次，接管和归还时递增 |
| turnLeaseEpoch | 某 turn 被 worker 认领的 fencing 代次，重领时递增 |
| profileHash / inputFrontier | 本次解析后的组合与冻结的各来源输入边界 |
| operationId / commandId | 一个副作用操作与权威命令的稳定关联，跨重试保留 |

agentId 从服务端激活身份推导，不接受模型自行扮演另一个 Agent。运行日志和观测 span 使用独立记录类型，不冒充世界领域事件。

phase/purpose 字段统一使用 decision 与 speech；policy 仅表示决策策略。inputFrontier 冻结本 turn 的既有世界、观察与 memory；世界 query 只读 F 的授权 read view，不在工具循环中推进 F。

InputFrontier 只使用 [公共契约](../architecture/contracts.md) 的统一类型。preparing 先锁定来源边界，等必要记忆水位后绑定相应 memoryRevision 并封存完整 frontier；同一 worldSeq 下稍后送达的观察仍受 observationSeq/perceptionRevision 限制，不能混入本 turn。

## 3. 唤醒与调度

唤醒来自玩家交互、已授权事件、承诺/任务到期、有限巡检以及角色间已提交消息。每帧渲染、每个逻辑 tick 都不触发全员推理。

调度分两层：scheduling 插件返回优先级、合并和唤醒建议；宿主执行名额、同身份互斥、冷却、公平性与预算硬限制。全池请求排队另见 [模型池](model-pool.md)。

正式合同的到期 job 只作规则结算并发布真实结果；主动提醒、提前履约的唤醒须来自本组启用的 prospective memory。公共调度器不能替 M0 查询全量合同并把条款塞进 trigger；若实验固定相同触发，须显式记录这一控制变量，不能把效果全归因于 memory。

- 持久化 trigger 后再确认消费；同一 trigger 重投不能产生两个独立 turn。
- 同一身份只允许一个活动决策 turn，后续消息进入有界 inbox，不修改已冻结输入。
- 合并保留玩家消息顺序与来源，不把不同私密受众合为同一个公开回复上下文。
- 到期事件使用 dueTick；限流、超时、队列等待使用单调现实时间，两者不可混用。
- 紧急交互可优先，但设置最长等待与最低服务份额，防止整理任务或低优先角色长期饥饿。
- inbox 达上限时显示忙碌、合并可合并通知或拒绝新请求；不得静默丢弃已接受的玩家命令。

SQLite actor 队列只串行短状态转移与发布。模型调用、水位等待、工具网络等待和整理计算均在锁外，避免等待同队列任务造成 deadlock。

## 4. 持久状态机

| 状态 | 进入条件 | 下一步 |
|---|---|---|
| queued | trigger 已持久化，身份可运行 | 认领租约并进入 preparing |
| preparing | 已冻结输入与 profile，准备感知/记忆 | 就绪后进入 deciding，缺水位进入 waiting |
| waiting | 等待明确依赖或模型池名额 | 依赖满足后恢复记录的阶段；到期失败 |
| deciding | 决策请求或工具循环进行中 | 到 executing，或直接进入 speaking/settling |
| executing | 有候选命令等待权威 receipt | 记录裁决后继续 deciding 或 speaking |
| speaking | 仅以目标受众合法素材生成对白 | 校验提交后回到所属工具阶段，或进入 settling |
| settling | 记录使用证据、终态与剩余任务 | completed / failed / cancelled / budget-exhausted |

状态转移带 expectedState、turnLeaseEpoch 与 revision CAS。阶段完成写入 artifact 引用和游标后才推进；进程内 Promise 不是恢复依据。

每个模型 step 通过 CAS 选定唯一有效的 settled attempt；被重试、取消或替代的 attempt 即使晚到完整响应，也只能归档。工具调用只能来自该有效 attempt，不能分别消费两次响应。

world action 可以仍为 pending，而对应 turn 已结束；任务到达或失败通过新事件触发后续 turn，不能让一次 LLM 请求占着租约等游戏任务跑完。

## 5. 一次 turn 的固定阶段

| 阶段 | 输入与产物 | 宿主关口 |
|---|---|---|
| 1 冻结 | trigger、时钟、控制权、profile、inputFrontier | 身份/分支有效，激活名额和租约可用 |
| 2 感知 | 授权投影解析为 AgentObservation | ACL 先于 perception，记录真实获知时间 |
| 3 等待记忆 | 必需水位到达后绑定不可变 memory revision | 不读未来；不把过期索引当就绪 |
| 4 检索 | 话题、对象、预算产出带来源记忆包 | scope、来源和受众校验 |
| 5 组上下文 | 身份、当前观察、记忆、合法窗口组装为 segments | 显式顺序与版本，不从旁路补历史 |
| 6 视图处理 | 工具结果、分段生成 tool-view/压缩视图 | 保留原件、工具配对与传播限制 |
| 7 决策循环 | 最终归档请求转为工具调用或候选决策 | 请求窗口、输出 schema、模型能力与调用预算 |
| 8 工具/命令 | 提案得到 tool result / receipt | 同一授权和命令 pipeline，副作用幂等 |
| 9 安全对白 | 可披露素材、意图、receipt 生成对白候选 | 独立调用、受众校验、持久化后才展示 |
| 10 结算 | 实际入模引用、终态、消耗写入使用记录 | 不把候选召回当实际利用，不抹除失败 |

阶段 7 与 8 构成有界循环：决策产生工具调用，工具结果回到下一轮决策；候选决策可来自任一轮，但只有最终有效 attempt 能提交命令。阶段 6 的 tool-view/压缩处理的是已归档的工具结果或上下文区间，不是新的一轮模型决策。其余阶段顺序固定，不能被模块重排。

这些阶段由同一 runtime 调度；decision 插件不能另起私有 loop、直接调用供应商 SDK 或跳过最终 guard。transform 可改候选，observe 只读，最终权限和预算裁决固定执行。

## 6. 记忆、水位与冻结视图

四个起始实现为 memory.none、memory.ledger、memory.stream-reflection、memory.layered-hybrid。更换实现通过新 branch/run 的 profile，不在活动 turn 内替换。

durableThroughSeq 表示即时摄入就绪，derivedThroughSeq 表示该策略在当前截止点应完成的整理就绪；两者映射 branch 的 worldSeq 与该身份 observationSeq。内部扫描到未授权事件可推进扫描游标，但不向模型暴露秘密空位。

turn 冻结 inputFrontier 后，等待 profile 要求的水位并绑定对应不可变 revision。当前表即使已经推进到更晚水位，也不能直接过滤后作为历史版本；摘要全部来源都必须位于冻结边界内。

无法取得一致 revision 时返回 not-ready；正式实验失败或 invalid。在线 fallback 必须提前声明并留痕，不得无声切到 none。

后台维护在锁外计算，发布用 baseRevision、frontier、profileHash 做 CAS。过期结果拒绝或重算；none 仍消费游标，明确没有长期存储与派生任务。

记忆记录、主观承诺和关系印象不等于世界合同与规则授权。详见 [记忆](memory.md)、[感知](perception.md) 与 [上下文](context.md)。

## 7. 决策与安全对白分离

policy 是决策策略的概念，模型挂载 purpose 字段使用 decision。decision 请求可读该 Agent 合法持有的秘密，返回 schema 约束的行动/认知候选、证据引用和对白意图枚举。

decision 的自由文本理由、携密历史、原始隐藏素材不能直接转交 speech。宿主从目标受众可接收的来源重新组装 speech context，并加入可披露的裁决 receipt。

speech 使用 purpose=speech 的独立 model port 调用，不复用携密供应商会话；也可由已版本化的安全模板表达。两次调用属于同一 Agent、同一 turn，分别计费和追踪。

speech 没有世界命令工具；提出新行动必须回到决策与规则阶段。生成对白不能把 rejected 说成执行成功，不能把 accepted 的异步任务说成 completed。

message.send/information.share 也不能绕过此边界：decision 只提发送意图、受约束模板参数和可披露 sourceRefs。任何自由文本由宿主 safe speech/template 产生并校验，实际发送 handler 要求可信 approvedSpeechArtifactRef 或已校验披露引用，不能直接采纳 decision 的字符串。

最终校验受众、来源、格式和 receipt 语义，再提交 DialogueSubmitted。只有已持久化完整对白进入玩家端；流式 token 仅供有权限研究预览。

结构化行动仍可能透露立场或意图；规则按行动本身的可观察性生成受众投影。分离调用降低明文泄露路径，不宣称语义泄露已经为零。

## 8. 有界工具循环与副作用

每轮请求前重算实际 token 和剩余预算；maxModelCallsPerTurn、maxToolCallsPerTurn、maxTurnMs、最大重计划次数均为解析后有限正数。达到上限必须进入明确终态。

主动侦察是 command；任务完成产生的新世界观察进入后续 turn，不刷新当前 turn 的全局 read view。行动 write 仍按提交当下的 authority、动态权限与版本校验，可能与 F 时的预期冲突。

本 turn 合法副作用的 receipt 可以在 F 后作为有界因果追加提供给后续 decision/speech；记录 toolCallId、operationId 和 acceptedEventIds，仅追加操作结果，不回填冻结 memory revision 或顺便读取其他新世界信息。

模型给出工具调用后，宿主完成 schema、binding、动态授权与预算检查；工具实现和角色注册分离，见 [共享工具体系](tools.md)。

每个 command 工具由宿主先持久化 operationId 与 commandId，再提交世界 handler。一次业务操作只走一条执行路径；最终决策引用已有 receipt，不重复执行工具已经接受的动作。

超时可能表示结果未知。先按原 operationId 查询 receipt 或任务状态；必要时以相同 commandId 和 payload 重送，禁止为“重试”生成新业务操作。

重新计划确需改变动作时，先核对旧操作是否已接受；新意图生成新的 operationId，并显式处理既有任务。取消 turn 不自动撤销已接受任务。

每个已记录 tool call 都有同 callId 的结果。ToolResult.executionStatus 为 ok/error/unknown；ok 只表示网关得到确定合法响应，仍可能包含 commandStatus=rejected。receipt 的 commandStatus=accepted/rejected 不随任务推进改变；taskStatus=pending/running/completed/failed/cancelled 来自独立任务投影。恢复先补齐未答调用，缺配对历史不得再次发给模型。

## 9. 控制权、租约与提交竞态

human/agent 控制同一身份，接管不创建新记忆人格。接管和归还都通过权威控制服务递增 controllerEpoch，并停止旧控制器的新任务入口。

worker 认领、重领 turn 时取得新的 turnLeaseEpoch。仅取消信号不足以隔离晚到网络响应；每次短发布、记忆候选提交、世界命令和对白提交都验证 fencing。

提交还验证 branch 活跃状态、profileHash、主体授权与实际读集版本。读集由工具网关/runtime 记录，command handler 补齐规则依赖，不能信任 LLM 自报。

版本冲突可有界重计划；旧 attempt 的语音/对白不得在新控制器接管后突然发布。已接受的运输、协议等任务继续按规则运行，取消需要独立合法命令。

同一命令的重投返回原 receipt；去重键与 payloadHash 不一致报冲突。重启不代表获得新的下令资格，恢复前重新获取租约与控制权。

## 10. 预算与故障恢复

预算有 run、Agent、turn、维护 job 与模型池层级；小层不能放大上层额度。每次实际 attempt 计数，失败、重试、embedding、整理和压缩均进入成本账本。

发起模型前预留请求与输出额度，结算按实际 usage；usage 缺失记 unknown 并按配置保守占额，不按零计。排队等待占 turn deadline，另列供应商耗时。

| 故障点 | 恢复原则 |
|---|---|
| trigger 已存、turn 未认领 | inbox 去重后继续调度，不再创建另一份 trigger |
| 摄入提交后未 ack | consumer inbox 去重，记忆/水位不重复推进 |
| 模型断流或 provider 超时 | 保留部分响应，失败 attempt 不形成有效决策；有界重试 |
| 工具提交后断连 | 查询原 receipt，未知结果保持 unknown，不凭空认定失败 |
| 维护完成但 CAS 失败 | 丢弃发布资格并记录原因，不能覆盖较新 revision |
| 控制权/租约过期 | 旧结果只归档，不得执行命令或发布对白 |
| 证据归档失败 | 标记 evidence-incomplete；不能宣称可重现正式实验 |

审计重放使用已记录模型/工具产物；开环写工具只返回 proposal；闭环在独占分支真正裁决。三种模式复用同一管线与 guard，只在显式执行的 adapter 上有区别。

快照前先静默（quiesce）：暂停新命令、fence 在途 turn、排空短提交、冻结输入、等待必要水位、冻结维护发布。恢复点包含未完成操作与任务，不仅复制世界表。

运行与恢复细则见 [事件与状态](../architecture/events-and-state.md)、[运营控制](../platform/operations.md) 和 [评估协议](../platform/evaluation.md)。

## 11. 实施与验收

代码归属为 agent-runtime 的阶段协调器、scheduler/job repository 与 contracts；具体算法在插件，具体网络和 SQLite 操作在 adapter。目录与装配见 [代码结构](../architecture/code-structure.md) 和 [组合配置](../architecture/composition.md)。

- 用同一输入跑 none/ledger 等实现，核对实际入模差异，而非仅检查配置名称。
- 在等待水位时并发推进摄入，确认 actor 没有持锁等待自身任务。
- 在 command commit 与 ack 间故障重启，确认资源只扣一次、receipt 可恢复。
- 在 decision/speech 请求中接管，确认旧 epoch 不能下令或发布对白。
- 冻结 F 后引入 F+1 的秘密和摘要，确认本 turn 只能读取绑定 revision。
- 对模型循环、工具循环、inbox、维护任务和全池队列验证有界及公平性。

每条验收保留输入、状态迁移、artifact、receipt 与失败原因，入口见 [可观测性](../platform/observability.md)。

## 12. 参考边界

借鉴 deepseek-harness 的 [运行与事件分域](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/architecture.md) 和 [可重建 session log](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/session/README.md)。世界事务、NPC 私有知识、双阶段对白和 20 个身份调度是本平台设计，不是对参考仓库既有游戏能力的描述。

插件生命周期、最终 guard 和可支持实验能力统一遵循 [插件规范](../architecture/plugins.md)；没有完成实现与运行验证前，不把本文状态机或故障行为写成已上线能力。
