# 全平台模块装配、设置与冻结清单

> 目标规范。配置对象关系、生效边界和双端设置工作流以本文为准。可替换单元覆盖游戏、Agent、平台服务、客户端、后台视图和适配器；module 不是 memory 的别名。

## 1. 配置对象与所有者

| 对象 | 负责什么 | 规范拥有者 |
|---|---|---|
| module catalog | 可用 ModuleDefinition、版本、能力、生命周期 | architecture/module-catalog 与 plugins |
| module assembly | 三 realm 当前选择哪些职能实现、能力绑定、参数与依赖连接 | architecture/composition 与本文 |
| world pack | lore、地图、规则数据、角色、局势版本 | game 与 events-and-state |
| roster | 激活身份、profileRef、toolsetRef | game/characters |
| Agent profile | 组合内某类 Agent 的策略子配方、预算 | agent 专篇与 composition |
| connections/models | 供应商连接、模型能力、参数和资源限额 | agent/model-pool |
| mounts | modelId + agentIds + purposes | agent/model-pool |
| toolsets/bindings | 共享 ToolDefinition 引用与调用限制 | agent/tools |
| player preferences | 语言、声音、镜头、通知等纯展示偏好 | 客户端 settings module |
| player test preset entry | 展示获准装配摘要并申请新 run/branch | 客户端 settings 申请入口与服务端预检 |
| console layout/roles | 控制台页面贡献、默认角色与面板布局 | console 模块与 two-endpoints |
| RunSpec / resolved manifest | 选择上述版本与初态 / 完整冻结解析结果 | 本文与 evaluation |

ModuleDefinition 是 TypeScript 运行域的统一注册描述符；模块私有 configSchema 随自身描述符，新增私有参数不牵动共享契约。公共 DTO/port/schema 归 contracts。

## 2. 全平台装配与 Agent 子配方

