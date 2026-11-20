# 记忆模块详细设计

> 状态：目标。记忆策略用于验证经历怎样改变 NPC 的后续选择。通用模块/插件协议见 [插件机制](../architecture/plugins.md)，实验口径见 [评估](../platform/evaluation.md)。

## 1. 职责与不变量

memory 接收角色已经获准感知的观察，形成可修订、可检索、可遗忘的主观记录；向 decision/context 提供证据包。世界事件库全集、可见性判断、完整 prompt 组装和游戏动作执行都不在它的职责内。

scope 固定为 `worldId/branchId/agentId`；每个实验 run 独占一个 branch。设计支持五个人类席位；本切片玩家是公社党魁，不改变 NPC 记忆归属，也不把该派的全部记忆自动授予玩家。角色表见 [角色设计](../game/characters.md)。

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

| 类型             | 内容示例          | 默认使用方式                     |
| -------------- | ------------- | -------------------------- |
| 情景 episodic    | 玩家冒险救回我的同伴    | 指向观察与结果，不复制当前库存快照          |
| 关系 relation    | 因三次兑现而更愿信任玩家  | 修正项、来源、时效；是否提供给 policy 可配置 |
| 认知 belief      | 我认为灰港愿意承担合作风险 | 有证据和置信度，可被反证与取代            |
| 前瞻 prospective | 我答应下次潮汐前提供向导  | 角色记得的约定，不替代正式协议真值          |
| 核心 core        | 此刻最在乎的是失踪队员   | 稳定身份只读，动态关切有来源与限长          |
| 公共 public      | 已公开的联合护送纪要    | 授权公共投影，不能成为无限历史外挂          |

沿用父项目记忆设计中的分层思路（本仓库自包含，定义如下）：L0 世界事件日志是客观事实，始终归平台，不属于任何角色的记忆；L1 个人经历（episodic）、L2 关系账本（relation）、L3 认知与印象（belief）、L4 承诺与嘱托（prospective）、L5 核心记忆块（core）、L6 公共编年史（public）。类型不要求单独存储层：一个插件可以用同一张表，也可以完全不实现某一类，但必须声明 capability，不能输出空对象假装支持。四个实现各自用到哪些层见第 11 节。

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

以下仅展示 memory 槽配置片段，不是完整可启动配置；四个实现的完整参数与默认值见第 11 节：

```yaml
memory:
  module: agent.memory.layered-hybrid
  config:
    capacity: { short: 50, long: 120, core: 30, beliefs: 40, prospectiveActive: 20 }
    recall: { topK: 8, candidateLimit: 40 }
    relationInput: enabled
    prospectiveInput: enabled
    reinforcement: validated-reference
    maintenanceTrigger: world-period
```

上述为目标参数示例，单位、范围、默认值由 descriptor schema 定义，尚无最优性依据。profile 冻结与参数覆盖规则见 [配置](../platform/configuration.md)。

## 9. 遗忘、权限与迁移

细节淘汰后保留概括是允许的压缩策略，必须显式声明；它不同于彻底遗忘。来源被撤回、纠错、权限收紧或要求彻底遗忘时，沿 provenance 失效相关摘要、信念、核心块和索引，必要时重算；不能继续从旧摘要读回已撤回秘密。

审计记录保留用于研究，不属于 NPC 可读记忆；memory TTL 不能删除模型档案或世界事实。由来源权限合成的摘要只能按保守范围传播，公开输出还要由 speech context 重新过滤。

切换记忆模块新建 run/branch，并明确冷启动、从合法历史重建或迁移。重建只消费该角色在切换点之前获准感知的观察；受全平台 15 个 gameplay Agent 总激活配额的约束，满额时先暂停在线运行，再逐分支执行，不能隐藏新增的整理 Agent。

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

## 11. 首版实现规格

