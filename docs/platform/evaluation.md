# 评估、对比与实验有效性

> 目标规范，尚无运行成绩。首版优先比较 memory；全模块架构允许把游戏规则、客户端 UI、控制台页面等也作为显式装配轴，但任何轴都必须固定其他条件并记录 resolved diff。原文档案字段由 [可观测性](observability.md) 维护；装配语义见 [积木组合](../architecture/composition.md)。

## 1. 三种运行模式及其结论边界

| 模式 | 输入与调用 | 能回答 | 不能证明 |
|---|---|---|---|
| 审计重放 | 使用已记录事件、工具和模型输出；不调模型、不重复执行外部副作用 | 当时发生什么、规则与投影能否重建 | 新策略效果、模型再次输出相同内容 |
| 开环重决策 | 固定感知流与决策检查点，替换选定槽；重新调用模型，行动不写入共享世界 | 同等已知信息下，记忆/上下文如何改变回答与提案 | 长期自主互动结果、该行动真的可执行到最后 |
| 闭环分支 | 从共同快照独立推进，冻结玩家/运营外部指令脚本，保留各分支内生后果 | 不同策略如何改变后续关系、冲突与局势 | 全程输入相同、单次结果具有因果普遍性 |

审计重放校验事件序列、投影和状态 hash；压缩或整理曾用 LLM 时复用其已记录产物，不能后台重新生成。开环中的世界查询工具使用冻结检查点的授权投影；写工具只生成提案，不落世界状态。反思与 memory 写入只落该开环 run 的隔离副本。

闭环冻结的是“外部指令尝试及其逻辑时间/触发条件”，不强行写入相同的世界结果。某分支已失去据点，原护送指令可合法拒绝；这种差异要保留。NPC 内部通信与行动后果不得被原轨迹覆盖。

真人自由试玩属于探索性运行；未脚本化的临场运营不能直接作为严格 A/B 证据。正式单玩家世界不得回滚来迁就实验，实验在独立 `branchId` 执行。

Agent 上限按全平台同时激活的逻辑身份计，正式世界与实验合计不得超过 15。标准 15 个 Agent 正式运行时，完整闭环对比必须先暂停正式运行并释放名额，再逐分支执行。休眠快照不占激活名额，激活前必须预留名额；局部被试实验仅可使用实际空余名额。

## 2. 启动预检与运行清单

运行必须冻结以下清单；任何一项发生变化都产生新 run 或显式阶段标签，禁止原地覆盖配置。

| 分类 | 冻结项 |
|---|---|
| 内容 | 世界观、地图、规则、角色、剧情包及 schema 版本/hash |
| 模块 | module catalog 快照、三 realm assembly、模块 ID/version/config hash、client/console assembly hash |
| 软件 | Git revision、锁文件、依赖版本、tool definition/binding 与配置 hash |
| 模型 | 模型池版本、resolved mounts、供应商实际标识、参数、adapter、tokenizer、工具/输出 schema、价目配置 |
| 实验 | 假设、主指标、样本计划、变量、模式、种子、停止规则 |
| 初态 | 世界快照、Agent 状态、memory、会话窗口、任务队列、整理任务、水位及输入 frontier |
| 外部输入 | 玩家/运营脚本、角色权限、controller 接管计划、逻辑时钟、玩家开局派系、连接的控制台角色 |

预检步骤：

1. 校验三 realm 模块目录与 assembly：实现存在、apiVersion/能力相容、必需 provider 唯一、client/console 贡献合法；浏览器页面不能要求服务端对象或凭据。
2. 选择共同世界点并暂停新决策，排空已提交事件必要处理；冻结各 Agent 的 InputFrontier，包含 worldSeq/worldTick、observationSeq、perceptionRevision、memoryRevision、conversationCursor、knowledgeGrantRevision，不能只选一个 worldSeq。
3. 校验快速就绪水位：感知分发、memory 实时摄入已覆盖约定的输入 frontier；不能简单要求所有 Agent 的可见序号等于全局序号。
4. 校验派生就绪水位：对该 frontier 之前按 profile 应完成的整理任务，等待成功或显式失败；记录 `derivedThroughSeq`。失败只可进入 failed/invalid，不进入成功评分；未完成不得开始正式比较。统一冻结旧派生水位只用于带 `stale-derived` 标签的探索性运行，不混入正式结果。
5. 快照和 hash 校验后给每个 run 分配独占 branchId（包括开环）；确认没有跨分支缓存、向量索引或外部记忆服务串读，禁止两个 run 并发复用同一 branch。
6. 确认 controllerEpoch、队列序号与预算，启动运行；连接过的 client/console assembly hash 记录进本次运行证据；预检失败保留报告并停止比较。

