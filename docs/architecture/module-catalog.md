# 全职能模块目录与默认装配

> 本文维护模块 ID、能力、实例作用域与默认装配规格。交付进度见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。参见 [modules.md — 模块边界](modules.md)、[plugins.md — 插件机制](plugins.md)、[composition.md — 装配冻结](composition.md)。

## 1. 目录、装配、profile 不是一回事

| 层 | 回答的问题 | 例子 |
|---|---|---|
| module catalog | 这个版本有哪些可信模块可用？ | `agent.memory.ledger` 提供 `agent.memory` 能力 |
| module assembly | 本次部署/run 激活哪些实现、绑定到哪些能力、各自配置是什么？ | `local-slg-standard-v1` 选择 SQLite 存储、受控时钟、PixiJS 渲染 |
| Agent profile | 某个 Agent 的认知策略子配方是什么？ | 岑雁使用 `memory.ledger`，乔述使用 `memory.stream-reflection` |
| 运行清单 manifest | 实际解析后的冻结组合是什么？ | 每个模块 ID/版本/config hash、每主体 memory 版本、模型路由 |

catalog 是货架，assembly 是本次装机清单，profile 是 Agent 的策略子配方。三者都由宿主校验并冻结，不能由模块自行修改。

现行 TypeScript 装配分三个运行域（realm）：`server`、`client`、`console`。同一 assembly 同时声明三域选择；浏览器域只能拿到本域模块与远端能力描述，不拿到 Node 对象、数据库连接或密钥，详见 [双端拓扑](two-endpoints.md)。

## 2. 命名、类别与实例作用域

- moduleId：`<group>.<family>.<impl>`。server 域使用职能族前缀 `game`/`agent`/`platform`/`transport`（realm 由描述符声明为 `server`），浏览器域使用 `client`/`console` 前缀；如 `game.clock.controlled`、`client.hud.standard`。
- 包目录与 moduleId 不是一一映射：同一包可承载同一能力的多个替换实现，每个实现各自注册 moduleId。例如 `@world-prism/mod-game-scenario-watergate` 同时提供 `game.scenario.watergate` 与升级节奏变体 `game.scenario.watergate-escalating`，两者共享实现与聚合，只在节奏与压力订阅上不同；装配按 moduleId 选择其一。多实现包在描述符中用 `sourceModuleId` 指向共享源码包，目录与 capability 对账据此识别。
- capability：`<group>.<family>`，如 `game.clock`、`agent.memory`。恰好一个分隔点；group 取 `game`/`agent`/`platform`/`transport`/`client`/`console` 之一，family 只含小写字母、数字与连字符。该语法由公共契约的 `capabilityIdSchema` 唯一强制，`defineModule`、`defineBrowserModule` 与 `pnpm check:catalog` 的源码对账共用同一条正则：描述符阶段直接拒绝非法 ID，源码里在端口取用位置写下带 group 前缀却不合语法的字符串会报 `capability-invalid`，不再被静默跳过。一个能力由一个或多个模块提供，由装配决定。
- realm：`server`、`client`、`console`。跨域只能通过版本化 HTTP/WS 协议。
- kind：
  - `service`：提供独占能力，返回计划/查询/决策，不自行提交世界。
  - `contributor`：向扩展点贡献条目（工具、事件卡、UI 页面、slot 视图、订阅），可并存。
  - `adapter`：对接外部技术（SQLite、模型 HTTP、PixiJS、HTTP/WS），把第三方类型关在适配器内。
- instanceScope：`deployment`、`run`、`branch`、`agent`、`session`。它决定实例生命周期与状态命名空间，不改变能力语义。有状态实例仍带 `worldId/branchId/agentId` 状态 scope，例如 memory 实例按 run 的 branch + agent 隔离，不能因为 instanceScope=agent 就跨 branch 共享。
- 装配 strictness：`required` 表示缺少即拒绝启动；`default` 表示默认装配包含，但可显式替换或移除；`optional` 表示缺失时显式降级。

模块版本（`version`）、契约版本（`apiVersion`）、状态版本（`stateSchemaVersion`）分别管理，不能用一个版本号代替。

模块描述符的 `requires` 同时约束三处：实例创建时注入的端口、规则处理器拿到的端口视图、`pnpm check:catalog` 对源码实际访问能力的对账。处理器访问未声明的能力会立即失败，不会到特定 tick 才暴露缺失端口。

## 3. 宿主固定能力不属于本目录