本节是四个实现的可执行规格；前面各节是它们必须满足的约束。存储方式（行版本 + revision 可见性）见 [存储](../architecture/storage.md) 第 2、4 节。

### 11.1 MemoryPort 与类型

```ts
interface MemoryPort {
  // fold newly delivered observations (seq > consumed) into a plan; never calls a model
  prepareIngest(input: { scope: MemoryScope; baseRevision: number; observations: AgentObservation[]; worldTick: number }): MemoryChangePlan;
  // read-only, bound to a frozen revision
  retrieve(query: MemoryQuery): MemoryBundle;
  // decide whether maintenance work is due; returns null when nothing is due (called by the host, runtime.md §13.1)
  planMaintenance(input: { scope: MemoryScope; revision: number; worldTick: number; observationSeqThrough: number;
                           trigger: "day-passed" | "importance" }): MaintenanceTask | null;
  // run outside the actor lock; may call the model port with purpose memory-maintenance
  runMaintenance(task: MaintenanceTask, view: RevisionView, model: ScopedModelPort | null): Promise<MemoryChangePlan>;
  // after a turn: reinforce validated citations and adjudicate model-reported noteworthy points
  recordUse(input: { scope: MemoryScope; baseRevision: number; turnId: string; citedMemoryIds: string[];
                     noteworthy: Noteworthy[]; inputObservations: AgentObservation[]; worldTick: number }): MemoryChangePlan;
  // prospective wake-ups; the scheduler calls it once per tick (runtime.md §13.2); M0 and M2 return []
  proposeWakeups(input: { scope: MemoryScope; revision: number; worldTick: number }): WakeupProposal[];
  exportState(scope: MemoryScope, revision: number): MemoryCheckpoint;
  importState(scope: MemoryScope, checkpoint: MemoryCheckpoint): MemoryChangePlan; // throws on incompatible schema
}

interface NewMemoryRow {           // one row version; memoryId is new, or an existing id for a new version
  memoryId: string;
  kind: MemoryRecord["kind"];
  tier: "short" | "long" | "core" | "none";
  status: MemoryRecord["status"];
  epistemic: MemoryRecord["epistemic"];
  releasePolicyId: string;         // most restrictive of the sources (prompts.md §3)
  validFromTick: number;
  validUntilTick: number | null;
  strength: number;                // s0 = salience at creation
  salience: number;
  recallCount: number;
  lastReinforcedTick: number;      // validFromTick at creation
  tags: string[];                  // vocabulary in §11.2
  sourceObservationIds: string[];
  content: { summaryZh: string; counterpartIds: string[]; data: Json };
}

interface MemoryChangePlan {
  baseRevision: number;
  observationSeqThrough: number;   // highest observation folded in by this plan
  inserts: NewMemoryRow[];
  retires: { memoryId: string; status: MemoryRecord["status"] }[];
  derivedThroughSeq: number | null;  // set only by maintenance plans
  derivedThroughTick: number | null; // set only by maintenance plans (= the task's due_tick)
  changeKind: "ingest" | "maintenance" | "use" | "import";
}

interface MaintenanceTask {        // stored in maintenance_runs.task_json
  moduleId: string;
  trigger: "day-passed" | "importance";
  dueTick: number;                 // day-passed: the DayPassed tick; importance: current tick + 1
  baseRevision: number;
  observationSeqThrough: number;
  day: number | null;              // for day-passed
  needsModel: boolean;             // false for M1 and for M3 agents outside the daily top-8
}

interface MemoryBundle {
  status: "ok" | "empty-by-design" | "not-ready";
  revision: number;
  coreBlock: string | null;        // M3 only
  relationSummary: { targetId: string; trust: number; affinity: number; wariness: number;
                     causes: RelationCause[]; reasonMemoryIds: string[] }[];
  items: { memoryId: string; kind: MemoryRecord["kind"]; epistemic: MemoryRecord["epistemic"]; summaryZh: string;
           validFromTick: number; score: number; mustInclude: boolean; releasePolicyId: string; sourceObservationIds: string[] }[];
  candidates: number;              // size of the candidate pool, for observability
  dropped: { memoryId: string; reason: "budget" | "dedupe" | "rank" }[];
}

interface WakeupProposal { atTick: number; dedupeKey: string; reason: "self-due" | "other-due" | "intent"; memoryId: string; counterpartId: string | null }
```

