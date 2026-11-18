# 记忆模块详细设计

> 状态：目标规范，尚未实现。主问题是“经历怎样改变 NPC 后续选择”，而不是“存下多少文本”。通用模块/插件协议见 [插件机制](../architecture/plugins.md)，实验口径见 [评估](../platform/evaluation.md)。

## 1. 职责与不变量

memory 接收角色已经获准感知的观察，形成可修订、可检索、可遗忘的主观记录；向 decision/context 提供证据包。世界事件库全集、可见性判断、完整 prompt 组装和游戏动作执行都不在它的职责内。

scope 固定为 `worldId/branchId/agentId`；每个实验 run 独占一个 branch。单玩家从五个人类派系中选择开局，不改变 NPC 记忆归属，也不把该派系的全部记忆自动授予玩家。角色表见 [角色设计](../game/characters.md)。

世界 authority 维护库存、位置、权限、正式协议及其履约状态；policy 决定是否合作、提醒、拒绝或履约。NPC 忘记约定不会删除正式协议，规则服务知道履约事实也不代表 NPC 已知。

记忆从观察推导，所有来源必须可追溯。角色说“巡裔袭击运输队”，首先是“该角色声称如此”，不能因原话在世界日志中存在就变成袭击已获证实。

## 2. 数据与接口

下表类型中，`MemoryScope`、时间与事件信封等共享字段由 contracts 定义；Memory 专有类型由本文定义，插件不得维护不同版本的 scope、时间或事件信封。

| 数据 | 必需字段与含义 |
|---|---|
| `MemoryScope` | worldId、branchId、agentId，由宿主绑定 |
| `AgentObservation` | observationId、observationSeq、sourceEventIds、knownAtTick、epistemic、releasePolicyId、content |
| `MemoryRecord` | memoryId、scope、kind、sourceObservationIds、contentRefs、revision、status、有效时间、releasePolicyId、content |
| `MemoryQuery` | scope、冻结 revision、inputFrontier、话题/对象/地点、purpose、目标受众、条数/token 预算 |
| `MemoryBundle` | 候选及得分、过滤原因、最终条目、来源、版本、预算消耗、空结果/错误状态 |
| `MemoryChangePlan` | baseRevision、输入观察范围、增改/失效/淘汰操作、来源映射、容量变化、派生任务 |
| `MemoryCheckpoint` | schemaVersion、pluginId/version、revision、水位、存储/索引版本、状态 hash |

epistemic 分两层：`AgentObservation.epistemic` 为 witnessed/reported/inferred（怎么知道），`MemoryRecord.epistemic` 为 verified-event/reported-claim/inference（证据地位）。两者不得互换；传播权限另由 releasePolicyId 表达，宿主从来源计算，不能由模块自由提升。

状态值为 active、superseded、expired、evicted、retracted。取代旧认识时新增 revision，保留审计；检索默认排除非 active 项。只读身份/世界观通过 contentRefs 引用版本化内容，不伪造一条“亲历事件”。

| 操作 | 输入与输出 | 提交责任 |
|---|---|---|
| `prepareIngest` | 输入已授权观察批次与 baseRevision，产出 MemoryChangePlan | 宿主验证并原子提交记录/inbox/水位 |
| `retrieve` | 输入 MemoryQuery，返回 MemoryBundle | 只读冻结版本，不推进时间或偷偷强化 |
| `prepareMaintenance` | 输入到期任务、截止 tick/frontier、baseRevision，产出变更计划及调用引用 | 模型在事务外计算，宿主 CAS 发布 |
| `recordUse` | 输入 turnId、实际注入/合法引用 ID、使用类型，产出强化计划 | 宿主幂等验证，不能信任任意模型自报 |
| `export/import` | 输入检查点与兼容 schema，产出状态或显式迁移错误 | branch 暂停后执行，失败保留旧档 |

模型调用走宿主 model port 与 `(agentId, purpose)` 挂载：整理使用 memory-maintenance，向量生成使用 embedding。插件配置只声明策略需求，不复制 provider、model、temperature 或凭据，见 [模型池](model-pool.md)。

## 3. 可组合的记忆类型