下列机制是“主机框架”，由宿主实现且不可被模块绕过；它们的 provider 可以换成模块（如授权策略、存储、观测、预算），但调用位置、顺序与不变量不可选：

- 模块注册、能力图解析、冲突检测、生命周期与 slot 所有权；
- 命令网关、事务边界、幂等、版本、租约与 fencing；
- 最终权限、预算、协议与受众校验；
- 证据信封与 trace 关联协议；
- agent turn 管线、预算、租约与证据协调；
- 配置解析、冻结 manifest 与 requested/resolved/effective 记录；
- 本地双端和三运行域的[信任边界](two-endpoints.md)；
- 密钥只存在于服务端 secret 解析路径。

详见 [模块边界](modules.md) 第 2 节与 [插件机制](plugins.md) 第 6 节。把授权或提交改成“可关闭的 hook”会破坏全部实验结论。

## 4. 服务端模块

### 4.1 游戏职能

| 模块 ID | 类别 | 实例作用域 | 提供能力 | 拥有状态 | 说明 |
|---|---|---|---|---|---|
| `game.world.slg-light` | service | run | `game.world` | campaign、指标、角色/队伍/群体的世界状态、委托、证据位置 | 首个轻数值实现；处理 `campaign.start`、水闸政策与每日结算；替换即改变规则语义，必须新 run |
| `game.map.six-nodes` | service | run | `game.map` | 受控道路状态、通行许可；静态六节点地图来自内容包 | 地图数据属内容包，模块负责路径与可达查询语义 |
| `game.clock.controlled` | service | run | `game.clock` | `worldTick`、运行/暂停/单步状态 | 实时映射与受控 tick 是同模块的运行模式，不是两套时钟 |
| `game.resources.light` | service | run | `game.resources` | 库存点数量与预留 | 只返回变更计划，不自行扣减 |
| `game.actions.standard` | service | run | `game.actions` | 任务与邀请 | 运输、护送、救援、修复、侦察的结算 |
| `game.agreements.standard` | service | run | `game.agreements` | 协议、条款状态 | 正式协议真值与主观承诺分开；章节终点调用世界模块的章节评估并传入截至当前 tick 的协议计数 |
| `game.comms.standard` | service | run | `game.comms` | 会话、消息投递、知识授权 | 对话、消息、广播、证据分享与 `speech.commit` |
| `game.scenario.watergate` | service | run | `game.scenario` | 剧情卡状态 | 序章卡片按内容包的 `atTick` 触发；草稿不可感知，发布后走标准命令 |
| `game.scenario.watergate-escalating` | service | run | `game.scenario` | 同上 | 模块替换演示用的第二实现：同一份卡片，节奏加快并带额外压力（[内容包](../game/content-pack.md) 第 9 节） |
| `game.save.sqlite` | service | run | `game.save` | 快照记录 | 静默、分支复制与恢复预检（[存储](storage.md) 第 3 节）；通过 `platform.storage` 读写；检查点 tick 与事件前沿取宿主绑定时注入的查询（时钟端口与 authority），不进 `requires`；宿主只经 module-sdk 的 `SavePort` 使用 |

`game.scenario.*` 两个实现对同一 capability 只能选一个；替换它们只改装配绑定，客户端、Agent 与其他游戏模块的代码都不改。

默认假设单玩家、单权威世界；替换以上任意游戏模块时，客户端、感知、工具都只依赖 capability 契约，不 import 具体实现。若规则版本变化导致旧存档语义不兼容，必须显式迁移或新分支，不能静默重解释。

### 4.2 Agent 认知与行为

| 能力 | 默认实现 | 首版还要交付 | 后续实验轴（D 阶段，首版不做） | 实例作用域 | 配置拥有者 |
|---|---|---|---|---|---|
| `agent.perception` | `agent.perception.local` | — | `agent.perception.briefing`、`agent.perception.attention` | agent | 场景/Agent profile |
| `agent.memory` | `agent.memory.ledger` | `agent.memory.none`、`agent.memory.stream-reflection`、`agent.memory.layered-hybrid` | — | agent | Agent profile / variant patch |
| `agent.context` | `agent.context.ordered-blocks` | — | `agent.context.task-centered` | agent（无持久状态） | Agent profile |
| `agent.compression` | `agent.compression.window` | `agent.compression.none` | `agent.compression.structured`、`agent.compression.summary` | agent（无持久状态） | Agent profile |
| `agent.tool-view` | `agent.tool-view.structured` | — | `agent.tool-view.full`、`agent.tool-view.brief` | agent（无持久状态） | Agent profile |
| `agent.decision` | `agent.decision.model` | `agent.decision.deterministic`（测试/CI 与可重复对照） | — | agent | Agent profile + 模型挂载 |
| `agent.scheduling` | `agent.scheduling.fair` | — | `agent.scheduling.priority-cooldown` | run | 场景 profile |
| `agent.model-pool` | `agent.model-pool.shared` | — | 独立评估用 `agent.model-pool.isolated` | deployment | RunSpec 模型布局 |
| `agent.tools` | `agent.tools.game-tools` | — | 按工具族拆分的 contributor | deployment | roster toolset/binding |