`RevisionView` 是只读的冻结 revision 视图（按 [存储](../architecture/storage.md) 第 4 节的查询）。宿主在 Agent 的 actor 队列里提交计划，冲突处理与 rebase 规则见 [运行时](runtime.md) 第 13.5 节；提交时写 `retired_revision`、插入新行、写 `memory_revisions` 与 `memory_watermarks`，全部在一个事务内完成。`prepareIngest`、`retrieve`、`recordUse`、`proposeWakeups`、`planMaintenance` 都是同步纯函数；只有 `runMaintenance` 是异步的，可以调用模型（`needsModel` 为 false 时宿主传入 null）。

### 11.2 共用：显著度与标签

`agent.memory.ledger` 与 `agent.memory.layered-hybrid` 用下式给每条观察打分，`stream-reflection` 用它换算重要度：

```text
salience = clamp01(base(eventType, role) × involvement × personality × freshness)
```

| 事件（以观察者视角） | base |
|---|---|
| 自己或自己照看的群体被救（`GroupRescued`、自己参与的救援 `TaskCompleted`） | 0.9 |
| 对方违约，自己是当事人（`AgreementBreached`，义务人不是自己） | 0.8 |
| 自己受伤（`CharacterInjured`） | 0.8 |
| 对方履约（`AgreementTermFulfilled`/`AgreementFulfilled`，义务人不是自己） | 0.7 |
| 自己违约 | 0.6 |
| 协议生效且自己是当事人（`AgreementActivated`） | 0.6 |
| 与自己派系相关的危机（`RelayDown` 对所有人；`OrchardCrisis` 对 earth-alliance 与 flora；`MigrationCrisis` 对 fauna 与 pacifist） | 0.6 |
| 自己参与的任务失败（`TaskFailed`） | 0.6 |
| 自己参与的任务完成、收到证据（`InformationShared`）、亲眼目睹的叙事事实（`WorldFactRecorded`） | 0.5 |
| 影响自己派系的政策变化（`PolicyChanged`：本派系常用道路，或对 earth-alliance/flora 而言的水闸分配） | 0.5 |
| 别人回复了自己的邀请（`TaskInvitationAnswered`）、收到邀请（`TaskInvitationIssued`） | 0.4 |
| 传闻（`RumorSpread`）、与本派系无关的危机 | 0.4（无关危机 0.3） |
| 对自己说的话（`DialogueSubmitted`）、发给自己的消息（`MessageSent`）、被提问（`ProbeAsked`） | 0.3 |
| 指标与每日变化（`MetersChanged`、`DayPassed`） | 0.1 |
| 其他事件 | 0.2 |

| 因子 | 取值 |
|---|---|
| involvement | 按观察的 channel（[感知](perception.md) 第 11.2 节）：`self`、`party`、`face-to-face`、`relay`、`evidence`、`probe`（直接发给自己或自己参与的）1.0；`on-site`（在场目击）0.5；`broadcast`、`rumor`、`public-notice`、`briefing`（听说或通报）0.3 |
| personality | 人格 `values` 中出现 `lexicons.personalityKeywords` 某一类的词时：`agreement` 类对协议事件 ×1.5；`rescue` 类对救援与受伤事件 ×1.5；`resource` 类对资源与水闸事件 ×1.5；`road` 类对道路与迁徙事件 ×1.3；`evidence` 类对证据与传闻事件 ×1.3；多个命中取最大值 |
| freshness | 同一 `(事件类型, 对方)` 在最近 48 tick 内第一次出现 ×1.2；之后依次 ×1.0、×0.8、×0.6，最低 0.5 |

