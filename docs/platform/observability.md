# 可观测性与原始调用档案

> 目标规范。观测字段、调用归档、控制台与隐私规则以本文为准；实验模式与指标由 [评估](evaluation.md) 维护。观测实现是可替换模块，但证据契约与采集位置属于宿主固定能力，不能随 provider 更换而丢失。

## 1. 观测必须回答的问题

一次 NPC 拒绝护送，应能查明：它感知到什么、存下什么、回忆了什么、实际发给模型什么、模型返回什么、规则接受了什么，以及最终改变了什么。换掉 memory、context、renderer 或控制台页面后，这些证据仍应能按同一 traceId 重建。

“它记得我”必须同时有行为证据和体验证据；引用往事的次数多，不代表记忆质量高。玩家界面呈现角色行为与适度理由，服务端控制台呈现完整技术证据。

核心不变量：世界事件与原始调用档案不随角色遗忘而删除；观测不能改变决策；任何失败、重试、人工干预和降级均不得静默消失。观测模块失败使本次运行标记 `evidence-incomplete`，不能伪装成完整可复现实验。

## 2. 一条贯通的因果链

```text
外部指令/内生事件
  先经世界裁决，产生已提交事件
  再形成带权限的感知投影
  随后写入或更新记忆
  进入调度与决策轮次
  依次做记忆检索、上下文组装和压缩，发出 LLM 请求并接收响应
  执行工具，形成 Agent 行动提案，由规则接受或拒绝
  产生新世界事件，触发后续感知
```

链路用结构化 ID 连接，不靠日志文本猜测。一个父事件可触发多个 NPC，使用 `causationIds` 和 span links 表达多因多果；`traceId` 只用于定位一次处理链，不承担世界排序或权限判断。

| 层级 | 必须保留的关联字段 |
|---|---|
| 实验 | `experimentId`、`runId`、`worldId`、`branchId`、`scenarioId` |
| 参与者 | `agentId`、`principalId`（如适用）、`controllerKind`（agent 或 human）、`controllerEpoch` |
| 因果与顺序 | `eventId`、`worldSeq`、`causationIds`、`correlationId`、`traceId`、`spanId` |
| 决策 | `turnId`、`attemptId`、`commandId`、`idempotencyKey` |
| 证据 | `observationIds`、`memoryIds`、`contextArtifactId`、`llmCallId`、`toolCallIds` |

事件以 branch 内单调的权威序列 `worldSeq` 排序，不能跨 branch 直接比较序号；耗时使用单调计时，剧情与衰减使用游戏逻辑时间。不得拿日志到达时间代替事件发生时间。

## 3. 每层采什么

| 阶段 | 记录内容 | 用于区分的故障 |
|---|---|---|
| 世界裁决 | 指令、身份、前置版本、接受/拒绝、原因码、结果事件、规则版本 | 非法动作与 Agent 判断错误 |
| 感知 | 输入事件范围、投影版本、实际字段、删减原因、可见性判定 | 没看见与看见后忘记 |
| 记忆写入 | 来源观察、候选、门控分、操作、前后版本、合并/淘汰原因 | 未写入、被覆盖、自然遗忘 |
| 检索 | 查询与预算、过滤域、候选、分项得分、排名、舍弃原因 | 没召回与召回后没注入 |
| 上下文 | 有序分段、来源 ID、优先级、原始/实际 token、丢弃段 | 上下文排列与预算问题 |
| 压缩 | 输入/输出 artifact、策略版本、保留/丢失引用、触发原因 | 摘要失真与普通截断 |
| 推理 | 原始请求/响应、结构化解析结果、用量、延迟、错误 | 模型、供应商、解析失败 |
| 工具 | 工具名/版本、参数、权限结果、完整输出、呈现给模型的输出 | 工具事实与 toolView 失真 |
| 行动 | 提案、引用证据、有效性、裁决、实际后果 | 口头承诺与执行差距 |
| 整理 | 批次输入范围、读写水位、派生操作、证据校验、失败 | 异步记忆污染与整理漂移 |

检索记录覆盖候选总数与筛选过程；大量候选可以归档分页展示，但不得只保存命中的 top-k 而丢失诊断所需依据。观测写入有界缓冲，写入档案失败必须使本次运行标记 `evidence-incomplete`，不能伪装成完整可复现实验。

### 3.1 LLM 调用档案

每次实际网络尝试单独保存 `attemptId`。请求档案包括：provider、model、供应商实际返回的模型标识（若有）、规范化消息、适配器序列化后的业务请求体、工具 schema、输出 schema、采样参数、输出上限、超时及重试配置。

