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

## 13. 首版实现规格

### 13.1 进程内的 worker

一个服务端进程里，以下循环都运行在 Node 主线程上（I/O 异步，计算同步），彼此只经数据库与内存通知协作：

| worker | 触发 | 做什么 |
|---|---|---|
| 时钟 | running 时每 `secondsPerTick` 秒；step 请求 | 按 [规则](../game/rules.md) 第 1 节推进 tick、执行到期 job 与时钟步骤；每推进一个 tick 后通知调度器调用唤醒建议（13.2 节） |
| 感知消费者 | 新领域事件 | [感知](perception.md) 第 11 节；写观察与 trigger |
| 规则消费者 | 新领域事件 | 协议履约判定、剧情模块订阅等 |
| 记忆摄入 | 有新观察 | 对每个 Agent：读取 `observation_seq > consumed` 的观察，调用 `prepareIngest`，在 Agent 的 actor 事务中提交；提交后调用 `planMaintenance(trigger = "importance")`，返回任务时写入 `maintenance_runs` |
| 记忆整理 | `DayPassed` 被摄入后；有排队的整理任务 | `DayPassed` 被某 Agent 摄入后调用 `planMaintenance(trigger = "day-passed")` 并排队；认领排队任务（租约 2 分钟）→ `runMaintenance`（可调用模型，`deadlineMs` 为认领时刻 + 120000）→ CAS 提交（13.5 节）。分支激活时，对 `derived_through_tick` 落后于最近一次 `DayPassed` 且没有排队任务的 Agent 重新排队 |
| 调度器 | 每 250 ms，以及新 trigger 通知 | 13.2 节 |
| turn 执行 | 调度器创建的 turn | 13.3 节 |
| 投影推送 | 新领域事件、turn 状态变化 | 更新玩家投影与控制台频道并经 WS 推送 |

### 13.2 调度器（`agent.scheduling.fair`）

trigger 来源与优先级：

| kind | 来源 | 优先级 | 冷却 |
|---|---|---|---|
| `player-dialogue` | 玩家对该 Agent 说话 | 100 | 不受冷却限制 |
| `debug` / `probe` | 控制台调试注入 / 评估探针（`ProbeAsked`） | 100 | 不受限制 |
| `alert` | 自己的任务失败、自己受伤、相关危机 | 90 | 受限 |
| `task-invite` | 收到任务邀请 | 80 | 受限 |
| `agreement-proposal` | 收到提案或还价 | 70 | 受限 |
| `message` / `scenario` | 定向消息与证据 / 剧情卡唤醒（`AgentsSummoned`） | 60 | 受限 |
| `prospective` | 记忆模块的唤醒建议（[记忆](memory.md) 第 11.4 节） | 50 | 受限 |
| `patrol` | 战略 Agent 每天 8 时一次巡检 | 10 | 受限 |

```yaml
# scene profile, run-scoped
scheduling:
  module: agent.scheduling.fair
  config:
    maxConcurrentTurns: 4
    mergeLimit: 5          # max triggers merged into one turn
    cooldownTicks: 1       # min ticks between autonomous turns of one agent
    agingPerTick: 5        # priority bonus per tick waited
    agingCap: 40
    patrolHour: 8          # strategic agents only
```

唤醒建议：时钟每推进到一个新 tick T，调度器对每个已激活、由 agent 控制的 Agent 调用一次 `memory.proposeWakeups({ worldTick: T })`；对返回的每条 `atTick ≤ T` 的建议，以 `dedupeKey` 写入 `triggers.dedupe_key` 创建 `prospective` trigger（已存在则跳过，所以每条建议只触发一次）。巡检 trigger 的 `dedupeKey` 为 `patrol:<agentId>:<day>`。

每次调度：