分流：`salience ≥ 0.5` 写入长期经历（tier `long`），并按 11.3 节写关系修正；`0.2 ≤ salience < 0.5` 写入短期经历（tier `short`）；`< 0.2` 不单独记录，只累加到当天的聚合记录（每天每种事件类型一条，例如“第 3 天：收到 4 条公共通报”）。关系修正对所有被观察到的事件都按 11.3 节计算，与分流结果无关。

标签词表（记录的 `tags` 与查询的 `queryTags` 只用这些值）：

| 类别 | 标签 |
|---|---|
| 事件类别 | `agreement`、`breach`（违约事件）、`fulfilled`（履约事件）、`task`、`resource`、`water`、`road`、`migration`、`rumor`、`evidence`、`dialogue`、`policy`、`crisis`、`exchange`、`relay` |
| 任务类型 | `transport`、`escort`、`rescue`、`repair`、`scout`（任务事件带上其类型） |
| 实体 | 涉及的主体 ID、节点 ID（如 `pass`）、证据 ID 与证据自带的 tags |

事件到类别的对应：协议事件 → `agreement`（违约再加 `breach`，履约再加 `fulfilled`）；任务事件 → `task` + 任务类型；`ResourcesTransferred/Consumed/StockpileAdjusted`、`SupplyShortage` → `resource`；水闸政策、`OrchardCrisis/Damaged` → `water`；道路政策、`PassageGranted` → `road`；`MigrationCrisis`、迁徙道路上的任务 → `migration`；中继指标、`RelayDegraded/Down/Restored`、修复任务 → `relay`；`RumorSpread` → `rumor`；证据事件 → `evidence`（`ev-exchange-draft`、`ev-star-charts` 再加 `exchange`）；对话与消息 → `dialogue`；其他政策 → `policy`；危机事件 → `crisis`。

### 11.3 共用：关系账本（L2）

关系是 `(观察者, 对象)` 上若干带原因的修正项，维度为 `trust`、`affinity`、`wariness`。基线：`trust` 基线 = 4 × 人格 `initialRelations.trust`（−2…2 对应 −8…8，与下面的文字等级一致），其余维度基线为 0。某一时刻的关系值：

```text
value(dim, t) = baseline(dim) + Σ delta_i × 0.5 ^ ((t − t0_i) / halfLife_i)
```

| 触发（对象 X） | 修正 | cause | halfLife（tick） |
|---|---|---|---|
| X 履约，自己是当事人（`AgreementTermFulfilled`，X 为 `obligorId`，X 不是自己） | trust +6 | `fulfilled` | 240 |
| X 违约，自己是当事人（`AgreementBreached`，X 为 `obligorId`，X 不是自己） | trust −8，affinity −3 | `breach` | 480 / 240 |
| 与 X 的协议生效 | trust +1 | `agreement` | 120 |
| X 派遣的任务救了自己或自己派系照看的群体（`GroupRescued`），或把物资送到自己派系的库存点（`ResourcesTransferred` 的终点属于自己派系）；X 取事件的 `dispatcherId` | affinity +5，trust +3 | `aid` | 240 |
| X 接受自己的邀请 / 拒绝自己的邀请 | affinity +2 / −2 | `invite-accepted` / `invite-declined` | 120 |
| X 向自己分享证据 | trust +2 | `shared-evidence` | 120 |
| X 的政策关闭或限制了自己派系需要的道路，或（对 earth-alliance 与 flora）把水闸设为 harbor-first | wariness +4 | `hostile-policy` | 240 |
| 听说 X 有敌对行为（传闻） | wariness +1 | `rumor-hostile` | 120 |
| 收到可信反证（带 `rumor-counter` 标签的证据，涉及 X） | 撤销对应传闻修正（标记 superseded），并 trust +1 | `counter-evidence` | 120 |