响应档案包括：原始业务响应体或流式 chunk、客户端可见内容、tool calls、结束原因、供应商 request ID、usage、缓存用量（若提供）、解析错误及校验错误。只记录模型实际返回的内容，不声称能读取隐藏推理过程。

同时记录：排队耗时、检索耗时、上下文/压缩耗时、网络首 token、完整响应耗时、工具耗时、裁决耗时、端到端耗时；流式失败时保留部分响应并标记中断。

成本按本次运行冻结的价目配置计算，注明币种、日期、估算与实测用量差异；缺 usage 记为未知，不能记为零。记忆整理、embedding、重试和评估调用分别计费后汇总。

### 3.2 原文、脱敏与访问

| 数据 | 保存与展示规则 |
|---|---|
| API 密钥、Authorization、Cookie | 永不进入业务调用档案；配置只存密钥引用 |
| 业务请求/响应原文 | 受限 artifact 存储，保存内容 hash；研究员按 run 授权读取 |
| 玩家私聊、私人记忆、未公开剧情 | 控制台按观察权限展示；普通玩家和非人类势力运营席位无权查看 |
| 默认控制台与导出 | 使用脱敏副本，保留字段、长度与来源关系，注明脱敏版本 |
| 对外分享 | 导出前生成可检查的脱敏包；原始档案不随报告自动公开 |

原文与脱敏副本分开，脱敏不能覆盖原文或冒充精确重放输入。原文不可用时，明确相应重放模式不可用。实验档案按 run 独立归档；删除、保留期限与授权撤销由档案策略管理，不由 memory TTL 管理。

## 4. 服务端控制台的观测页

观测页运行在 `console` realm，由 `console.observability.standard` 模块贡献到服务端 `:3000/console/*` 的路由和 panel slot。页面通过授权控制台 API 读取 `platform.observability.sqlite` 模块归档的数据。页面模块可替换，证据生成与查询语义不变；隐藏页面不等于数据不可见，玩家会话访问控制台 API 必须 forbidden。入口与角色规则见 [两个本地端口](../architecture/two-endpoints.md)。

1. 运行总览：分支、模式、配置 hash、20 个 Agent 状态、controller、当前水位、失败与预算。
2. 世界事件时间线：按玩家/Agent/地点筛选，区分公开事实、观察投影和研究员真值。
3. Agent 检查器：身份与主张、当前可见世界、记忆版本、关系来源、承诺的主观认知。
4. 调用检查器：有序上下文、原始请求/响应、工具完整结果与 toolView 结果并排查看。
5. 记忆差异：写入、合并、失效、衰减及淘汰前后差异，逐层追到来源事件。
6. 分支对比：同一决策点并排展示输入差异、行动差异、后续世界差异与指标分母。
7. 模块与装配：本 run 的 server/client/console 模块、版本、config hash 与 effective 参数；换模块后的差异可并排。

每个列表能跳转至上一层和下一层证据。配置面板必须展示“下个运行生效”或具体生效边界；正式单玩家世界的玩家不拥有实验配置写权限。后台运营席位也是 gameplay Agent 的控制者，不承担评估裁判职责。调试页面（`console.debug.standard`）可以单步/重放与查看预算，但不能把研究真值注入角色知识，调试覆盖产生污染标记。

## 5. 模型池与共享工具的观测

modelId、connectionId、modelConfigHash、purpose、resolved mount 与实际供应商模型标识同时记录。一个模型挂载多个角色时，可按模型聚合费用/限流，也可按角色定位每份独立 context。凭据不进入档案；共享 modelId 不表示调用输入相同。

每次工具调用记录 toolId/version（定义身份）、bindingId、主体/目标、effective permissions、operationId、command receipt，以及原始完整结果/模型可见结果两个 artifact。相同 definition 被多个角色复用时，不能只按工具名混成一条无法区分权限的日志。

记录 Agent 激活/休眠配额、全模型池排队、账号限流、各 purpose 预算、取消和 fencing 拒绝，避免把队列等待误判为模型慢或记忆慢。真实耗时与 worldTick 分开。

模块级调用也必须进入同一宿主 trace：模块创建的模型请求、存储事务、工具执行、渲染/页面数据请求都要带 traceId/spanId 与模块 ID/version，不能在模块内部开未记录的外部调用。替换观测模块只改变存储与查询 provider，不改变采集点；替换其他模块不能使其调用从证据链消失。

## 6. 证据完整性与排障流程

从一条行为先确认世界裁决，再沿 source 向前检查：主体是否看见、是否写入、是否仍有效、是否召回、是否入模、模型是否使用、工具是否成功。不能只凭最终台词判定 memory 故障。

