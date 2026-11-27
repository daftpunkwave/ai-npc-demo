# 评估、对比与实验有效性

> 状态：接口、实验展开、探针计分与闭环冷启动的实验执行器（驱动受控时钟到脚本检查点、分叉沙盒执行探针、写入 `probe_results` 与 `experiment_results`）已实现；审计重放、开环重决策与从快照起步尚未接入执行器（见第 8 节）。首版优先比较 memory；全模块架构允许把游戏规则、客户端 UI、控制台页面等也作为显式装配轴，但任何轴都必须固定其他条件并记录 resolved diff。原文档案字段由 [可观测性](observability.md) 维护；装配语义见 [积木组合](../architecture/composition.md)。

## 1. 三种运行模式及其结论边界

| 模式 | 输入与调用 | 能回答 | 不能证明 |
|---|---|---|---|
| 审计重放 | 使用已记录事件、工具和模型输出；不调模型、不重复执行外部副作用 | 当时发生什么、规则与投影能否重建 | 新策略效果、模型再次输出相同内容 |
| 开环重决策 | 固定感知流与决策检查点，替换选定槽；重新调用模型，行动不写入共享世界 | 同等已知信息下，记忆/上下文如何改变回答与提案 | 长期自主互动结果、该行动真的可执行到最后 |
| 闭环分支 | 从共同快照独立推进，冻结玩家/运营外部指令脚本，保留各分支内生后果 | 不同策略如何改变后续关系、冲突与局势 | 全程输入相同、单次结果具有因果普遍性 |

审计重放校验事件序列、投影和状态 hash；压缩或整理曾用 LLM 时复用其已记录产物，不能后台重新生成。开环中的世界查询工具使用冻结检查点的授权投影；写工具只生成提案，不落世界状态。反思与 memory 写入只落该开环 run 的隔离副本。

闭环冻结的是“外部指令尝试及其逻辑时间/触发条件”，不强行写入相同的世界结果。某分支已失去据点，原护送指令可合法拒绝；这种差异要保留。NPC 内部通信与行动后果不得被原轨迹覆盖。

脚本也可以以名册内某个 Agent 的身份声明外部动作，执行器在注入这一步时短暂取得该 Agent 的脚本控制、按它的权限提交，随即交还（第 8.1 节）。这类动作同样是冻结的外部输入，解读结果时要注意以下几点：

- 动作记在该 Agent 名下，其他身份分辨不出它是脚本注入还是该 Agent 自己的选择，它们的后续反应针对的是该 Agent 做了这件事。
- 被控 Agent 的感知与记忆摄入不暂停，它会像感知其他事件一样感知这次动作，记忆里因此可能出现一件记在它名下、它却没有决策过的行为。这条记忆是实验刺激的一部分：回忆类探针答出它，说明记住了世界里发生的事，不说明该 Agent 自主做过这件事；需要考察自主选择时不要用脚本替它行动。
- 行为记录只来自 turn，脚本动作不进入被控 Agent 的行为分布。
- 窗口在执行器注入的同一同步段内开合，注入发生在上一 tick 收敛之后，或开局、恢复后时钟刚进入单步、尚未调度任何 turn 时，所以不推迟任何 turn，窗口期间产生的 trigger 在交还后的同一 tick 收敛中处理。即使有持窗口前代次的晚到输出，两次代次递增也使它按过期控制被拒，不会与脚本动作重复下令。
- 各变体注入的是同一条外部动作，规则仍可能在某个变体里拒绝它（例如该 Agent 在这个分支里已不持有要分享的证据），拒绝照常记入审计，属于闭环结果。

真人自由试玩属于探索性运行；未脚本化的临场运营不能直接作为严格 A/B 证据。正式单玩家世界不得回滚来迁就实验，实验在独立 `branchId` 执行。