1. 候选 = 有未消费 trigger、没有进行中 turn、处于 agent 控制、名册中已激活的 Agent；时钟 paused 时只处理 `debug` 与 `probe`。
2. 候选得分 = 未消费 trigger 中的最高优先级 + min(`agingCap`, 等待 tick 数 × `agingPerTick`)；同分按最早 trigger 的 `created_tick`，再按 agentId 排序。冷却期内只有不受冷却限制的 trigger 能参与。
3. 按得分依次创建 turn（`agent_turn_index` = 该 Agent 在本分支已有的 turn 数 + 1），直到运行中的 turn 数达到 `maxConcurrentTurns`。创建 turn 时，把该 Agent 最多 `mergeLimit` 条未消费 trigger 按创建顺序并入（写 `consumed_by_turn_id`），其余留给下一轮。
4. 每个 Agent 同一时刻最多一个活动 turn；turn 运行中新到的 trigger 只排队，不改变已冻结的输入。
5. turn 以 `cancelled` 结束（暂停、静默、接管、租约过期导致）时，它并入的 trigger 被释放（`consumed_by_turn_id` 置空），之后重新调度；以 `completed`、`failed`、`budget-exhausted` 结束时 trigger 视为已消费。

`stepping` 模式下，每个 tick 按规则第 1 节注入该 tick 的脚本命令，然后排空本 tick：规则与感知消费者追平最新 worldSeq、记忆摄入追平已投递观察、没有到期 job、没有当前可调度的 trigger、没有排队或运行中的 turn、没有 `due_tick ≤ 当前 tick` 的排队或执行中的整理任务。消费者或 turn 产生新事件后重新检查这些条件；未来投递与冷却中的 trigger 留到后续 tick，不阻塞本 tick。达到收敛点才推进下一 tick；目标 tick 收敛后回到 paused。超出运行预算时明确失败并暂停，不把未收敛当作完成。

### 13.3 turn 主循环

```ts
async function runTurn(turnId: string): Promise<void> {
  // 1. claim: in one tx -> check branch active, agent active and agent-controlled, turnLeaseEpoch += 1, status = preparing
  // 2. freeze (13.4): wait for memory ingest/readiness outside any tx, then record InputFrontier + memoryRevision in one tx
  // 3. observations of this turn = trigger observations + observations in (previous frontier, this frontier]
  // 4. bundle = memory.retrieve(query built from triggers, memory.md §11.9)          (sync)
  // 5. artifact = context.build(decision phase); compression if needed                 (sync, before the first request only)
  // 6. decision loop (agent.decision.model): for round = 1..maxDecisionRounds
  //      request -> pool.call(decision) -> handle the round (rules below) -> append assistant + tool results
  //      stop when decision_submit is valid; nudge once if the model ends with plain text (prompts.md §2.3)
  //    agent.decision.deterministic replaces steps 5-6 with §13.7 and never calls a model
  // 7. speech: if dialogueIntent.kind != "none" -> speech request -> validate -> template fallback -> speech.commit
  //    (agent.decision.deterministic always uses the safe templates of prompts.md §5)
  //    probe turns write the validated speech to probe_results instead of speech.commit
  // 8. settle: in the agent's actor tx -> memory.recordUse plan (CAS with rebase, 13.5), turn completed, effective record
  // every stage writes a span; every commit re-checks controllerEpoch, turnLeaseEpoch and branch status
}
```

探针 turn 仅提供只读查询工具与 `decision.submit`；工具网关同样拒绝任何写工具，不能通过模型输出修改沙盒世界。仅 active sandbox 内由 `system:world` 提交的 `probe.ask` 豁免暂停检查；其他命令不豁免。探针只调度本次 `ProbeAsked` 的 trigger，不消费复制来的历史 trigger。

一轮 decision 响应的处理规则：

1. `finishReason` 为 `length` 或 `refusal`：不执行其中任何工具调用，turn 以 `invalid-decision` 结束（不重试本轮）。
2. 按模型返回的顺序处理工具调用：先执行所有非 `decision_submit` 的调用，其中只有前 `maxToolCallsPerRound` 个真正执行，其余返回错误结果（文本取 `decision.budgetStop`）；达到 `maxToolCallsPerTurn` 或 [压缩与工具视图](compression-and-tool-view.md) 第 12.1 节的预算条件时同样返回该错误结果。
3. 然后处理 `decision_submit`（若有多个只认第一个，其余返回错误结果）：校验时，本轮刚执行的工具结果中出现的 ID 也算“出现在本次请求中”。校验通过则结束循环；不通过则返回 `invalid_decision` 结果，下一轮再给一次机会。
4. 每个工具调用都配一条结果消息（包括被拒绝的），保证调用与结果一一对应。