水位需区分“全局已扫描到哪条事件”和“该角色最新可见观察”；公开事件无需强行复制成每人一份记忆。输入 frontier 冻结各来源日志/队列边界，不仅记录一个世界序号。异步任务结果须携带输入水位、profile hash 和分支标识，过期结果不得写入新的配置运行。无整理能力的 profile 明确声明派生就绪条件为空，不能伪造已完成任务。

从中途切换 memory 策略时，只能用切换点之前、该角色获准感知的历史重建新存储；禁止用切换后信息回填。是否携带旧记忆、重建方式及其调用成本都进入 run manifest。冷启动与迁移实验分别报告。

## 3. 变量控制与记忆基线

先固定 perception、context、compression、toolView、decision、模型与输入预算，只比较 memory；再分别研究其他槽。不同架构包一起变化时可以比较整体体验，但不能把收益全部归因于某一个组件。游戏规则、客户端 UI 或控制台页面也可以作为装配轴，但必须单独报告；“换界面后更清楚”不能误读成 memory 效果。

| 记忆组 | 目标差异 | 必须写清的细节 |
|---|---|---|
| M0 `memory.none` | 无长期记忆；保留身份与当前交互所需输入 | baseline-window 为主基线、baseline-current 为诊断；窗口大小、会话边界、是否携带近期观察 |
| M1 `memory.ledger` | 结构化经历、关系与承诺索引 | 检索过滤、容量、规则评价表；哪些账本进入 policy |
| M2 `memory.stream-reflection` | 观察流、检索排序与证据化反思 | 打分、反思触发、模型、整理频率与成本 |
| M3 `memory.layered-hybrid` | 分型存储、核心块与生命周期组合 | 启用哪些层、每层容量、压缩/失效/合并策略 |

M0 仍有权威权限、正式协议及履约事实；这些只保证世界规则成立，不等于 NPC 记得承诺。身份与性格固定输入也不算长期经历。关系账本是否提供给 policy 必须显式记录；不能让所有组都暗中读取完整历史账本，再宣称是在比较遗忘。

前瞻记忆实验同时审计唤醒源：规则到期结算可对各组一致，主动提醒只来自本组启用的主观前瞻记录。共同调度器若向所有组注入完整条款和提前唤醒，会旁路 memory；研究固定触发条件时另行标记，不能把该结果当成完整前瞻记忆收益。

每个机制既可做“同 token 预算”实验，也可做“同总费用上限”实验，两类结果分开。记录实际注入 token 与预算利用率，不能因容量设置相同就认为输入相同。profile 的每一次整理/压缩费用计入本组。

先单变量筛选，再做少量交互实验，例如 memory × compression、perception × toolView。避免对全部组合穷举；未测试的组合在报告中明确为空白。

## 4. 最小验收场景集

每个场景含初态、已知信息矩阵、外部脚本、决策检查点、合法行动集合、预期方向、失败条件和可自动核验的来源事件。预期方向不等于规定 NPC 必须说同一句话。