Agent 上限按全平台同时激活的逻辑身份计，正式世界与实验合计不得超过 15。标准 15 个 Agent 正式运行时，完整闭环对比必须先暂停正式运行并释放名额，再逐分支执行。休眠快照不占激活名额，激活前必须预留名额；局部被试实验仅可使用实际空余名额。

当前执行器在同一宿主进程内逐个执行实验 run，只使用实际空余名额：实验名册在开局事务内预留配额，探针沙盒与探针结束后的名册重新激活也各自预留；名额不足时 run 暂停为 `paused`（审计原因 `quota-unavailable`），不会挤占在线世界，腾出名额后再次启动即从当前 tick 继续。只暂停在线时钟不会释放名额。在线世界已开局且名册占满时，由 operator 先休眠在线名册再启动实验：

1. `POST /api/v1/console/campaign/roster/hibernate`：运行或单步中的在线时钟先受控暂停并补完当前 tick，随后在线名册全部置为休眠，在线名额归零。休眠期间在线世界只读，继续与单步被拒绝，在线分支的数据原样保留在存储中。
2. 启动实验 run，执行器按上面的规则为实验名册与探针沙盒预留名额。
3. 实验结束后 `POST /api/v1/console/campaign/roster/wake`：在一个事务内按名册预留名额并重新激活全部在线身份，名额不足时整体拒绝（`budget-exhausted`，可重试），不留下部分激活的名册。唤醒后时钟仍为 `paused`，由运营或玩家继续。