turn 的默认预算与失败策略（Agent profile，完整默认值见 [配置](../platform/configuration.md) 第 10.2 节）：

```yaml
budgets:
  maxModelCallsPerTurn: 6     # decision rounds + nudges + speech + speech retry
  maxDecisionRounds: 4
  maxToolCallsPerTurn: 8
  maxToolCallsPerRound: 3
  maxTurnMs: 90000
  maxReplans: 1
readiness:
  requireDurable: true
  requireDerived: true
  waitTimeoutMs: 120000
  onlineDegradeAfterMs: 10000
failurePolicy: strict         # strict | online-fallback (RunSpec.failurePolicy overrides it)
```

| 失败点 | strict（实验默认） | online-fallback（在线世界默认） |
|---|---|---|
| 记忆未就绪（等待超时，或 13.4 节的“整理失败”） | turn failed（`not-ready`），样本无效 | 等待超过 `onlineDegradeAfterMs` 或整理失败时，用当前已提交的 revision 继续，turn 标记 `degraded` |
| decision 模型失败或 `invalid-decision` | turn failed；玩家看到 `ui.noReply`“（对方暂未回应）” | 同左 |
| speech 失败 | 安全模板，标记 `speech-fallback` | 同左 |
| 预算耗尽 | turn 以 `budget-exhausted` 结束，已提交的命令保留 | 同左 |

### 13.4 冻结 InputFrontier 与就绪判定

1. 读取该 Agent 当前的 `observationSeq` 上限 O 与时钟 tick T。
2. durable：在事务外等待 `memory_watermarks.observation_seq_consumed ≥ O`。
3. derived（`requireDerived` 为 true 时）：等待该 Agent 没有 `due_tick ≤ T` 且状态为 queued 或 leased 的整理任务；然后检查 `memory_watermarks.derived_through_tick ≥ latestDue`，其中 `latestDue` 是该 Agent `due_tick ≤ T` 的整理任务中最大的 `due_tick`（没有任务时视为满足）。不满足说明最近一次到期整理失败了，**立即**按 13.3 节的“记忆未就绪”处理，不再等待。
4. 等待超过 `waitTimeoutMs` 同样按“记忆未就绪”处理。
5. 在一个读事务里同时读取 `memory_watermarks`（得到 `observation_seq_consumed = O'`、`revision = R`）、`perception_state`（`scanned_through_seq`、`revision`）、时钟、该 Agent 知识授权的最大版本、会话游标，组成 InputFrontier：`observationSeq = O'`、`memoryRevision = R`、`worldSeq = scanned_through_seq`。
6. 因为记忆摄入在同一事务里同时更新水位与 revision，O' 与 R 必然一致；O' 可能大于 O，多出的观察也已摄入，一并作为本 turn 的输入。

M2 的重要度触发整理的 `due_tick` 为触发时 tick + 1（[记忆](memory.md) 第 11.7 节），因此不会阻塞引起它的那个 turn；`DayPassed` 触发的整理 `due_tick` 为该 `DayPassed` 的 tick，当天之后的 turn 要等它完成。

### 13.5 actor 事务与 CAS

同一 Agent 的记忆提交（摄入、整理、`recordUse`）在该 Agent 的 actor 队列里串行执行，每次都是一个短事务。计划都带 `baseRevision`：

- 摄入计划总是基于当前 revision 当场生成并提交，不会过期。
- 整理计划与 `recordUse` 计划在事务外生成，提交时如果当前 revision 已经前进，就检查冲突：计划要退役或更新的每个 memoryId，在 `baseRevision` 之后都没有新的行版本，即可在当前 revision 之上提交（rebase）；否则重新生成计划。`recordUse` 最多重新生成 2 次；整理任务最多重新执行 1 次（包括其中的模型调用，费用计入预算），仍冲突则该任务记为 failed，`derivedThroughSeq` 不推进。

模型调用、等待水位与网络 I/O 都不在 actor 事务内进行。

### 13.6 真人席位