| 场景 | 体验/机制问题 | 核验重点 |
|---|---|---|
| 救援后再求助 | 对曾救过自己的玩家是否更愿意冒险 | 有无经历的行为差异，理由引用是否真实 |
| 承诺与反悔 | 说好交还通道后，是否主动履约或解释冲突 | 主观记得、主动行动、权威履约三者分开 |
| 私密谈判与传闻 | 未在场者是否泄密，转述后如何改变信念 | 时间点、消息来源、置信度与可知范围 |
| 旧印象被反证 | 多次敌意后出现真实合作，是否更新看法 | 保留审计、失效旧认识、避免无依据翻转 |
| 多主体冲突请求 | 玩家与其他角色同时争取同一 NPC 支持 | 单一 NPC 状态、资源裁决、因果与公平性 |
| 人类派系与非人类势力交涉 | 不同主张是否影响联盟、拒绝和妥协 | 身份一致、记忆影响行动而非只有措辞 |
| 真人/Agent 接管 | 三个运营席位独立接管并归还 | epoch 拒绝旧命令、无双重下令、记忆连续 |
| 长期运行与故障 | 忘记、压缩、限额和模型故障是否可定位 | 有界、恢复、失败标注、证据完整 |

首版提供三个可执行脚本：承诺与反悔（`s-promise`）、传闻与反证（`s-rumor`，同时覆盖“旧印象被反证”）、私密谈判（`s-secret`），见 [内容包](../game/content-pack.md) 第 11 节。真人/Agent 接管与长期运行故障由集成测试覆盖（见 [构建计划](../delivery/build-plan.md)）；救援后再求助、多主体冲突请求、派系交涉三个场景在首版以人工试玩记录，脚本留到后续补充。

场景同时包含“应记住”和“应不知道/不确定”的题，防止系统靠全部回答肯定获取高分。秘密的泄露评估须排除由公开线索可合理推断的事实，另列“推断命中”。

## 5. 指标必须带分母

| 指标 | 定义与限制 |
|---|---|
| 有证据回忆正确率 | 正确且可追溯的回答 / 预先标注的可回答问题；同时报告遗漏率 |
| 编造率 | 无可用证据却断言事实的回答 / 全部事实问题；“不知道”单列 |
| 知情泄露率 | 断言未授权秘密的回答 / 未授权秘密探针；推断类单列 |
| 检索覆盖率 | 命中的相关标注记忆 / 检查点全部相关标注记忆；不等于最终利用率 |
| 引用有效率 | 存在、属于本角色且与陈述相关的引用 / 全部输出引用；相关性需规则或人工检查 |
| 行为差异 | 配对情景的行动分布差、拒绝/合作方向；报告样本与不确定性 |
| 承诺表现 | 主动履约数 / 可履约且到期的承诺；外部阻断、故意违约、遗忘分别统计 |
| 规则拒绝率 | 被世界拒绝的提案 / 所有提案；再按非法、过期、冲突分类 |
| 性能与费用 | p50/p95 端到端延迟、每决策/每游戏时段 token 和费用，含失败重试 |
| 有界与漂移 | 各层条数/字节/token 曲线；同类检查点错误率随逻辑时间的变化 |
| 可定位率 | 能完整追到感知、调用、裁决三段证据的决策数 / 全部决策数 |

没有机会的指标记 `N/A`，未知记 `unknown`，失败保留在总样本中。hard gate 为零次越权世界写入、零次跨分支/跨角色未授权存取、接管期间零次旧 epoch 命令生效；这些要求不代表语言泄露率已达到零。

## 6. 人工体验与报告

人工试玩使用相同剧情起点与预算，隐藏 preset 名称，交叉平衡试玩顺序。分别询问“记得过去”“坚持主张”“会主动做事”“改变有原因”“愿意再次互动”，并要求给出具体事件；不把台词更长直接评为更像人。

自动评分优先使用规则真值与感知矩阵。LLM judge 只作为辅助，配置固定，实验组对 judge 隐藏，保存评分输入与输出，并抽样人工复核。也不能让 judge 先读取被评分 NPC 不该知道的秘密，再因为它准确说出秘密而给分。

先用小样本试跑检验场景有效性，再按效应大小和方差确定正式样本计划。配对运行使用共同初态、外部输入与游戏随机种子；LLM 的 seed 即使相同也不保证可复现，须重复采样并记录模型指纹（若提供）。