每个对象最多保留 20 个修正项，超出时淘汰当前权重（`|delta| × 衰减系数`）最小的；每日整理时，权重低于 0.1 的修正项过期，并把原 delta 的 20% 沉淀进基线，同时留下一句概括性原因（例如“多次按约送达”）。

`retrieve` 返回的 `relationSummary` 只含本次查询的 counterpart：`causes` 是当前权重 ≥ 0.1 的修正项的 cause 去重列表，`reasonMemoryIds` 是绝对贡献最大的两项对应的记忆。context 把它渲染成文字行（`relationInput: enabled` 时，排在记忆段的核心块之后、条目之前）：

```text
- 对党魁：信任 7（信任），亲近 2，戒备 0；主要原因：[mem-…] 按约送达供给；[mem-…] 拒绝过我的邀请
```

数值到文字（数值先四舍五入到整数，`labels.trust`）：≥ 8 深信、3–7 信任、−2–2 一般、−7–−3 戒备、≤ −8 敌视。`agent.decision.deterministic` 直接读取数值与 `causes`。没有关系账本的实现（M0、M2）返回空数组。

### 11.4 共用：承诺与唤醒（L4）

前瞻记录来自三处：

1. 自己是当事人的协议生效（`AgreementActivated`）：每个条款一条，字段 `{ sourceKind: "agreement", agreementId, termIndex, obligorId, dueTick, state: "open" }`；收到对应的 `AgreementTermFulfilled` 或 `AgreementBreached` 时关闭，并转成一条经历。
2. 自己接受的任务邀请：`{ sourceKind: "task", taskId, dueTick: departTick }`。
3. 经裁决的模型自报要点（11.9 节）：`{ sourceKind: "informal", byId, dueTick }`，证据地位为 `reported-claim`。

`proposeWakeups`（`wakeups: enabled` 时）对每条开放记录给出至多一条建议：义务人是自己 → `atTick = dueTick − 6`，`reason = self-due`；义务人是别人 → `atTick = dueTick`（期限当天追问；违约要到 `dueTick + 1` 才结算，此时记录仍开放），`reason = other-due`；`dueTick` 为 null 的非正式承诺不提出。`dedupeKey = <memoryId>:<reason>:<atTick>`。M3 的每日整理产生的 `intents` 转为 `atTick = 次日 8 时`、`reason = intent` 的建议。调度器每个 tick 调用一次，把 `atTick ≤ 当前 tick` 的建议按 `dedupeKey` 去重后转成 `prospective` trigger（见 [运行时](runtime.md) 第 13.2 节）。

### 11.5 M0：`agent.memory.none`

- `prepareIngest`：不写记录，只把 `observationSeqThrough` 推进到最后一条观察；durable 水位随之推进。
- `retrieve`：返回 `status: "empty-by-design"`、`items: []`、`relationSummary: []` 的 MemoryBundle。
- `planMaintenance` 恒返回 null，`derivedThroughSeq`/`derivedThroughTick` 随摄入推进；`proposeWakeups` 返回 `[]`；`recordUse` 只记录使用统计，不写记录。
- 两个 preset 的差别只在 context：`baseline-window` 的 `historyTurns = 8`（主基线），`baseline-current` 的 `historyTurns = 0`（诊断基线）。

### 11.6 M1：`agent.memory.ledger`（structured-ledger preset）

使用 L1、L2、L4，不调用模型。下面的参数既是 `memory-m1-structured-ledger` preset，也是该模块 configSchema 的默认值。