正式实验要求最终模型请求、响应、必要工具结果与裁决引用完整。观测存储失败使 run 进入 `evidence-incomplete`，停止成功评分；在线可继续规则任务但必须显示故障。高频渲染帧可采样，关键证据不可采样。

request/response 保存模型真实返回内容，不声称拥有隐藏的 chain-of-thought；策略引用与语言理由只作可核验陈述，不能被当作内部推理的完整证明。

每个界面明确真值视角、Agent 视角与玩家视角。研究员查看真值不产生 InformationShared，不改变角色知识，也不能经后台席位自动下发真相。

## 7. 验收

从任意一次角色拒绝可定位到其观察、记忆 revision、最终请求与规则结果；同模型不同 Agent 不混档；同工具不同 binding 能区分；失败重试与未知 usage 仍进入费用/样本统计；普通玩家和运营席位无权访问未授权原文。替换 memory/context/renderer/控制台页面后，同一 traceId 的证据链仍完整；控制台页面权限与 API 权限分开验证。

## 8. 首版实现规格

### 8.1 span 与 trace

| span 名称 | 产生位置 | 关键属性 |
|---|---|---|
| `http.request` | 路由层 | `route`、`status`、`principalId`、`activeRole` |
| `command` | authority | `commandType`、`commandId`、`principalId`、`commandStatus`、`reasonCode`、事件数 |
| `job` | 规则 job 执行 | `jobKind`、`jobId`、`dueTick` |
| `perception.event` | 感知消费者 | `eventId`、`eventType`、获得观察的 Agent 数 |
| `memory.ingest` / `memory.maintenance` | 记忆 worker | `agentId`、`moduleId`、`baseRevision`、`newRevision`、条数、结果 |
| `turn` | turn 根 span | `turnId`、`agentId`、`triggerIds`、`profileHash`、终态 |
| `turn.freeze` / `turn.retrieve` / `turn.context` / `turn.compression` / `turn.speech` / `turn.settle` | turn 各阶段 | 阶段的 requested/resolved/effective、`applied`/`skipped`/`failed` 与原因 |
| `turn.decision.round` | 每一轮 decision | 轮次、工具调用数 |
| `model.attempt` | 模型池 | `attemptId`、`purpose`、`modelId`、`adapterId`、usage、各段耗时、错误 |
| `tool.call` | 工具网关 | `toolId`、`bindingId`、`operationId`、`executionStatus`、`commandStatus` |

- 每个外部输入（玩家或运营的一次 HTTP 命令）开启一个 trace，`traceId` 同时写进由它产生的事件的 `correlationId`。
- 由事件唤醒的 turn 开启新的 trace，在根 span 的 `causeTraceIds` 属性里记录触发事件的 `correlationId`，控制台据此跨 trace 跳转。
- span 先写进内存缓冲，每 200 ms 或满 500 条批量落库。`turn`、`model.attempt`、`tool.call`、`command` 四类是必需证据：缓冲溢出时可以丢弃其他 span，但这四类不能丢；一旦丢失，该 run 的 `evidence_complete` 置 0。

### 8.2 artifact 种类

| kind | 写入者 | 内容 |
|---|---|---|
| `context` | context 模块 | ContextArtifact（[上下文](../agent/context.md) 第 11.4 节） |
| `model-request` / `model-response` | 模型池 | 规范化请求与线协议请求体 / 线协议响应体与规范化响应 |
| `tool-raw` / `tool-view` | 工具网关 / tool-view 模块 | 工具完整结果 / 入模视图 |
| `speech` | speech 流程 | 已通过校验的对白与校验记录 |
| `manifest` | experiment | 去密钥的冻结 manifest |
| `export` | audit | 导出包 |

大于 64 KB 的正文写到 `data/artifacts/<artifactId>`，表中只存路径与 hash。

### 8.3 脱敏副本

控制台默认展示、导出默认使用脱敏副本；原文需要 researcher 角色并写一条审计生命周期事件。首版的脱敏规则：

1. 秘密原文（`private:` 资料）替换为 `[SECRET <secretId> len=N]`。
2. 凭据形态的字符串（与任一已解析凭据相同的子串）替换为 `[REDACTED]`；正常情况下不应出现，出现即记一条安全事件。
3. 其余字段（包括玩家原话）保留，它们本身就是研究对象；对外分享前由研究员另行审查。

脱敏副本另存为新的 artifact（`redaction: redacted`，`redacted_from` 指向原文），不覆盖原文。