每份报告包含假设、版本清单、样本/失败分布、输入与成本差异、指标与不确定性、典型正反例、原始证据链接、混杂因素及适用范围。多指标探索结果标为探索性，不能只展示胜出的场景或提前停止后报告最好一次。

常见混杂须主动标注：请求时供应商模型变化、缓存差异、队列负载、不同感知水位、真人临场操作、关系账本旁路、携带上一组记忆、过期整理结果、工具信息量差异和不同降级频率。

验收顺序为：先通过权限/事件/接管硬约束与证据完整性，再检查各 preset 确实改变实际输入，最后评估记忆对行为和体验的收益。允许结论是“没有显著收益”或“成本不值得”；未运行、失败和无效对照必须如实报告。

## 7. 单玩家、模型和共享工具的专项对照

玩家席位、15 个身份的初始关系、4 名 AI 党魁是否激活、初始秘密矩阵和逻辑时钟都是实验条件。不同席位开局不能混为相同输入样本；需要跨席位总结时分层报告。

比较 memory 时固定 model 池配置及解析挂载、ToolDefinition 版本、ToolBinding 授权、context 窗口和感知策略。比较模型时固定被试 Agent 与策略，只改 mounts 指向；比较 tool-view 时固定真实工具结果与权限，只改变入模投影。工具是否可用是不同于返回详细程度的变量。

比较游戏规则模块时固定内容、roster、模型、输入脚本与预算，只改规则 provider；把规则差异、可执行行动集合与结算结果分开报告。比较客户端 HUD/renderer 模块时固定同一 player command 脚本，报告可理解性与操作差异，不能把视觉差异算成世界事实差异。比较控制台页面/观测实现时固定 trace 生成，只验证可定位性与权限，不改变被观察样本。

每个角色准备正向、负向、误会和反证案例，战略主体则准备授权/合作/升级场景。角色与派系共用模型不构成同一被试；各自的记忆与输入不同，不能把二十个不同人格直接当同模型二十次重复实验。

只有先证明选项确实改变实际阶段，再比较体验。没有调用某模型反思的 memory.none 不能被分摊虚构的维护费用；启用反思的组不能漏算该费用。所有 fallback 与运营干预单列。

报告必须区分“世界结果差异”“Agent 可见输入差异”“玩家/控制台呈现差异”；只改了 client/console 模块而声称为 Agent 能力提升，属于无效结论。控制台评估页由 `console.evaluation.standard` 模块贡献，替换页面不得改变指标定义或失败分母。

## 8. 探针执行与计分（首版）

探针脚本格式见 [内容包](../game/content-pack.md) 第 11 节，prompt 见 [prompts](../agent/prompts.md) 第 7 节。

执行：

1. 受控时钟推进到检查点 tick，并等本步结算完成（[运行时](../agent/runtime.md) 第 13.2 节）。
2. 静默实验分支，为每个探针各复制一个沙盒分支（[存储](../architecture/storage.md) 第 3 节），互不影响。先把实验分支激活状态置为 dormant 释放配额，再逐个创建沙盒；沙盒里只激活被提问的 Agent（占用配额，探针结束后释放）。全部探针结束后重新预留配额并激活实验名册。
3. 运行器在沙盒里以 `system:world` 身份提交 `probe.ask`（[领域模型](../architecture/domain-model.md) 第 5 节），产生 `ProbeAsked` 事件；感知把它变成 `probe` 渠道的观察（来源就是这个事件，`releasePolicyId = parties:<askedBy,agentId>`），并生成 `probe` trigger。该命令仅在 active sandbox 中豁免 paused；沙盒不推进逻辑时间。只调度本次 probe trigger，decision 仅提供只读查询与 `decision.submit`，speech 照常校验但不调用 `speech.commit`，使用所属实验 run 冻结的 profile 与模型挂载；确定性决策按 [运行时](../agent/runtime.md) 第 13.7 节以 `answer` 意图作答。
4. 把对白原文、decision JSON、引用的记忆 ID、turn 状态写入 `probe_results`；沙盒分支归档，实验分支继续推进。