| 类型 | 内容示例 | 默认使用方式 |
|---|---|---|
| 情景 episodic | 玩家冒险救回我的同伴 | 指向观察与结果，不复制当前库存快照 |
| 关系 relation | 因三次兑现而更愿信任玩家 | 修正项、来源、时效；是否提供给 policy 可配置 |
| 认知 belief | 我认为灰港愿意承担合作风险 | 有证据和置信度，可被反证与取代 |
| 前瞻 prospective | 我答应下次潮汐前提供向导 | 角色记得的约定，不替代正式协议真值 |
| 核心 core | 此刻最在乎的是失踪队员 | 稳定身份只读，动态关切有来源与限长 |
| 公共 public | 已公开的联合护送纪要 | 授权公共投影，不能成为无限历史外挂 |

沿用旧研究的 L1 到 L6 类型思路；L0 世界事实始终归平台。类型不要求单独存储层：一个插件可以用同一张表，也可以完全不实现某一类，但必须声明 capability，不能输出空对象假装支持。

## 4. 四类初始实现

| 实现 | 写入/读取/整理 | 要验证的问题 |
|---|---|---|
| `memory.none` | 不保留长期经历；消费观察并推进游标；检索返回空 | 当前输入或短窗口是否已足够 |
| `memory.ledger` | 规则将经历、关系、主观承诺写成结构化记录；按标签检索 | 便宜且可解释的账本能否驱动行为 |
| `memory.stream-reflection` | 观察流 + 相关/新近/重要度排序 + 证据化反思 | 反思与检索是否增加跨场景理解 |
| `memory.layered-hybrid` | 分型容量、生命周期、核心块及显式组合 | 多层组合的收益是否覆盖复杂度和费用 |

`none` 可配无历史 context 的诊断 preset（baseline-current），或配有限会话窗口的主基线（baseline-window）；窗口由 context 管理，none 不保留长期状态。固定当前投影、身份与窗口后再比较其他 memory 实现。

M1 的 structured-ledger preset 就是 ledger 的基线参数组合；ledger 的关系/前瞻输入必须有开关。若四组都从 context、工具或派系简报绕回完整历史账本，实验无效。当前可见正式合同可按同一规则提供，但不得附带全历史“人物应当记住的理由”。

## 5. 写入与整理流程

写入流程是：已授权观察先做幂等检查与结构化分类、显著度门控，形成候选经历、关系或主观承诺并校验来源与容量，然后原子提交并推进 durableThroughSeq；到期维护任务再做衰减、合并、反思和核心块编译，最后经证据、权限与版本校验后 CAS 发布并推进 derivedThroughSeq。

1. 观察以 observationId 去重；重投不能重复记仇、加信任或登记承诺。
2. 即时游戏事实优先用规则映射；自由文本理解的结果仍是候选，不直接写入权威状态。
3. 显著度可由参与程度、性格、事件类别和新鲜度组成；分项入 trace，避免黑箱阈值。
4. 同类重复经历可合并为模式，但保留计数、时间范围、不同结果和来源，不能把一次误会扩成“总是如此”。
5. 整理只处理截止 frontier 以前已知的资料；输出印象必须带证据，不允许新增证据中不存在的人物或机制事实。
6. 对冲突先区分“新的事实状态”“不同人的说法”“旧认识被反证”，不能一律按最新文本覆盖。

反思失败不推进 derivedThroughSeq 水位；任务保存 failed 状态与错误。正式实验按 readiness 判 failed/invalid，在线仅允许已声明且可见的 fallback，不自动换成 none。

## 6. 检索、使用与行为

检索顺序：先绑定冻结 revision，再按 scope 和获知时间过滤，接着召回目标对象与话题，然后分项排序，做去重与多样性处理，按条数与 token 截断，最后返回原始记录和来源。context 负责将记录变成最终段落。

stream-reflection 可使用 `score = wR × relevance + wT × recency + wI × importance`。归一化区间、时间基准、权重、候选池与并列排序必须固定；若使用随机扰动，使用宿主注入的带种子随机源。LLM seed 不保证模型重现相同输出。

候选数、requested top-k、resolved top-k、最终入模数分别记录。命中但被 context 截断的记录不算“使用”；实际入模数与输出合法引用数分开计数，把哪一种计数作为强化依据，必须在策略里写明。

记忆包只影响 Agent 的输入及选择，不直接扣资源。例：岑雁回忆玩家曾临阵撤退，提出“先交担保再护送”；world authority 校验担保和护送是否可执行。接受/拒绝不能全部由固定规则决定后只让模型改写台词。

## 7. 水位、版本与时间