```yaml
memory:
  module: agent.memory.ledger
  config:
    capacity: { short: 50, long: 120, core: 30 }
    salienceThresholds: { long: 0.5, short: 0.2 }
    decayBaseTicks: { short: 48, long: 480 }
    relationModifiersPerTarget: 20
    recall:
      mustIncludeProspective: 5
      mustIncludeAboutCounterpart: 2
      topK: 6
      candidateLimit: 30
      weights: { strength: 0.35, salience: 0.25, relevance: 0.30, recency: 0.10 }
    relationInput: enabled
    prospectiveInput: enabled
    wakeups: enabled
    reinforcement: validated-reference
    maintenanceTrigger: world-period
```

- 强度：`strength(t) = salience × exp(−(t − lastReinforcedTick) / τ)`，`τ = decayBase(tier) × (1 + recallCount)`；core 层不衰减（strength = salience）。被引用强化时 `recallCount + 1`、`lastReinforcedTick = t`。
- 每日整理（`DayPassed` 触发的 `MaintenanceTask`，`needsModel = false`）：重算强度；同一 `(事件类型, 对方)` 在 72 tick 内的多条短期记录合并为一条带计数的模式记录；短期记录 `recallCount ≥ 2` 或合并后 salience ≥ 0.5 时升为长期；salience ≥ 0.9 的长期记录升为 core；各层超出容量时淘汰强度最低者，主旨并入当天的聚合记录；关系修正过期与沉淀（11.3 节）。完成后推进 `derivedThroughSeq` 与 `derivedThroughTick`。
- 检索：先放必带项（与对方相关的开放承诺最多 5 条；关于对方的长期记录中 salience 最高的 2 条），再从候选中按分数取到 `topK`：`score = 0.35·strength + 0.25·salience + 0.30·relevance + 0.10·recency`，其中 `relevance = |tags ∩ queryTags| / |tags ∪ queryTags|`（记录的 `counterpartIds` 含对方时再 +0.5，上限 1），`recency = exp(−(t − validFromTick) / 240)`；同一来源事件只取一条；同分按 `validFromTick` 降序，再按 memoryId。
- 强化：只有 `citedMemoryIds` 中通过校验的记录被强化；被检索到但没被引用的不强化。

### 11.7 M2：`agent.memory.stream-reflection`

使用观察流（L1）与反思得到的看法（L3），没有关系账本与承诺账本。

```yaml
memory:
  module: agent.memory.stream-reflection
  config:
    capacity: { stream: 300, reflections: 60 }
    retrieval:
      topK: 6
      candidateLimit: 40
      weights: { relevance: 1, recency: 1, importance: 1 }
      recencyDecayPerTick: 0.995
    reflection: { importanceSumThreshold: 15, recentWindow: 15, maxPerRun: 3, minEvidence: 2 }
    maintenanceTrigger: importance-threshold
```

- 每条观察都写入观察流，重要度 `importance = 1 + round(9 × salience)`（1–10）。
- 检索：候选为与 queryTags 有交集或 `counterpartIds` 含对方的记录，再补最近 10 条；三个分量先在候选池内做 min-max 归一化（候选池所有值相同时该分量记为 0）再加权求和：`relevance = 0.6·tag Jaccard + 0.4·中文字符二元组 Dice 系数`（记录摘要对比查询文本），`recency = 0.995^(当前 tick − validFromTick)`，`importance = importance / 10`。
- 反思：每次摄入提交后，宿主调用 `planMaintenance(trigger = "importance")`；自上次反思以来新记录的重要度之和 ≥ 15 时返回任务（`dueTick = 当前 tick + 1`，`needsModel = true`）。`runMaintenance` 用 [prompts](prompts.md) 第 6.1 节的请求生成最多 3 条看法，每条至少引用 2 条记录；校验通过的看法写为 `belief` 记录（证据地位 `inference`，来源为所引记录的来源观察之并集）。成功才推进 `derivedThroughSeq`/`derivedThroughTick`。
- 超出容量时淘汰重要度最低、最旧的观察流记录；看法超出容量时淘汰被引用次数最少的。

### 11.8 M3：`agent.memory.layered-hybrid`

使用 L1–L6。L1、L2、L4 与 M1 相同；额外有：