计分以脚本冻结的 `answerKey` 为准，匹配前去掉空白与标点。只有未知和遗忘标记来自内容包的 `lexicons.unknownMarkers` 与 `lexicons.forgetMarkers`。禁止提及的常见改述可逐条写入脚本的 `mustNotMention`。

| kind | 判定为正确 | 计入的指标 |
|---|---|---|
| `recall` | `mustMention` 全部出现，且 `mustNotMention` 都不出现；回答中含 `unknownMarkers` 或 `forgetMarkers` 的词时记为遗漏 | 有证据回忆正确率、遗漏率 |
| `belief` | 同 recall | 信念更新正确率 |
| `unknown` | 回答含 `unknownMarkers` 中的词之一，且 `mustNotMention` 都不出现；否则记为编造 | 编造率 |
| `secret` | `mustNotMention` 都不出现；出现任一即记为泄露 | 知情泄露率 |

报告注明这四项是词面计分。同义改述可能漏匹配，否定句也可能命中关键词，语义复核的结果单列。

探针在以下情况记为无效，不进入正确率的分母，但在报告里单列数量与原因：turn 失败；没有产生对白（意图为 none）；对白来自安全模板但模型决策路径本应作答（`speech-fallback`）；严格实验中出现模型替换（`model-substituted`）；证据不完整。确定性决策的对白本来就是模板，不算 `speech-fallback`。LLM judge 默认关闭；开启时使用独立的 evaluator 挂载，结果与上述规则分数并列报告，不替代它。

行为记录：脚本里每个触发 Agent 决策的外部输入（例如 `s-promise` 第 60 tick 的请求）都记录该 Agent 的 `stance`、意图、理由类别与提交的命令，用于比较各组的行为分布。

## 9. 报告格式

`GET /api/v1/console/runs/{runId}/report` 返回：

```json
{
  "runId": "run-...",
  "variant": "memory-m1-structured-ledger",
  "scriptId": "s-promise",
  "scriptBranch": "break",
  "validity": { "valid": true, "contaminated": false, "evidenceComplete": true, "invalidReasons": [] },
  "metrics": [
    { "metric": "recall-accuracy", "numerator": 1, "denominator": 1, "value": 1.0 },
    { "metric": "fabrication-rate", "numerator": 0, "denominator": 1, "value": 0.0 },
    { "metric": "leak-rate", "numerator": 0, "denominator": 1, "value": 0.0 },
    { "metric": "rule-rejection-rate", "numerator": 1, "denominator": 4, "value": 0.25 },
    { "metric": "traceable-turn-rate", "numerator": 9, "denominator": 9, "value": 1.0 }
  ],
  "probes": [
    { "probeId": "p-recall-promise", "agentId": "human-independent", "answer": "……", "score": { "kind": "recall", "correct": true }, "valid": true }
  ],
  "invalidProbeCounts": {
    "turn-failed": 0,
    "no-dialogue": 0,
    "empty-answer": 0,
    "speech-fallback": 0,
    "model-substituted": 0,
    "evidence-incomplete": 0
  },
  "behavior": [
    { "atTick": 60, "agentId": "human-independent", "trigger": "player-dialogue", "stance": "decline", "reasonCode": "past-breach", "commands": [] }
  ],
  "memory": { "recordsByTier": { "short": 12, "long": 5, "core": 1 }, "maintenanceRuns": 2, "maintenanceFailures": 0 },
  "cost": { "inputTokens": 12000, "outputTokens": 3000, "unknownUsageAttempts": 0, "costEstimate": 0, "currency": "USD", "pricingVersion": "2026-11" },
  "latency": { "turnP50Ms": 4200, "turnP95Ms": 9100 }
}
```

没有机会计算的指标写 `"value": null` 并附 `"reason": "n/a"`。实验汇总（`GET /api/v1/console/experiments/{id}`）按“变体 × 脚本分支”列出各指标的有效样本数、无效样本数与均值，以及每个 run 的链接；样本数少于 3 的格子标注“样本不足”。首版报告不做显著性检验，结论可以是“差异不显著”或“证据不足”。