RunSpec 的 `moduleAssemblyRef` 选择 TypeScript 装配。Godot 玩家端的本地 provider 由客户端发布物装配。验收按 [composition.md — Godot 会话装配证据](../architecture/composition.md#godot-会话装配证据) 记录实际绑定和配置来源。Agent profile 只描述主体策略子配方，不能暗中决定整个世界的地图、时钟、持久化或 UI 实现。assembly 文件分 `server`、`client`、`console` 三段。浏览器 host 连接后通过 `GET /api/v1/session/assembly?realm=...` 取得本域的 resolved 模块清单，再验证本地可信 catalog；不满足则拒绝 ready，见 [两个本地端口](../architecture/two-endpoints.md)。

Agent profile 的装配顺序为平台基线、场景 profile、可复用 Agent profile，最后是实验 variant patch。全平台 assembly 变体也必须声明改变的模块、连接与参数，不能靠扫描顺序覆盖；具体模块引用和 cardinality 以 [组合规范](../architecture/composition.md) 为准。

配置块与数组都整体替换，不隐式深合并。defaults 只填 schema 明确允许省略的字段。未知 ID/字段、错误单位、重复定义、不兼容 port、依赖环、必需能力缺失、冲突 provider 均拒绝预检；不静默选第一个实现。

models/mounts 由 modelLayoutRef 集中选择，Agent profile 不能隐式覆盖。roster 不嵌 provider/model/credential，mounts 不覆盖人格或权限。purposes 为 decision、speech、memory-maintenance、compression、embedding；evaluation 使用独立 evaluator，不进入 gameplay mounts。

## 3. RunSpec 目标示例

~~~yaml
schemaVersion: 1
id: watergate-memory-ledger
moduleAssemblyRef: local-slg-standard-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: standard-15
modelLayoutRef: shared-model-layout-v1
seed: run-seed-001
player:
  principalId: player-1
  factionId: human-neutral
mode: closed-loop
initialState:
  kind: snapshot
  snapshotRef: watergate-common-start
variant:
  id: structured-ledger
  profilePatchRefs: [memory-m1-structured-ledger]   # applied in order after the agent profiles
  agentIds: null            # null = every agent in the roster
script:
  scriptRef: s-promise      # optional; drives external inputs in audit/open-loop/closed-loop modes
  branch: keep
clock:
  kind: controlled
budget:
  maxTokens: 2000000
  maxCost: null
failurePolicy: strict
~~~

这是目标格式，引用内容与模块必须在实现时实际存在并通过 schema 与能力校验。clock.kind 表示所选时钟模块声明支持的运行模式，不会因此切到另一套隐式时钟实现。对 console/UI 贡献的选择也进入 assembly 版本，不能靠隐藏的硬编码菜单补足缺模块。

每个新实验 run 独占 branchId，不允许指定复用活动分支。mode 取 live、audit、open-loop 或 closed-loop：live 接收自由玩家输入，后三者分别对应评估篇的审计重放、开环重决策与闭环分支。冷启、快照、合法观察历史重建分别声明，不混用。玩家设置与 console 布局不属于 RunSpec；它们可即时生效，但不能改变 assembly、规则或世界状态。

## 4. 双端设置分工

现行网页入口为 http://127.0.0.1:5173。原生玩家端直接连接服务端。API、WebSocket 和 http://127.0.0.1:3000/console/ 共享服务端监听，见 [原生部署目标](../architecture/two-endpoints.md#原生-demo-部署目标)。

| 入口 | 功能模块提供的设置 | 不允许的操作 |
|---|---|---|
| 玩家设置 | 显示/语言、声音、镜头、输入辅助、暂停/保存 | 密钥编辑、全知视角、直接热换运行中 provider |
| 网页玩家端测试 preset 申请（目标） | 展示获准的装配摘要并提交新 run/branch 申请 | 直接改变当前 run、跳过预检 |
| 服务端模块装配（`:3000/console`） | 全平台 module 选择、依赖/能力、配置 diff、生命周期与迁移计划 | 绕过最终 guard、静默卸载必需能力 |
| 服务端模型池（console） | 连接别名、模型配置、能力验证、批量挂载 | 向玩家下发 credentials、逐 Agent 复制模型参数 |
| 服务端剧情运营（console） | 三个非人类势力席位、事件卡、世界时钟/存档 | 修改已发布历史而不留记录 |
| 服务端研究（console） | trace/请求响应、评估、重放、断点/单步和故障定位 | 调试真值自动进入角色知识 |
| 控制台宿主壳（console） | 登录、角色切换、面板布局，由 console 宿主提供 | 因本机访问跳过鉴权；用隐藏菜单替代授权 |

业务页面由 console 类模块贡献到后台宿主的 route/panel/action slots；登录、会话与布局属于宿主壳。替换面板不改变对应 runtime provider。前端和服务端分别校验自身依赖，浏览器视图只能经 API 消费服务端能力，不直接实例化数据库或 model 模块。

## 5. 模型、工具与角色设置

先定义 connections/models，再在模型卡片下勾选多个 Agent 和 purposes。UI 同时提供两个视图：从模型看挂载主体，从角色看已解析模型。移走某主体的用途后再新增挂载；重复键不靠后者覆盖。

Agent 策略参数、游戏规则模块参数、剧情策略、调度参数、存档与感知参数，都从对应 ModuleDefinition.configSchema 生成表单和帮助；调度参数属 run 作用域，由场景 profile 配置。通用表单无法表达时可贡献专有编辑器，但提交仍用相同 schema 校验。

ToolDefinition 实现只登记一次，toolset/binding 引用定义并收窄能力；工具面板展示 effective permissions 与 viewConstraints。切换 UI 不得改执行权限，编辑 binding 不能将角色提升为势力控制器。

公社单席开局（设计支持五席）与 roster preset 在新 campaign 或明确的分支边界处选择。standard-15 是序章完整 roster，core-3 仅用于开发与诊断，不能把关闭面板等同于主体未激活。

## 6. 预检和预览

1. 校验单玩家、内容引用、15 个 gameplay 身份的总配额和正式世界的唯一别名；按[部署规格](../architecture/two-endpoints.md)核对本应用的监听端口。
2. 解析 TypeScript 装配，检查模块、版本、能力基数、依赖图和摘要。服务端与控制台的必需能力按各自契约检查。
3. 对现行网页部署校验 client 和 console 的 slot、必需能力及远端依赖。原生部署仅允许浏览器玩家模块集为空。Godot 客户端的能力与绑定在自己的组合根预检。 [三域装配与握手](../architecture/composition.md#3-三-realm-装配与握手)
4. 解析 Agent profile、模型挂载和工具 binding；缺用途、能力不兼容、超模型窗口或越权约束均拒绝。
5. 校验世界/观察/记忆 frontier、状态 schema 与迁移路径；不能换 provider 后清库冒充成功。
6. 校验预算、任务/监听/人数配额、持久化和必需 artifact 可用；所有资源先预留后激活。
7. 展示 requested/resolved diff、影响主体、realm、必需停止项、迁移/回滚计划和预计调用预算，用户能看懂究竟换了哪块积木。

纯 dry-run 不创建活动主体、不改世界、不发模型请求；连通性探测为独立、有预算且留痕的测试。缺依赖的可选 UI 可显示不可用；缺必需 runtime provider 不能进入 ready。

## 7. 冻结清单与实际生效

服务端冻结 manifest 记录种子、运行规格引用、内容包与版本、服务端模块及配置摘要、服务端 catalog 和 assembly hash、名册及适用的 Agent 和模型配置。TypeScript 浏览器端的各域摘要由会话装配返回。Godot 单独保存 [会话装配证据](../architecture/composition.md#godot-会话装配证据) 并与服务端回执关联。三类证据分别核验，历史 TS 存档按其原有服务端冻结记录复算。

requested 是用户选择，resolved 是装配解析，effective 是本阶段实际使用。effective 与 applied/skipped/failed 在运行证据中追加，不回写覆盖 manifest；只记录模块名字不足以重建组合。

界面必须显示“当前运行”“草稿”“下个运行生效”和配置来源。观测面板被隐藏不代表观测 provider 未运行；也不能因为 registry 有模块就声称本次经过了它。

## 8. 生效、替换与迁移

纯展示偏好可即时生效且不改变运行组合。更换任何功能实现、依赖连接、模型挂载、规则/内容版本或工具权限时，先准备新 assembly、run 或后继 branch，再依次执行：暂停并 fence、做快照、排空或导出、显式迁移或重建，最后预检通过后再切换。不得把草稿保存当热更新成功。

必需 provider 不可直接拔除：要么拒绝卸载，要么先显式停止并解除整个组合的依赖。可撤销注册并不承诺任意状态都兼容，drain/dispose 与跨进程 UI 卸载分别留记录。

密钥轮换可保持 credentialRef，记录修订，不入 manifest 明文；供应商后台变化仍可能破坏可比性，因此要记录可获得的模型指纹或请求标识。

## 9. 验收

换一项游戏规则、存档、镜头、HUD、控制台页面或 memory 实现都只修改模块自身/装配配置，无需改无关模块；UI 编辑和运行校验使用同一 schema。缺必需能力时启动/卸载都显式失败。服务端监听提供 API、WebSocket 与控制台静态资源。玩家设置无后台权限；模型批量挂载不串状态；服务端组合可按原 manifest 复算，各界面装配另按会话证据核对。浏览器页面不得因为本机访问获得服务端角色，端口/会话校验见 [两个本地端口](../architecture/two-endpoints.md)。

模块细节见 [模块边界](../architecture/modules.md)、[插件机制](../architecture/plugins.md)、[积木组合](../architecture/composition.md)、[双端口](../architecture/two-endpoints.md)。

## 10. 完整配置文件（首版）

所有配置都是 YAML，读入后用 `packages/contracts` 中的 Zod schema 严格校验（未知键拒绝）。引用（`*Ref`）先在仓库 `config/` 中查找，找不到再查控制台保存的草稿（`config_drafts`）。`env:NAME` 形式的值在预检时从环境变量解析。

> 本节示例描述首版的目标配置。实际绑定见 [config/assemblies — 装配文件](../../config/assemblies)，交付进度见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。

### 10.1 装配 `config/assemblies/local-slg-standard-v1.yaml`

```yaml
schemaVersion: 1
assemblyId: local-slg-standard-v1
configs:                         # named config blocks referenced by bindings
  clock: { secondsPerTick: 20, maxStepTicks: 24, autoPauseAfterDisconnectMs: 60000 }
  storage: { inlineArtifactMaxBytes: 65536 }
  # 此处不配置 host、端口与数据目录；服务端宿主从环境变量读取，并在启动时合并到
  # transport.http-ws.fastify 与 platform.storage.sqlite 的配置中。
  # allowedOrigins 通过宿主选项设置，未指定时使用两个本机地址：
  # http://127.0.0.1:5173 与 http://127.0.0.1:3000。
realms:
  server:
    bindings:
      - { capability: game.world,       moduleId: game.world.slg-light,      configRef: null }
      - { capability: game.map,         moduleId: game.map.six-nodes,        configRef: null }
      - { capability: game.clock,       moduleId: game.clock.controlled,     configRef: clock }
      - { capability: game.resources,   moduleId: game.resources.light,      configRef: null }
      - { capability: game.actions,     moduleId: game.actions.standard,     configRef: null }
      - { capability: game.agreements,  moduleId: game.agreements.standard,  configRef: null }
      - { capability: game.comms,       moduleId: game.comms.standard,       configRef: null }
      - { capability: game.scenario,    moduleId: game.scenario.watergate,   configRef: null }
      - { capability: game.save,        moduleId: game.save.sqlite,          configRef: null }
      - { capability: agent.scheduling, moduleId: agent.scheduling.fair,     configRef: null }
      - { capability: agent.model-pool, moduleId: agent.model-pool.shared,   configRef: null }
      - { capability: agent.tools,      moduleId: agent.tools.game-tools,    configRef: null }
      - { capability: platform.access-policy, moduleId: platform.access-policy.roster, configRef: null }
      - { capability: platform.budget,        moduleId: platform.budget.standard,      configRef: null }
      - { capability: platform.storage,       moduleId: platform.storage.sqlite,       configRef: storage }
      - { capability: platform.observability, moduleId: platform.observability.sqlite, configRef: null }
      - { capability: platform.evaluation,    moduleId: platform.evaluation.standard,  configRef: null }
      - { capability: platform.operations,    moduleId: platform.operations.standard,  configRef: null }
      - { capability: platform.module-admin,  moduleId: platform.module-admin.standard, configRef: null }
      - { capability: platform.secrets,       moduleId: platform.secrets.env,          configRef: null }
      - { capability: platform.model-transport, moduleId: platform.model-transport.openai-compatible, configRef: null }
      - { capability: platform.model-transport, moduleId: platform.model-transport.anthropic,         configRef: null }
      - { capability: transport.http-ws, moduleId: transport.http-ws.fastify, configRef: null }
    agentSlots:                  # implementations that Agent profiles may select
      perception: [agent.perception.local]
      memory: [agent.memory.none, agent.memory.ledger, agent.memory.stream-reflection, agent.memory.layered-hybrid]
      context: [agent.context.ordered-blocks]
      compression: [agent.compression.none, agent.compression.window]
      toolView: [agent.tool-view.structured]
      decision: [agent.decision.model, agent.decision.deterministic]
  client:
    bindings:
      - { capability: client.world-view,        moduleId: client.world-view.standard,         configRef: null }
      - { capability: client.scene-renderer,    moduleId: client.scene-renderer.pixi,         configRef: null }
      - { capability: client.camera,            moduleId: client.camera.standard,             configRef: null }
      - { capability: client.screen-projection, moduleId: client.screen-projection.isometric, configRef: null }
      - { capability: client.input,             moduleId: client.input.standard,              configRef: null }
      - { capability: client.hud,               moduleId: client.hud.standard,                configRef: null }
      - { capability: client.dialogue,          moduleId: client.dialogue.standard,           configRef: null }
      - { capability: client.faction-start,     moduleId: client.faction-start.standard,      configRef: null }
      - { capability: client.characters,        moduleId: client.characters.standard,         configRef: null }
      - { capability: client.settings,          moduleId: client.settings.standard,           configRef: null }
      - { capability: client.notifications,     moduleId: client.notifications.standard,      configRef: null }
  console:
    bindings:
      - { capability: console.health,          moduleId: console.health.standard,          configRef: null }
      - { capability: console.module-admin,    moduleId: console.module-admin.standard,    configRef: null }
      - { capability: console.model-mounts,    moduleId: console.model-mounts.standard,    configRef: null }
      - { capability: console.faction-ops,     moduleId: console.faction-ops.standard,     configRef: null }
      - { capability: console.scenario-editor, moduleId: console.scenario-editor.standard, configRef: null }
      - { capability: console.observability,   moduleId: console.observability.standard,   configRef: null }
      - { capability: console.evaluation,      moduleId: console.evaluation.standard,      configRef: null }
      - { capability: console.debug,           moduleId: console.debug.standard,           configRef: null }
      - { capability: console.audit,           moduleId: console.audit.standard,           configRef: null }
```

下表给出其他目标装配相对首版标准装配的差异。模块替换验收要求目录检查核对相应装配只改表中的绑定。

| 文件 | 与标准装配的差异 |
|---|---|
| `local-slg-test-v1.yaml` | model-transport 两行换成一行 `platform.model-transport.deterministic`；`client.scene-renderer` 换成 `client.scene-renderer.null`（模型布局与名册不属于装配：测试时由 RunSpec 或环境变量 `NPC_MODEL_LAYOUT=deterministic-model-layout-v1`、`NPC_ROSTER=core-3` 选择） |
| `local-slg-escalating-v1.yaml` | `game.scenario` 换成 `game.scenario.watergate-escalating`；该装配不启用 Agent 模型池，因此不装载 `console.model-mounts` |
| `local-slg-compact-hud-v1.yaml` | `client.hud` 换成 `client.hud.compact` |
| `local-slg-obs-lite-v1.yaml` | `console.observability` 换成 `console.observability.lite` |

### 10.2 profile 继承链 `config/profiles/`

解析顺序固定为 `platform-baseline` → `scene-watergate` → Agent profile → variant patch。合并规则：`slots` 按槽整块替换（不深合并），其他顶层键整键替换。RunSpec 里的 `failurePolicy` 最后覆盖 profile 中的同名字段（在线世界为 `online-fallback`，实验默认 `strict`）；variant 的 `agentIds` 不为 null 时，patch 只作用于列出的 Agent。

```yaml
# 平台基线 profile：platform-baseline.yaml
schemaVersion: 1
profileId: platform-baseline
kind: platform
parent: null
budgets:
  maxModelCallsPerTurn: 6
  maxDecisionRounds: 4
  maxToolCallsPerTurn: 8
  maxToolCallsPerRound: 3
  maxTurnMs: 90000
  maxReplans: 1
  maxTokensPerAgentPerDay: 60000
  reserveOutputTokens: { decision: 1500, speech: 400, memory-maintenance: 800 }   # budget estimate per call; settled by actual usage
readiness: { requireDurable: true, requireDerived: true, waitTimeoutMs: 120000, onlineDegradeAfterMs: 10000 }
speech: { maxChars: 80 }        # max characters of one utterance (prompts.md §4)
failurePolicy: strict
slots:
  perception:  { module: agent.perception.local, config: { visibleGraphDepth: 0, extraDelayTicks: { broadcast: 0, directed: 0, briefing: 0 }, maxObservationsPerBatch: 12, retainUncertainCues: true } }
  memory:      { module: agent.memory.ledger, config: {} }
  context:
    module: agent.context.ordered-blocks
    config:
      segmentOrder: [world, task, memory, history, input]
      historyTurns: 8
      lendUnusedBudget: false
      decision: { maxInputTokens: 8000, safetyTokens: 300, toolLoopReserveTokens: 1600, segmentBudgets: { world: 800, task: 500, memory: 1000, history: 800 } }
      speech: { maxInputTokens: 2500, safetyTokens: 200, segmentBudgets: { facts: 800, history: 400 } }
  compression: { module: agent.compression.window, config: { triggerRatio: 0.8, preserveRecentGroups: 4, targetTokenRatio: 0.6 } }
  toolView:    { module: agent.tool-view.structured, config: { maxListItems: 5, maxTextChars: 120, includeEvidenceRefs: true } }
  decision:    { module: agent.decision.deterministic, config: {} }
```

```yaml
# 场景 profile scene-watergate.yaml（按 run 作用域的设置在此）
schemaVersion: 1
profileId: scene-watergate
kind: scene
parent: platform-baseline
scheduling:
  module: agent.scheduling.fair
  config: { maxConcurrentTurns: 4, mergeLimit: 5, cooldownTicks: 1, agingPerTick: 5, agingCap: 40, patrolHour: 8 }
```

```yaml
# 角色 Agent 默认 profile：agent-character-default.yaml
schemaVersion: 1
profileId: agent-character-default
kind: agent
parent: scene-watergate
slots: {}
```

```yaml
# 战略 Agent 默认 profile：agent-strategic-default.yaml
schemaVersion: 1
profileId: agent-strategic-default
kind: agent
parent: scene-watergate
slots:
  context:
    module: agent.context.ordered-blocks
    config:
      segmentOrder: [world, task, memory, history, input]
      historyTurns: 6
      lendUnusedBudget: false
      decision: { maxInputTokens: 8000, safetyTokens: 300, toolLoopReserveTokens: 1600, segmentBudgets: { world: 900, task: 600, memory: 900, history: 600 } }
      speech: { maxInputTokens: 2500, safetyTokens: 200, segmentBudgets: { facts: 800, history: 400 } }
```

variant patch 放在 `config/profiles/variants/`，`memory` 槽的完整参数取自 [记忆](../agent/memory.md) 第 11.5–11.8 节。一个 run 可以按顺序叠加多个 patch（`variant.profilePatchRefs`），后面的 patch 覆盖前面的同名槽：

| profileId | patch |
|---|---|
| `memory-m0-window` | `slots.memory = { module: agent.memory.none, config: {} }` |
| `memory-m0-current` | 同上，并把 `slots.context` 整块替换为与 baseline 相同、只把 `historyTurns` 改为 0 的版本 |
| `memory-m1-structured-ledger` | `slots.memory = { module: agent.memory.ledger, config: <11.6 节全部参数> }` |
| `memory-m2-stream-reflection` | `slots.memory = { module: agent.memory.stream-reflection, config: <11.7 节全部参数> }` |
| `memory-m3-layered-hybrid` | `slots.memory = { module: agent.memory.layered-hybrid, config: <11.8 节全部参数> }` |
| `decision-deterministic` | `slots.decision = { module: agent.decision.deterministic, config: {} }`（工程测试用） |

```yaml
# 变体文件 memory-m1-structured-ledger.yaml（所有变体文件的形状）
schemaVersion: 1
profileId: memory-m1-structured-ledger
kind: variant
patch:
  slots:
    memory:
      module: agent.memory.ledger
      config: { }   # copy the full config block from memory.md §11.6 here
```

### 10.3 实验规格 `config/runs/*.yaml`

```yaml
schemaVersion: 1
experimentId: exp-memory-promise-v1
base:                          # a RunSpec without id, variant and script; tests use local-slg-test-v1 + deterministic-model-layout-v1
  moduleAssemblyRef: local-slg-standard-v1
  worldPackRef: earth-2964-v1
  scenarioRef: watergate-v1
  rosterRef: core-3
  modelLayoutRef: shared-model-layout-v1
  seed: exp-memory-promise-v1
  player: { principalId: player-1, factionId: human-neutral }
  mode: closed-loop
  initialState: { kind: cold-start }
  clock: { kind: controlled }
  budget: { maxTokens: 500000, maxCost: null }
  failurePolicy: strict
scriptRef: s-promise
scriptBranches: [keep, break]
commonPatchRefs: []           # applied to every run before the variant patch, e.g. [decision-deterministic]
variants: [memory-m0-window, memory-m1-structured-ledger, memory-m2-stream-reflection, memory-m3-layered-hybrid]
repetitions: 3
runOrder: rotate               # rotate the variant order on each repetition
```

实验按“变体 × 脚本分支 × 重复次数”生成 run（上例为 24 个），按顺序逐个执行；每个 run 独占一个分支。每个 run 的 `variant.profilePatchRefs = [...commonPatchRefs, 该变体]`，`seed = base.seed + ":rep" + 重复序号`（同一次重复的各变体相同，便于配对比较）。`initialState.kind` 取 `cold-start`（从内容包初态开始）、`snapshot`（引用快照）或 `rebuild`（从快照中的合法观察重建记忆，见 [记忆](../agent/memory.md) 第 9 节）。

### 10.4 玩家测试 preset `config/presets/*.yaml`

```yaml
schemaVersion: 1
presetId: memory-m0-trial
title: 体验：没有长期记忆的 NPC
summary: 从当前存档创建一个实验分支，所有角色改用 M0（只记得最近 8 句对话）。
runSpecTemplate:
  moduleAssemblyRef: local-slg-standard-v1
  rosterRef: standard-15
  modelLayoutRef: shared-model-layout-v1
  mode: live
  variant: { id: m0-window, profilePatchRefs: [memory-m0-window], agentIds: null }
  initialState: { kind: snapshot, snapshotRef: latest }
```

玩家只能提交申请；运营在控制台批准后，服务端以当前在线分支的最新快照为起点创建 run（`snapshotRef: latest`），在线世界不受影响。

### 10.5 价目 `config/pricing*.yaml`

模型布局通过可选 `pricingRef` 选择价目文件，省略时读取 `config/pricing.yaml`。`shared-model-layout-v1` 与 `claude-model-layout-v1` 使用 `config/pricing-live.yaml`，测试布局继续使用只统计 token 的默认价目。

```yaml
schemaVersion: 1
pricingVersion: "2026-11-live"
currency: USD
models:
  npc-chat:   { externalModel: deepseek-flash, inputPerMTok: 0.3, outputPerMTok: 1.2 } # DeepSeek Flash peak list price, 2026-11
  npc-claude: { externalModel: claude-opus-5-5, inputPerMTok: 4.0, outputPerMTok: 20.0 } # Claude Opus 5.5 list price, 2026-11
```