| 层 | 规则 |
|---|---|
| L3 看法 | 每日整理时，对当天有显著变化（当天新增长期记录或关系变化绝对值 ≥ 3）的 Agent，按变化量排序取前 8 个（这些 Agent 的任务 `needsModel = true`），用 [prompts](prompts.md) 第 6.2 节的请求生成 `beliefOps`：add 新增；update 生成新行版本；supersede 把旧看法标为 superseded 并新增；keep 不变。最多 40 条 |
| L5 核心块 | 身份部分来自人格（职责、价值取向、目标，约 120 token，静态）；动态部分是 `currentConcerns`（每日整理生成；模型返回 null 或不可用时用规则兜底：开放承诺中最早到期的两条 + 最负面的关系一句）。总长不超过 300 token，每次检索都作为必带项放在记忆段第一条 |
| L6 公共编年史 | salience ≥ 0.5 的公开事件（危机、政策变化、章节事件）的摘要，按分支只存一份（`agent_id = '~public'`），检索时最多取 3 条 |

```yaml
memory:
  module: agent.memory.layered-hybrid
  config:
    capacity: { short: 50, long: 120, core: 30, beliefs: 40, prospectiveActive: 20 }
    salienceThresholds: { long: 0.5, short: 0.2 }
    decayBaseTicks: { short: 48, long: 480 }
    coreBlockMaxTokens: 300
    chronicle: { enabled: true, maxPerRecall: 3 }
    llmMaintenance: { enabled: true, maxAgentsPerDay: 8 }
    recall:
      mustIncludeProspective: 5
      topK: 8
      candidateLimit: 40
      weights: { strength: 0.35, salience: 0.25, relevance: 0.30, recency: 0.10 }
      jitter: 0.02
    relationInput: enabled
    prospectiveInput: enabled
    wakeups: enabled
    reinforcement: validated-reference
    maintenanceTrigger: world-period
```

检索打分与 M1 相同，再加不超过 `jitter` 的确定性扰动（随机源 `rngFor(runSeed, "recall-jitter", agentId, String(worldTick), String(agentTurnIndex))`）。每日整理先做规则段（与 M1 相同，另加：别人做出的非正式承诺过期未兑现时，写一条 `inference` 经历“X 没有兑现……”），再做模型段；模型段失败时保留规则段结果，`derivedThroughSeq`/`derivedThroughTick` 只在两段都成功（或该 Agent 当天不需要模型段、或模型段被配置关闭）时推进。

### 11.9 检索查询与自报要点

runtime 从触发构造 `MemoryQuery`：

- `counterpartIds`：触发观察的说话人、发送者、提案人、邀请人、提问人，以及 `subjectRef` 涉及的当事人。
- `queryTags`：触发观察的标签（11.2 节的词表），再加 `lexicons.memoryQueryTags` 中出现在触发文本里的词对应的标签。
- `queryText`：触发观察的摘要文本（M2 用于二元组相似度）。
- `nodeId`、`purpose`、`audience`、`budget`（条数与 token 上限来自 profile）。

`recordUse` 对 `noteworthy` 的裁决（M0 忽略；M2 只把它们作为普通观察流记录写入）：

| kind | 条件 | 写入 |
|---|---|---|
| `promise-by-other` | `sourceRefs` 都是本 turn 的输入观察，且 `aboutId` 是其中一条观察的说话人 | 非正式承诺（L4，义务人为 aboutId） |
| `promise-by-me` | `sourceRefs` 合法 | 非正式承诺（L4，义务人为自己） |
| `claim` | `sourceRefs` 合法 | `reported-claim` 记录（M1 写为经历，M3 写为 L3 看法候选） |
| `request` | `sourceRefs` 合法 | 短期经历 |

不满足条件的条目丢弃，原因写进 turn 的 effective 记录。非正式承诺永远不会成为世界合同，也不会被规则结算。