接口与错误码见 [API](../architecture/api.md#53-三势力席位与世界运营)。

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

探针脚本格式见 [内容包](../game/content-pack.md) 第 11 节，prompt 见 [prompts](../agent/prompts.md) 第 7 节。`platform.evaluation.standard` 计分与报告组装、`probe.ask` 沙盒命令、`knowledge.seed` 预置知识命令、`/api/v1/console/runs*`、`/experiments*` 接口与实验执行器均已实现。执行器在每个检查点执行以下循环（触发、顺序与终态见第 8.1 节）：

1. 受控时钟推进到检查点 tick，并等本步结算完成（[运行时](../agent/runtime.md) 第 13.2 节；收敛条件见 [规则](../game/rules.md) 第 1 节第 6 步）。
2. 静默实验分支，为每个探针各复制一个沙盒分支（[存储](../architecture/storage.md) 第 3 节），互不影响。先把实验分支激活状态置为 dormant 释放配额，再逐个创建沙盒；沙盒里只激活被提问的 Agent（占用配额，探针结束后释放）。全部探针结束后重新预留配额并激活实验名册。
3. 运行器在沙盒里以 `system:world` 身份提交 `probe.ask`（[领域模型](../architecture/domain-model.md) 第 5 节），产生 `ProbeAsked` 事件；感知把它变成 `probe` 渠道的观察（来源就是这个事件，`releasePolicyId = parties:<askedBy,agentId>`），并生成 `probe` trigger。该命令仅在 active sandbox 中豁免 paused；沙盒不推进逻辑时间。只调度本次 probe trigger，decision 仅提供只读查询与 `decision.submit`，speech 照常校验但不调用 `speech.commit`，使用所属实验 run 冻结的 profile 与模型挂载；确定性决策按 [运行时](../agent/runtime.md) 第 13.7 节以 `answer` 意图作答。
4. 把对白原文、decision JSON、引用的记忆 ID、turn 状态写入 `probe_results`；沙盒分支归档，实验分支继续推进。引用的记忆 ID 是 decision JSON 中的 `citedMemoryIds` 与 `dialogueIntent.factRefs`；turn 状态体现为 `valid` 与 `invalid_reason`，探针 turn 的 ID、终态、终止原因与沙盒分支 ID 另记在实验分支的 `ExperimentProbeCompleted` 审计事件里。

### 8.1 执行器的触发、顺序与终态

执行器运行在服务端宿主进程内，与在线世界共用存储写连接、游戏模块实例与部署级配额；每个实验 run 使用自己的命令网关（随机种子取该 run 的 `seed`，开局只激活该 run 的名册）、调度与工具模块和 Agent 运行时，不读写在线分支。

- 触发：`POST /api/v1/console/runs/{runId}/start` 把 run 置为 `running` 后唤醒执行器。只驱动 `mode: closed-loop`、声明了 `script` 的实验 run；没有脚本的 run 启动后仍只改状态与时钟。
- 顺序：同一宿主同一时刻只执行一个 run，其余按 `started_at` 先后排队；`GET /api/v1/console/runs/{runId}/progress` 的 `executing` 区分正在执行与排队。
- 准备：用创建 run 时的同一实现复算冻结配置（装配、名册、Agent profile、工具集与模型挂载）并核对 `manifest_hash`，不一致记 `manifest-mismatch`；run 的服务端装配摘要必须与宿主当前装配一致，否则记 `assembly-mismatch`，需以同一装配启动宿主。
- 开局：冷启动时以玩家身份提交 `campaign.start`，派系取脚本的 `start.factionId`；名册在开局事务内预留配额，名额不足时命令被整体拒绝，run 暂停为 `paused`，`ExperimentRunStopped` 审计的原因为 `quota-unavailable`；每次开局尝试使用新的命令 ID，腾出名额后再次启动不会重放上一次的拒绝回执。
- 预置知识：脚本声明了 `setup` 时，执行器在 tick 0 的时钟步骤之后、tick 0 的脚本步骤之前，按声明顺序以 `system:world` 为每一条提交 `knowledge.seed`（[领域模型](../architecture/domain-model.md) 第 5 节）。该命令只在实验分支、开局之后且世界时钟仍为 tick 0 时受理，Agent 在首次感知之前就已持有预置条目，各变体的起点一致。命令 ID 由 run 与预置序号确定性派生；停止后在 tick 0 恢复时以同一 ID 重放，取回原回执而不重复授权。任何一条被拒绝时 run 记 `script-setup-rejected` 失败，不带着缺失的初始条件继续。
- 推进：每一段从 `paused` 进入 `stepping`，段终点不越过下一个检查点、脚本终点与时钟单步上限 `maxStepTicks`。每个 tick 先按规则第 1 节提交时钟、到期 job、时钟步骤与消费者，再按声明顺序注入该 tick 的脚本命令（主线步骤在前、所选分支的追加步骤在后；`as` 为玩家时以玩家身份提交，为 Agent 时在脚本控制窗口内提交，见下一条；命令 ID 由 run 与步骤序号确定性派生，恢复执行时重放得到原回执），然后等待收敛：规则 job 与事件消费者追平、感知与记忆摄入追平、到期整理完成、没有未终结的 turn，且一轮内事件前沿与 turn 总数不再变化。只因冷却不能调度的 trigger 不产生 turn，不阻塞收敛。脚本命令被规则拒绝属于闭环结果，照常记入审计并继续推进。
- 脚本控制：`as` 不是玩家的步骤，其主体必须在 run 的名册里，否则准备阶段记 `script-principal-not-in-roster` 失败，实验分支不开局。注入这一步时，执行器先取得该 Agent 的脚本控制：控制租约种类改为 `script`，控制者记为本 run，控制代次 +1。随后以 `kind: system`、`principalId = actingAsAgentId = 该 Agent`、脚本控制代次经命令网关提交，提交后立即交还 Agent，代次再 +1；取得、提交与交还在同一同步段内完成，不让出事件循环。命令按该 Agent 的权限裁决，回执与事件记在该 Agent 名下。两次控制变更各写一条 `ControllerChanged` 生命周期审计，载荷含前后种类与代次、控制者 run、步骤序号、tick 与命令 ID。窗口内调度器不为该 Agent 创建 turn，持旧代次的 turn 提交与认领都按 `stale-controller` 拒绝；感知、记忆摄入与整理不暂停。脚本控制只能由执行器在活动的实验分支上、对 Agent 自己控制的身份取得，取得被拒时 run 记 `script-control-rejected` 失败；在线与沙盒分支、真人席位与任何 HTTP 或控制台入口都不能取得或借用。已有回执的步骤在恢复执行时不再开窗口。进程若在窗口内退出，遗留的脚本控制在下一次执行开局与推进之前交还，审计上下文沿用取得时的记录并标记 `recovered: true`；尚未提交的步骤之后按原命令 ID 重新开窗口提交。
- 检查点：本 tick 收敛后暂停实验分支时钟，执行上面第 2–4 步；已写入结果的探针不重复提问。探针结果按 turn 终态补齐后，执行器在同一事务写入 `ExperimentProbeCompleted`，它是结果已落定的判据：探针 turn 写下回答后、终态补齐前执行被停止或进程退出时，恢复执行不会因为已有回答就跳过，而是找到当时提问的沙盒（按其中的 `ProbeAsked`），按该沙盒里 turn 的终态补判——到达 `completed` 的回答保留，被取消、停在中间状态或找不到沙盒的一律改判 `turn-failed`；审计载荷带 `recovered: true`。
- 完成：处理完脚本终点（最后一个外部命令或检查点所在 tick）后，按与 `GET /runs/{runId}/report` 相同的口径把每项指标写入 `experiment_results`（`details_json` 带变体、脚本分支、有效性与无效样本计数），run 置为 `completed`，实验名册休眠并释放配额。
- 轨迹完整性：实验分支上的 turn 以 `failed` 或 `budget-exhausted` 结束（模型调用失败、预算或截止耗尽、决策无效，或停止时已产生部分副作用而被截断）时，它消费的触发没有得到完成的决策，后续轨迹不再是完整的闭环。执行器不因此中止：run 照常推进到终点并写入 `experiment_results`，但报告有效性记为无效，`invalidReasons` 含 `agent-turn-failed`，实验汇总把该 run 的各项指标计为无效样本（第 5 节“失败保留在总样本中”）。被取消的 turn 会释放触发并重新调度，不计入；探针沙盒里的 turn 失败按探针无效原因单列。
- 失败：死信的规则失败（`rule-failure`）、Agent 运行时周期失败（`agent-runtime-failed`）、单个 tick 或探针超过收敛上限（`settle-timeout`，宿主默认 30 分钟）、到达章节终点（`chapter-ended`）等使 run 记为 `failed`，原因码与说明写入 `ExperimentRunFailed` 审计事件，名册休眠、时钟暂停。配额不足不作废 run：开局、探针沙盒或探针后的名册重新激活缺少名额时，run 暂停为 `paused`、名册休眠（沙盒激活缺额时沙盒的复制随之回滚，不留下未提问的沙盒），腾出名额后再次启动即可继续，已写入结果的探针不重复提问。
- 停止与恢复：`POST /runs/{runId}/stop` 把 run 与时钟置为暂停，执行器在下一次收敛检查或命令注入前停下：在途 turn 因时钟版本变化被取消，进行中的沙盒被归档，实验名册休眠。再次启动后先补完当前 tick，再从当前 tick 继续。停止与启动都会递增实验分支时钟的 `run_version`，执行器把它作为本次执行的围栏：自己的暂停、单步与 tick 推进后采纳新版本，每次检查同时核对 run 状态与版本，时钟控制也带期望版本提交。停止后立即再次启动、旧执行还没来得及读到 `paused` 时，它在下一次检查发现 run 虽是 `running` 但版本已变，于是只归档自己的沙盒并记一条 `ExperimentRunStopped`（`reason: superseded`），不改 run 状态、名册与时钟，也不写 `completed` 或 `failed`；随后由新一次执行从当前 tick 接手。宿主关闭时执行中的 run 改为 `paused`；进程中断遗留的 `running` 实验 run 在下次启动时同样归位为 `paused`，未关闭的沙盒被归档，由研究员显式继续。停止接口先提交 `paused`，执行器随后才异步归档沙盒、休眠名册；进程在两者之间退出时，下次启动对 `paused` 的实验 run 同样归档遗留的 active 沙盒、休眠沙盒与实验分支上仍激活的身份，并记一条带释放数量的 `ExperimentRunInterrupted`；没有遗留时不做任何写入，重复启动是幂等的。
- 观察：执行器把 `ExperimentRunStarted`、`ExperimentStepSubmitted`、`ExperimentCheckpointReached`、`ExperimentProbeCompleted`、`ExperimentRunCompleted`、`ExperimentRunFailed`、`ExperimentRunStopped` 与 `ExperimentRunInterrupted` 写入实验分支的生命周期审计，脚本控制的取得与交还另记 `ControllerChanged`，可经 `GET /api/v1/console/timeline?branchId=` 查看；进度接口给出当前 tick、脚本终点、已写入结果的探针数与最近一条执行器事件。
- 未接入：`audit`、`open-loop` 模式与 `initialState: snapshot/rebuild` 仍由 RunSpec schema 拒绝。

### 8.2 经 OpenAI 兼容网关用真实模型执行

仓库规格 `exp-memory-promise-v1` 引用 `shared-model-layout-v1`，它的价目记录要求供应商模型名为 `deepseek-flash`。网关以其他模型名提供服务时，改用 `openai-compatible-gateway-layout-v1`。这份布局的挂载、能力、限额与用途上限都与共享布局相同，区别有两处：

- 价目引用 `config/pricing-openai-compatible-gateway.yaml`，记录的模型名为 `deepseek-v4.1-flash-official`，单价沿用 deepseek-flash（输入 0.3、输出 1.2 USD/百万 token），报告中的费用是估算值；
- 推理开关与返回名别名取自部署变量，见 [配置](configuration.md#10-完整配置文件首版)。

该网关在响应中报告 `deepseek/deepseek-flash`，并且默认开启推理。推理 token 计入 `max_tokens`，speech 的 400 上限会在输出 JSON 前耗尽。因此执行前需要关闭推理，并把上游名称声明为别名：

```dotenv
WORLD_PRISM_DATA_DIR=./data/experiments-gateway
WORLD_PRISM_ASSEMBLY=local-slg-standard-v1
WORLD_PRISM_MODEL_LAYOUT=openai-compatible-gateway-layout-v1
WORLD_PRISM_OPENAI_COMPAT_BASE_URL=<网关基址，含 /v1>
WORLD_PRISM_OPENAI_COMPAT_API_KEY=<密钥>
WORLD_PRISM_OPENAI_COMPAT_MODEL=deepseek-v4.1-flash-official
WORLD_PRISM_OPENAI_COMPAT_THINKING=disabled
WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS=deepseek/deepseek-flash
```

1. 用新的数据目录启动宿主，不开局在线世界。`WORLD_PRISM_MODEL_LAYOUT` 也要指向网关布局：首次启动时，在线 run 按这个变量选择的布局预检，若沿用共享布局，价目记录的模型名不一致，启动会失败。
2. 以研究员身份调用 `POST /api/v1/console/experiments`，提交内联 `{ "experimentSpec": ... }`。规格内容与 `config/experiments/exp-memory-promise-v1.yaml` 相同，只把 `base.modelLayoutRef` 改为 `openai-compatible-gateway-layout-v1`；`experimentId` 不变，展开出同样的 24 个 run，seed 也相同。每个 run 创建时把网关布局、价目版本，以及解析后的 `thinking` 与 `servedModels` 冻结进 manifest；启动时复算并核对 `manifest_hash`，创建后改动这些变量会让该 run 记为 `manifest-mismatch`。
3. 同一数据目录中已有同一 `experimentId` 的 run 时，创建请求按 RunSpec 的 `id` 原样返回这些 run，不会按新布局重建。换布局重跑必须使用新的数据目录。
4. 按第 8.1 节逐个启动 run，读取进度、报告与实验汇总。响应报告的名称命中别名的 attempt 不记 `model-substituted`，span 的 `reason` 为 `served-model-alias`；其他名称仍记替换，严格实验中受影响的探针记为无效（[模型池](../agent/model-pool.md#125-记录)）。

计分以脚本冻结的 `answerKey` 为准，匹配前去掉空白与标点。只有未知和遗忘标记来自内容包的 `lexicons.unknownMarkers` 与 `lexicons.forgetMarkers`。禁止提及的常见改述可逐条写入脚本的 `mustNotMention`。

| kind | 判定为正确 | 计入的指标 |
|---|---|---|
| `recall` | `mustMention` 全部出现，且 `mustNotMention` 都不出现；回答中含 `unknownMarkers` 或 `forgetMarkers` 的词时记为遗漏 | 有证据回忆正确率、遗漏率 |
| `belief` | 同 recall | 信念更新正确率 |
| `unknown` | 回答含 `unknownMarkers` 中的词之一，且 `mustNotMention` 都不出现；否则记为编造 | 编造率 |
| `secret` | `mustNotMention` 都不出现；出现任一即记为泄露 | 知情泄露率 |

报告注明这四项是词面计分。同义改述可能漏匹配，否定句也可能命中关键词，语义复核的结果单列。

探针在以下情况记为无效，不进入正确率的分母，但在报告里单列数量与原因：turn 失败；没有产生对白（意图为 none）；对白来自安全模板但模型决策路径本应作答（`speech-fallback`）；严格实验中出现模型替换（`model-substituted`）；证据不完整。确定性决策的对白本来就是模板，不算 `speech-fallback`。探针 turn 自己写入有回答与 `no-dialogue` 的结果；turn 失败、预算耗尽或从未被调度时，执行器补写 `turn-failed`；对白写入后 turn 在结算阶段失败的，已写入的结果被改判为 `turn-failed`。LLM judge 默认关闭；开启时使用独立的 evaluator 挂载，结果与上述规则分数并列报告，不替代它。

行为记录：脚本里每个触发 Agent 决策的外部输入（例如 `s-promise` 第 60 tick 的请求）都记录该 Agent 的 `stance`、意图、理由类别与提交的命令，用于比较各组的行为分布。报告按触发种类排除不属于外部输入的唤醒：`probe` 与 `debug` 是测量和排障手段，`patrol` 与 `prospective` 是 Agent 按自身节奏的定时唤醒。调度器会把同一 Agent 待处理的触发合并进一个 turn，因此按 turn 的触发列表顺序取第一个外部触发作为该条记录的 `trigger`；触发全是这类内部唤醒的 turn 不进入行为记录。

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
    { "metric": "omission-rate", "numerator": 0, "denominator": 1, "value": 0.0 },
    { "metric": "belief-accuracy", "numerator": 1, "denominator": 1, "value": 1.0 },
    { "metric": "fabrication-rate", "numerator": 0, "denominator": 1, "value": 0.0 },
    { "metric": "leak-rate", "numerator": 0, "denominator": 1, "value": 0.0 }
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

没有机会计算的指标写 `"value": null` 并附 `"reason": "n/a"`。当前 `platform.evaluation.standard` 已实现上例 5 项探针指标的聚合（`rule-rejection-rate` 与 `traceable-turn-rate` 为后续扩展指标）。实验汇总（`GET /api/v1/console/experiments/{id}`）按“变体 × 脚本分支”列出各指标的有效样本数、无效样本数与均值，以及每个 run 的链接；样本数少于 3 的格子标注“样本不足”。首版报告不做显著性检验，结论可以是“差异不显著”或“证据不足”。