`agent.runtime` 不在目录中。turn 管线、预算、租约、证据和会话边界是宿主固定机制。上表的默认项用于 [首版目标装配](#8-默认装配)。参见 [memory.md — 记忆](../agent/memory.md)、[evaluation.md — 评估](../platform/evaluation.md)。

下文与 Agent 专篇中的 `memory.ledger`、`perception.local`、`context.ordered-blocks` 等是本表 `agent.<family>.<impl>` 的简写；冻结 manifest 与 trace 必须记录完整模块 ID，不能只写简写。

首版要求交付 memory 的四个实现（M0 到 M3），以及上表“首版还要交付”一列；“后续实验轴”一列在首版不实现，也不出现在首版的 catalog 显式登记里。

### 4.3 平台与适配器

| 模块 ID | 类别 | 实例作用域 | 提供能力 | 说明 |
|---|---|---|---|---|
| `platform.access-policy.roster` | service | deployment | `platform.access-policy` | 主体、目标、动作、报告范围裁决；默认由 roster/职责数据驱动 |
| `platform.budget.standard` | service | deployment | `platform.budget` | run/Agent/turn/维护任务预算与用量账本 |
| `platform.storage.sqlite` | adapter | deployment | `platform.storage` | 单写者 SQLite、事务、WAL、备份；第三方类型不外泄 |
| `platform.observability.sqlite` | service | deployment | `platform.observability` | trace、artifact 引用、查询与脱敏；证据契约固定 |
| `platform.evaluation.standard` | service | run | `platform.evaluation` | 审计重放、开环重决策、闭环运行、指标与报告 |
| `platform.operations.standard` | service | run | `platform.operations` | 暂停/快照/恢复、席位交接、内容发布与补偿操作 |
| `platform.module-admin.standard` | service | deployment | `platform.module-admin` | catalog 快照、装配预检、diff、冻结与更换流程 |
| `platform.secrets.env` | adapter | deployment | `platform.secrets` | 只向服务端适配器解析 credentialRef，浏览器永远拿不到 |
| `platform.model-transport.openai-compatible` | adapter | deployment | `platform.model-transport` | Chat Completions 协议（DeepSeek、Kimi、通义、Ollama、vLLM 等）；映射见 [模型传输](../agent/model-transport.md) 第 3 节 |
| `platform.model-transport.anthropic` | adapter | deployment | `platform.model-transport` | Anthropic 官方 SDK 的 Messages API；映射见 [模型传输](../agent/model-transport.md) 第 4 节 |
| `platform.model-transport.deterministic` | adapter | deployment | `platform.model-transport` | CI/测试用确定性响应，不产生外部费用；只出现在测试装配 |
| `transport.http-ws.fastify` | adapter | deployment | `transport.http-ws` | HTTP 命令/查询与 WebSocket 投影 |

`platform.model-transport` 的基数是 `many`：模型布局里每个 connection 用 `adapterId` 指定一个已装配的传输适配器。标准装配同时装 `openai-compatible` 与 `anthropic`；`deterministic` 只出现在测试装配，预检拒绝它与真实适配器出现在同一装配里，以免测试响应混进真实实验。

`run`/`branch`/`manifest` 生命周期由服务端宿主（`apps/server/src/host`）协调，不属于可替换能力；`packages/experiment` 只加载并交叉检查内容包、配置与实验规格；评估协议、runner 与报告由 `platform.evaluation.standard` 模块提供。适配器只做技术转换；语义失败（未知 schema、不支持的输出协议、缺 usage）必须显式返回，不能吞掉或伪造成功。

## 5. 客户端模块

本节登记现行网页玩家端的 TypeScript provider。Godot 玩家端随客户端发布独立的能力与绑定，见 [client-and-rendering.md — Godot 原生玩家端](client-and-rendering.md#9-godot-原生玩家端)。

客户端是玩家域，只消费授权投影，不持有世界权威与密钥。默认装配如下；slot 名称与客户端宿主一致，见 [客户端与场景适配](client-and-rendering.md)。

| 模块 ID | 类别 | 实例作用域 | 提供能力/贡献 | 必需性 | 说明 |
|---|---|---|---|---|---|
| `client.world-view.standard` | service | session | `client.world-view` | required | 网络投影 reducer，合并快照/增量与游标 |
| `client.scene-renderer.pixi` | adapter | session | `client.scene-renderer`（`scene` slot） | required | 现行网页的 2.5D 等距灰盒 |
| `client.scene-renderer.null` | adapter | session | `client.scene-renderer` | 仅测试装配 | 不绘制画面，只记录收到的场景视图，用于 CI 跑规则场景 |
| `client.camera.standard` | service | session | `client.camera` | required | 平移/缩放/跟随，不读世界库 |
| `client.screen-projection.isometric` | service | session | `client.screen-projection` | required | 世界坐标与屏幕坐标互转、命中转换 |
| `client.input.standard` | service | session | `client.input` | required | 点选、移动、交谈意图转为 command |
| `client.hud.standard` | contributor | session | `client.hud`（`hud` slot） | required | 局势、资源、任务、承诺与时钟状态，文字与数值完整显示 |
| `client.hud.compact` | contributor | session | `client.hud`（`hud` slot） | 替换演示（目标，尚未实现） | 第二实现：只显示图标与等级，可折叠；与 standard 二选一 |
| `client.dialogue.standard` | contributor | session | `client.dialogue`（`dialogue` slot） | required | 已提交对白、证据卡、提案入口 |
| `client.faction-start.standard` | contributor | session | `client.faction-start`（`boot.screen` slot） | required（新 campaign） | 席位开局选择与初始化确认；本切片只开放公社席 |
| `client.characters.standard` | contributor | session | `client.characters`（`sidebar` slot） | default | 人物册、公开主张、已知经历 |
| `client.settings.standard` | contributor | session | `client.settings`（`settings.section` slot） | default | 语言、显示、声音、镜头、输入、图形、暂停/保存；测试 preset 申请入口 |
| `client.notifications.standard` | contributor | session | `client.notifications`（`notification` slot） | default | 紧急任务、承诺到期、邀请、公共消息 |
| `client.audio.standard` | contributor | session | `client.audio` | D 阶段 | 声音反馈；首版不实现 |
| `client.debug-overlay.research` | contributor | session | `client.debug-overlay`（`overlay` slot） | D 阶段 | 研究/测试开关；首版不实现 |

玩家设置只改变展示与输入表达；暂停/保存/恢复仍走服务端 campaign API（`game.clock`、`game.save` 与 `platform.operations` 协作），不是客户端本地状态。测试 preset 只能申请新 run/branch，不能热改在线世界；`client.faction-start.standard` 始终装配：已有 campaign 时它不渲染任何内容。

## 6. 控制台模块

控制台由服务端在同一 `:3000` 端口提供静态资源，运行在浏览器 console realm，通过授权 API 操作服务端能力。控制台页面由模块贡献，不是服务端业务代码的一部分；登录、会话与面板布局属于 console 宿主壳，不在页面模块目录中；隐藏页面不等于鉴权。

| 模块 ID | 贡献页面/面板 | 依赖的远端能力 | 默认角色 | 说明 |
|---|---|---|---|---|
| `console.health.standard` | 运行总览 | `platform.observability`、`platform.operations` | operator/researcher | 端口、模块 readiness、水位、预算、失败 |
| `console.module-admin.standard` | 模块目录与装配 | `platform.module-admin` | operator/researcher | 查看 catalog、装配 diff、预检、更换计划 |
| `console.model-mounts.standard` | 模型池与挂载 | `agent.model-pool` | operator/researcher | connections/models/mounts、批量挂载、能力验证 |
| `console.faction-ops.standard` | 三势力运营席位 | `platform.operations`、`game.clock` | operator | 三个非人类势力 agent/human、暂停/单步/快照 |
| `console.scenario-editor.standard`（目标，尚未实现） | 事件卡与剧情 | `game.scenario`、`platform.operations` | operator | 草稿、预演、发布、撤回、补偿与污染标记 |
| `console.observability.standard` | 可观测 | `platform.observability` | researcher | 世界时间线、Agent 检查器、请求/响应、记忆 diff、分支对比 |
| `console.observability.lite`（目标，尚未实现） | 可观测（精简） | `platform.observability` | researcher | 替换演示用第二实现：只有 turn 列表与单个 turn 详情两页，读取同一批 API；与 standard 二选一 |
| `console.evaluation.standard` | 可评估 | `platform.evaluation` | researcher/evaluator | run 创建、指标、报告、判定与失败分母 |
| `console.debug.standard` | 可调试 | `platform.observability`、`game.clock` | researcher | 有界单步/重放、预算与队列、注入与定位工具 |
| `console.audit.standard`（目标，尚未实现） | 审计与导出 | `platform.observability` | researcher | 按权限脱敏导出与保留策略 |

角色只是默认最小权限；具体 API 仍需服务端会话与资源 scope 校验。控制台模块不得把模型密钥、原始秘密或全知 trace 带给玩家域。

表中页面模块默认都是 `contributor`、实例作用域 `session`，默认装配为 required。可按部署把非关键页面降为 optional，缺失时控制台导航显示不可用并说明原因，但服务端对应能力与权限校验仍存在。

## 7. 能力基数与冲突规则

| 情形 | 处理 |
|---|---|
| 一个 capability 恰好需要一个 provider | 装配必须解析出唯一实现；两个默认实现冲突则预检失败 |
| 一个 capability 允许多个 contributor | 各贡献必须带稳定 ID 与排序；ID 冲突或不可比较顺序拒绝启动 |
| 一个 capability 有 fallback | fallback 必须是显式声明、有触发条件、有预算且写入 effective 记录；不能按注册顺序静默选择 |
| 必需能力缺失 | 该 realm 拒绝进入 ready；不允许“先启动再补”。各宿主的必需能力：server 为全部 `game.*`、`platform.storage`、`platform.secrets`、`platform.access-policy`、`platform.operations`、`platform.observability`、`platform.module-admin`、`transport.http-ws`；装配含 `agentSlots` 时再加 `agent.scheduling`、`agent.tools` 以及 `agentSlots` 中各模块 `requires` 的能力；client 为 `client.world-view`、`client.scene-renderer`、`client.camera`、`client.screen-projection`、`client.input`、`client.hud`、`client.dialogue`、`client.faction-start`；console 没有必需页面 |
| 可选 UI/页面缺失 | 导航与 slot 显示不可用原因；不影响服务端权威 |
| 同一模块 ID/version 两个实现 | 拒绝注册；模块升级必须新 version 与新装配 |
| 跨 realm 提供能力 | 拒绝；浏览器只能 `requiresRemote`，由握手与角色校验 |
| profile 选择目录外实现 | 预检失败；不能通过任意 JSON 绕过 schema |

能力依赖无环；解密、存储、观测等底层 provider 不能被上层模块隐式替换。装配解析顺序与冻结见 [积木组合](composition.md)。

## 8. 默认装配

`config/assemblies/local-slg-standard-v1` 是本仓库目标默认装配，三个 realm 同时冻结：

| realm | 选择 |
|---|---|
| server | 4.1 中除 `game.scenario.watergate-escalating` 以外的游戏模块、4.2 的默认实现、4.3 平台模块与适配器（model-transport 为 `openai-compatible` 与 `anthropic`） |
| client | 5 章 `required` 与 `default` 模块（HUD 为 `client.hud.standard`） |
| console | 6 章全部页面模块（可观测页为 `console.observability.standard`） |

测试装配使用 `client.scene-renderer.null` 做无画面回归。当前 server 与浏览器绑定见 [标准装配](../../config/assemblies/local-slg-standard-v1.yaml) 与 [测试装配](../../config/assemblies/local-slg-test-v1.yaml)。模型布局与名册由 RunSpec 或环境变量选择。完整首版的装配规格见 [configuration.md — 完整配置文件](../platform/configuration.md#10-完整配置文件首版)。

M 阶段的四次替换演示各自只改一处绑定：`game.scenario` 换成 `game.scenario.watergate-escalating`；`client.hud` 换成 `client.hud.compact`；`console.observability` 换成 `console.observability.lite`；Agent profile 的 memory 槽在 M0–M3 之间切换。

装配文件只选择模块与配置引用，不复制 roster、模型参数或世界内容。RunSpec 通过 `moduleAssemblyRef` 选择装配，并同时选择 world pack、scenario、roster、model layout 与 toolsets，见 [配置](../platform/configuration.md)。

默认装配中的 `agent.memory.ledger` 只是为了让在线游戏开箱可玩。实验 run 不能依赖模块默认值：M0 到 M3 都必须由 variant patch 显式引用 preset（`memory-m0-window`、`memory-m0-current`、`memory-m1-structured-ledger`、`memory-m2-stream-reflection`、`memory-m3-layered-hybrid`），manifest 记录 preset ID 与解析后的完整参数；不能拿“默认装配选了 ledger”当作某组已经验证。

## 9. 替换与新增矩阵

| 想改变什么 | 只需改什么 | 不应改什么 | 验收证据 |
|---|---|---|---|
| 记忆算法 | memory 模块 + profile/variant + 显式 catalog 登记 | runtime、世界规则、客户端 | 同输入下实际入模差异与行为差异 |
| 上下文排列/预算 | context 模块 + profile | memory 检索集合、模型路由 | context artifact 段序与 token 报告 |
| 压缩或工具视图 | compression/tool-view 模块 + profile | 原始工具结果、世界状态 | 原件/视图 hash 与状态一致性 |
| 地图或通行规则 | `game.map` 模块 + 内容 pack | 客户端坐标、renderer | 同一 command 的路径与可达结果 |
| 时钟/暂停策略 | `game.clock.controlled` 模块 + 装配 | 世界事实、模型耗时统计 | 受控 tick 脚本重放一致 |
| 剧情推进 | `game.scenario.watergate` 模块或内容 pack | 世界权威、已发布历史 | 草稿不可感知、发布幂等、补偿可追 |
| 玩家 HUD | `client.hud.standard` 模块 | 服务端投影、世界结果 | 同 command 结果 + UI 截图/交互记录 |
| 场景渲染器 | `client.scene-renderer.pixi` 模块 | 规则、投影、输入契约 | 无渲染 adapter 跑同一场景 |
| 控制台观测页 | `console.observability.standard` 模块 | trace 生成与证据契约 | 同一 traceId 可查、权限不串 |
| 存储/模型传输 | adapter 模块 + 迁移 | 业务 port 与语义 | 事务/重试/未知 usage 仍可定位 |
| 新增共享工具 | `agent.tools.game-tools` contributor + binding | 其他 Agent executor | 一次实现多处注册、越权被拒 |

新增模块的最小修改面是：模块自身、显式 catalog import、assembly/profile 配置、对应测试与文档。若需要修改与该能力无关的模块实现，说明公共 port 不足，应先评审契约升级，而不是加 `any` 或万能上下文。

## 10. 目录守门与验收

`check:catalog` 扫描 `config/assemblies/*.yaml`，并用与宿主启动相同的 kernel 解析器逐装配执行：

- 模块 ID 与能力名唯一、版本与 apiVersion 相容（不在受支持 apiVersion 集合中的模块在装配解析阶段拒绝）、配置 schema 严格、未知字段拒绝；配置 schema 对自身输出幂等，逐装配解析出的配置与每个模块的默认配置都核对；
- realm/kind 白名单、能力命名空间与绑定匹配；
- 能力闭包：必需能力均有 provider；无缺失依赖、无环，提供者先于消费者的拓扑顺序；
- 实例作用域兼容、重复绑定检测；
- 模块配置 schema 校验，包含宿主并入部署参数后的有效配置；
- 真实目录中 server 必需能力与 `local-slg-*` 主装配均通过。

以下仍是后续验收项：

- fallback 声明完整；slot ID 与排序冲突可检测；
- realm 边界：client/console 模块不得 import 服务端实现或读取密钥；只有 transport 端口可跨域；
- 状态所有权：每个有状态模块声明 scope、schemaVersion、导出/迁移路径；
- 服务端目录与装配的 hash 进入 run manifest。验证注册顺序不改变解析结果。

验收时必须展示：

- 替换矩阵中游戏规则、客户端 UI、Agent 认知、控制台页面四类各换一次，只改模块、装配与配置；
- 缺必需模块时启动被拒绝；
- 卸载可选模块后无残余订阅；
- 按 [部署规格](two-endpoints.md) 核对本应用监听范围。
- 服务端组合使用冻结 manifest 复算。TypeScript 浏览器模块集与 Godot provider 各按会话装配记录核对。 [冻结清单与实际生效](../platform/configuration.md#7-冻结清单与实际生效)

具体装配语义见 [积木组合](composition.md)，交付顺序见 [路线与验收](../delivery/roadmap-and-acceptance.md)。