durableThroughSeq 表示已扫描并完成必要实时摄入的 branch worldSeq；未授权事件也可推进内部扫描进度，但不生成泄露秘密存在的空白观察。observationSeq 是角色本地序列，不能与 worldSeq 数值混比。

derivedThroughSeq 表示截至对应输入边界、按 profile 应完成的派生任务已成功提交；none 明确没有派生任务，不能用虚构反思推进。索引构建若是检索必需能力，也纳入 readiness。

turn 等待所需水位后冻结不可变 revision；检索还需验证每条来源的获知边界不晚于 inputFrontier。仅过滤当前表不能恢复已经被覆盖或淘汰的过去版本。未来摘要不得混入旧检查点。

等待水位、网络和模型时不得持有阻塞 maintenance 发布的 actor 锁。计算可异步，发布通过 revision CAS 串行化；过期计划拒绝或重算。具体调度见 [runtime](runtime.md)。

衰减按 worldTick/逻辑时间计算，不按网络耗时。checkpoint 包含未完成任务与两类水位；停止运行先 drain，超期任务显式取消，晚到结果仍验证 branch、profileHash、baseRevision 和租约。

## 8. 配置维度与示例

| 维度 | 示例起点/选项 | 应观察的代价 |
|---|---|---|
| 写入 | 事件白名单、salience 阈值、原文长度 | 漏记与噪声 |
| 存储 | 每类型容量、总字节上限、TTL | 关键记录被淘汰 |
| 检索 | 标签/关键词/embedding、候选池、top-k、权重 | 命中、费用、延迟 |
| 衰减 | 半衰期、核心豁免、使用强化模式 | 长期偏见和遗忘速度 |
| 整理 | 定时/事件触发、批大小、反思证据要求 | readiness 积压与模型费用 |
| 输入 | relationInput、prospectiveInput、publicHistory | 记忆旁路和实验混杂 |

以下仅展示 memory 槽配置片段，不是完整可启动配置：

```yaml
memory:
  module: agent.memory.layered-hybrid
  config:
    episodicCapacity: 200
    beliefCapacity: 40
    recallCandidateLimit: 30
    recallTopK: 6
    relationInput: enabled
    prospectiveInput: enabled
    reinforcement: validated-reference
    maintenanceTrigger: world-period
```

上述为目标参数示例，单位、范围、默认值由 descriptor schema 定义，尚无最优性依据。profile 冻结与参数覆盖规则见 [配置](../platform/configuration.md)。

## 9. 遗忘、权限与迁移

细节淘汰后保留概括是允许的压缩策略，必须显式声明；它不同于彻底遗忘。来源被撤回、纠错、权限收紧或要求彻底遗忘时，沿 provenance 失效相关摘要、信念、核心块和索引，必要时重算；不能继续从旧摘要读回已撤回秘密。

审计记录保留用于研究，不属于 NPC 可读记忆；memory TTL 不能删除模型档案或世界事实。由来源权限合成的摘要只能按保守范围传播，公开输出还要由 speech context 重新过滤。

切换记忆模块新建 run/branch，并明确冷启动、从合法历史重建或迁移。重建只消费该角色在切换点之前获准感知的观察；受全平台 20 个 gameplay Agent 总激活配额的约束，满额时先暂停在线运行，再逐分支执行，不能隐藏新增的整理 Agent。

## 10. 验收用例

| 用例 | 通过条件 |
|---|---|
| 重复投递同一救援观察 | 只有一次经历和关系变化；水位可恢复 |
| A 得知秘密、B 未得知 | B 无记录、召回和摘要；伪造 scope 被拒绝 |
| 听说袭击后获得反证 | 保留“曾听说”，修订当前信念，不改袭击真值 |
| 承诺跨会话与窗口 | 有记忆组可表现主动提醒差异，世界正式合同不随组消失 |
| 整理晚到与旧检查点查询 | CAS 或 frontier 拒绝未来/过期结果，不覆盖新记忆 |
| 容量超限与遗忘 | 淘汰可解释、有界；彻底撤回不会从旧摘要复活 |
| 插件故障、迁移失败 | 明确错误与无效样本，旧状态仍可读回恢复 |
| 行为对照 | 相同当前输入下合作条件/行动有可追踪差异，不仅台词措辞变化 |

观测只记录阶段事实和来源，不宣称输出引用证明模型内部因果。详细指标、样本有效性与请求响应归档由 [观测](../platform/observability.md) 和 [评估](../platform/evaluation.md) 统一维护。