控制者为 human 的身份不会被调度：它的 trigger 继续累积，在控制台席位视图里作为待处理事项显示。真人通过 `/api/v1/console/ops/seats/{agentId}/commands` 提交与 Agent 相同的命令（以该 agentId 身份、带当前 `controllerEpoch`），用 `seat.say` 命令直接发送人写的消息（见 [领域模型](../architecture/domain-model.md) 第 5 节）。交还给 agent 时 epoch 再加一，积累的 trigger 按 13.2 节正常调度；交接摘要只由该身份合法获知的观察组成，不写入操作员笔记。

### 13.7 确定性决策（`agent.decision.deterministic`）

只用于工程测试与可重复的行为对照，不调用模型，不代表真实模型效果。它读取记忆包（`relationSummary` 与条目）、本 turn 的 trigger 与 `AgentWorldView`，按下面的规则做决定，经同一个工具网关执行命令，最后输出与 `decision_submit` 相同结构的决定；对白一律走安全模板。

```text
willingness(kind, requester) = 1
    + (kind 为具体任务类型且 Agent 的 skills 含该类型 ? 1 : 0)
    + clamp(trust(requester), −8, 8) / 4      # relationSummary 中 requester 的 trust；没有关系摘要（M0、M2）时为 0
    − (自己受伤 ? 2 : 0)
    − (触发是 task-invite 且该任务路径含 risk 2 的道路 ? 1 : 0)   # 对白请求没有路径，此项为 0
    + jitter                                   # rngFor(runSeed, "jitter", agentId, String(worldTick), String(agentTurnIndex))，均匀分布 [−0.25, 0.25]
```

拒绝理由的选择（willingness < 1.5 时）：requester 的关系摘要 `causes` 含 `breach` → `past-breach`；否则 trust ≤ −3 → `low-trust`；否则 → `need-guarantee`。

任务类型的识别：按 `lexicons.taskKeywords` 的顺序找第一个出现在文本里的词（具体任务词排在“派人/帮忙”之类的泛称前面）；命中泛称（`generic`）时取该 Agent `skills` 的第一项，没有技能则视为没有任务请求。“我需要你派人护送隘口那条路，能帮忙吗？”因此识别为 escort。

| 触发 | 规则 |
|---|---|
| `task-invite` | willingness ≥ 1.5：`task.respond accept`，意图 agree；否则 `task.respond decline`（带上面的理由），意图 refuse |
| `player-dialogue` | 识别出任务类型：按 willingness 给立场（≥ 1.5 为 accept/意图 agree，否则 decline/意图 refuse 带理由），不发命令；没有任务类型但含 `lexicons.questionMarkers` 中的词：意图 answer，`factRefs` 取记忆包中前 2 条的 memoryId；其余：意图 acknowledge |
| `probe` | 与“没有任务类型的提问”相同：意图 answer |
| `agreement-proposal` | 自己不承担任何条款：trust(提案人) > −8 时 accept，否则 reject；自己承担条款：这些条款都在自己的委托余额内且 willingness ≥ 1 时 accept，否则 reject，意图 refuse |
| `prospective` | 自己是义务人：向对方 `message.send`，意图 remind；对方是义务人（期限当天）：向对方 `message.send`，trust ≥ 0 时意图 remind，否则意图 warn |
| 其他 | 立场 none，意图 none |

一个 turn 并入多个 trigger 时，按创建顺序逐个处理：`task-invite` 与 `agreement-proposal` 各自执行自己的命令；对白意图取优先级最高的 trigger 的结果（同优先级取最晚的那个）。

用 [内容包](../game/content-pack.md) 第 11 节的 `s-promise` 推算（tick 2 协议生效，break 分支 tick 37 违约）：tick 60 时岑雁对玩家的 trust ≈ 1×0.5^(58/120) − 8×0.5^(23/480) ≈ −7.0。M1、M3 的 willingness ≈ 1 + 1 − 1.76 + jitter ∈ [−0.01, 0.50]，必然 decline，理由 `past-breach`；M0、M2 没有关系摘要，willingness = 2 + jitter ∈ [1.75, 2.25]，必然 accept。keep 分支在 tick 14–16 履约，trust 约 +8.6（取 8），四组都 accept。这就是 [构建计划](../delivery/build-plan.md) S21 断言的依据。
