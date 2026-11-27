# 本地双端部署与三运行域

> 状态：基础双端与切片 A 研究页面已实现。玩家客户端监听 `127.0.0.1:5173`，服务端监听 `127.0.0.1:3000` 并通过 `/console/*` 提供控制台静态页面；Origin、会话、角色与 WS 频道均经服务端校验。完整运营、评估与后续研究页面仍按后续能力补齐。本文定义双端的部署和权限边界。参见 [api.md — HTTP 与 WebSocket API](api.md)、[module-catalog.md — 模块目录](module-catalog.md)、[client-and-rendering.md — 场景适配](client-and-rendering.md)、[observability.md — 观测](../platform/observability.md)、[evaluation.md — 评估](../platform/evaluation.md)。
>
> 这里的“端口”指网络监听端口；模块之间通过 capability port（能力端口）交互，见 [模块边界](modules.md) 与 [公共契约](contracts.md)，两者不是同一概念。

## 原生 Demo 部署目标

Godot 进程主动连接 `http://127.0.0.1:3000` 和同一地址的 WebSocket。TypeScript 服务端是唯一网络监听进程，同时提供玩家 API、控制台 API 和 `/console/*` 静态资源。玩家与控制台的会话及角色独立，服务端拥有世界写入、存档和模型密钥。

原生端凭玩家令牌登录，将会话令牌留在进程内存，用 Bearer 请求取得一次性票据，并订阅 `player` 频道。原生连接可以省略 `Origin`。服务端继续校验已提供的 Origin、会话、票据与频道权限。参见 [api.md — 通用约定](api.md#1-通用约定)。

协议联调可单独启动现有 `pnpm dev:server` 并连接 Godot 客户端。正式切换前，在原生候选分支以其 `pnpm build`、`pnpm start` 和独立的 Godot 导出物验证实际发布方式。分别保留 TS 服务端与 Godot 的启动根 PID，枚举两棵进程树的全部 TCP 监听，核对 PID、绑定地址及端口。服务端唯一监听为 `127.0.0.1:3000`，Godot 进程树无监听。占用时直接报错退出。来源见 [工程端口约束](../../.agents/rules/architecture/engineering-iron-laws.md#24-网络与端口白名单)。

## 1. 部署不变量：只有两个监听端口

本节记录现行浏览器模式。

| 端口 | 归属 | 谁访问 | 承载 |
|---|---|---|---|
| `127.0.0.1:5173` | 玩家客户端 host（浏览器 realm） | 玩家 | 2.5D 灰盒场景、交互、对话、人物册、开局、必要设置 |
| `127.0.0.1:3000` | 服务端 host（Node server realm） | 玩家客户端、控制台浏览器 | 权威世界、模型池、REST API、WebSocket、控制台静态资源与 API |

控制台不是第三个服务：它的静态资源由服务端 `:3000` 的 `/console/*` 提供，浏览器页面通过同源 API/WS 与服务端通信。开发期的客户端热更新也只使用 `:5173` 同一端口，不得为方便另开后台端口。

以下情况视为部署验收失败：

- 新增 `ops-web`、`lab-web`、`admin-web` 或独立 HMR 端口；
- 以“只在开发时用”为由启动第三个监听器，并在文档中写成可接受；
- 客户端直连数据库、模型供应商或控制台私有接口绕过服务端；
- 控制台页面直接嵌入服务端 Node 对象或持有 API 密钥。

端口被占用时服务端或客户端应显式失败并给出占用提示，不能自动递增到 `3001`/`5174`；未文档化的端口会破坏本契约。端口号只从环境配置读取一次，客户端与服务端各自校验。

## 2. 三运行域，不是三个后端服务

| 运行域 | 执行位置 | 信任与状态 | 可以做 | 不可以做 |
|---|---|---|---|---|
| `server` | Node 进程，`:3000` | 唯一权威写者；持有数据库、密钥、模型连接 | 世界裁决、Agent 管线、模型/工具调用、证据归档、控制台 API | 把密钥下发浏览器；跳过最终 guard |
| `client` | 现行浏览器 `:5173`，原生目标为 Godot 进程 | 只读授权投影；本地偏好 | 渲染、输入意图、HUD/对话、玩家设置 | 写世界、读全知 trace、改服务端装配、读模型密钥 |
| `console` | 浏览器页面，`:3000/console/*` | 有会话与角色的操作/研究视图 | 模型挂载、三势力运营、观测、评估、调试、模块装配 | 因本机访问跳过鉴权；把真值自动变成角色知识 |

现行 TypeScript 宿主共享 `packages/contracts` 和 `packages/kernel`，各自拥有组合根与模块注册表。Godot 使用独立的 C# 宿主契约。运行域之间通过版本化 HTTP/WS 协议通信。下图展示现行浏览器部署。

~~~mermaid
flowchart LR
  subgraph CLIENT["client realm：127.0.0.1:5173"]
    CH["client host"]
    CM["scene / hud / dialogue / settings modules"]
  end
  subgraph SERVER["server realm：127.0.0.1:3000"]
    SH["server host + guards"]
    GM["game modules"]
    AM["agent modules"]
    PM["platform / adapters"]
    CA["console API + static assets"]
  end
  subgraph CONSOLE["console realm：127.0.0.1:3000/console"]
    OH["console host"]
    OM["model-mounts / faction-ops / obs / eval / debug"]
  end
  CH -->|"HTTP / WS 授权投影与命令"| SH
  OM -->|"同源 HTTP / WS 控制台 API"| CA
  CM --> CH
  SH --> GM
  SH --> AM
  SH --> PM
  CA --> SH
~~~

两个端点的功能均由对应 realm 的 provider 提供；宿主只装配和执行权限守卫。玩家客户端的必要设置不等于后台配置入口，控制台同源也不能越过角色授权或让浏览器持有密钥。

## 3. 玩家客户端：能看见什么、能设置什么

玩家只看到 `player` principal 的授权投影：场景、已提交对白、获准任务、人物册公开信息、自己的笔记与当前局势。NPC 私密记忆、原始 prompt、模型凭据、未发布剧情、控制台 trace 不属于玩家投影。

`client.settings.standard` 模块向 `settings.section` slot 贡献以下设置；设置模块可替换，缺失时使用宿主默认值并显示不可自定义：

| 设置 | 生效边界 |
|---|---|
| 语言、字号、字幕、对比度、通知、声音 | 纯展示偏好；本地/用户级保存，即时应用，可恢复默认 |
| 镜头速度、缩放范围、交互辅助 | 只改视口与输入表达；不改变规则距离、视野、知识或权威状态 |
| 图形质量 | 只改当前 renderer 支持的性能参数；不暗中更换模块实现 |
| 游戏暂停/保存/恢复 | 走有权限的 campaign API；不是只暂停客户端画面 |
| 测试 preset 入口 | 展示获准的装配摘要，申请新 run/branch；不能热改当前世界 |

模型选择、模块装配、API 凭据、世界真值与评分原文属于服务端控制台。玩家设置不能通过参数或 URL 获得后台权限；所有后台操作由服务端会话与角色校验。

## 4. 服务端控制台：可观测、可评估、可调试、可运营

控制台是服务端在同一端口提供的浏览器产品，页面全部由 `console` 域模块贡献到路由/panel/action slot。默认页面与模块的对应关系：

| 页面 | 模块 | 主要能力 | 默认角色 |
|---|---|---|---|
| 运行总览 | `console.health.standard` | 端口、模块 readiness、水位、预算、失败 | operator / researcher |
| 模块与装配 | `console.module-admin.standard` | catalog、装配详情（预检、diff 与草稿编辑为目标能力） | operator / researcher |
| 模型池 | `console.model-mounts.standard` | connections/models/mounts、路由与静态校验（草稿保存与连通性探测为目标能力） | operator / researcher |
| 三势力运营 | `console.faction-ops.standard` | 暂停/继续/单步、快照/恢复（三势力席位接管与运行申请审批为目标能力） | operator |
| 事件卡与剧情（目标，尚未实现） | `console.scenario-editor.standard` | 草稿、预演、发布、撤回、补偿、污染标记 | operator |
| 可观测 | `console.observability.standard` | 世界时间线、Agent 检查器、请求/响应、turn 证据、trace 树与 Artifact 查看（时间线筛选、记忆 diff 与分支对比页为目标能力） | researcher |
| 可评估 | `console.evaluation.standard` | 只读实验列表、分组指标汇总与 run 报告（创建与启停表单为目标能力） | researcher / evaluator |
| 可调试 | `console.debug.standard` | 调度/维护队列、turn 请求摘要校验与调试唤醒 | researcher |
| 审计与导出（目标，尚未实现） | `console.audit.standard` | 按权限脱敏、导出、保留策略 | researcher |

“可运营”具体指：

1. 模型挂载：先集中定义 connection/model，再把多个 Agent 的 purpose 挂载到模型；控制台可预览 resolved 路由与费用，但不下发密钥。
2. 三势力剧情走向：巡裔、根庭、泊星者三个非人类势力各有一个运营席位，可独立选择 agent 或 human 控制；可编辑、预演、发布事件卡，暂停/单步/快照/恢复世界。
3. 运营与研究的隔离：human 席位仍是原 agentId 的控制者变化，不新增玩家或 Agent；研究真值不自动进入席位输入；调试覆盖产生 `ScenarioOverride` 与污染标记。

控制台页面被隐藏、按钮被禁用或菜单项不存在，都不是授权；所有控制台 API 都重新校验会话、角色、资源 scope 与期望 epoch/version。

## 5. 请求与数据流

接口的完整清单、请求与响应格式、角色权限矩阵和错误码以 [API](api.md) 为准，本文不再重复。按归属分：`:5173` 只提供客户端静态资源，并把 `/api` 代理到 `:3000`；`:3000` 提供 `/api/v1/*`（玩家与通用接口）、`/api/v1/console/*`（控制台接口，按当前角色单独授权）、`/api/v1/streams`（WebSocket）与 `/console/*`（控制台静态资源）。

一次玩家交互：客户端提交 command，经服务端 guard 校验后交给世界/Agent 模块处理；处理结果提交为事实与 outbox，再形成授权投影与 WS 增量，客户端 reducer 更新后交给已装载的 UI 模块。控制台读取同一事件的审计视图，但不会产生新的角色获知。

玩家客户端与 NPC 使用同一 command 与规则管线；控制台操作也通过标准 command/API，不允许直接写数据库。

## 6. 鉴权、会话与本地运行

本地 demo 不等于无鉴权，具体机制见 [API](api.md) 第 2 节：

- 服务端启动时读取或生成玩家令牌与控制台令牌，仅为本次新生成的令牌打印带 `#token=` 的登录地址。目标浏览器宿主用令牌换取会话，保存在按 origin 隔离的 `sessionStorage` 中。会话以登录时返回的 `expiresAt` 为准，注销或到期会同时撤销该会话的一次性票据和 WebSocket 连接。有效期见 [api.md — 认证、会话与健康检查](api.md#2-认证会话与健康检查)。
- 角色区分 `player`、`operator`、`researcher`、`evaluator`；控制台会话可持有多个角色，但每个请求用 `X-Active-Role` 指明当前角色，服务端只按当前角色与资源 scope 校验。
- 服务端在请求或 WebSocket 握手带 `Origin` 时校验来源。现行浏览器模式允许 `http://127.0.0.1:5173` 与 `http://127.0.0.1:3000`。WebSocket 用一次性票据认证。
- 模型凭据只存在服务端环境变量；控制台只看到连接别名、模型能力与验证状态。
- 浏览器端状态（偏好、缓存、未提交草稿）与权威状态分开；刷新页面不能重放已提交副作用。

单玩家首版允许同一个人同时持有玩家令牌与控制台令牌，但两者是不同的会话、在不同的 origin 下运行；研究数据与扮演界面不能共享携带真值的缓存。

## 7. 启动、开发与测试

命令、脚本与本地拓扑的实现方式见 [技术栈](../delivery/tech-stack.md) 第 4、6 节。要点：

> `pnpm test:e2e` 覆盖玩家与控制台关键路径，`pnpm check:ports` 验证开发和生产启动只产生两个监听。交付进度见 [IMPLEMENTATION-STATUS.md — 总览](../IMPLEMENTATION-STATUS.md#1-总览)。

| 命令 | 行为 |
|---|---|
| `pnpm dev` | 服务端（`:3000`）+ 客户端 Vite dev server（`:5173`，HMR 复用该端口）+ 控制台 `vite build --watch`（不监听端口） |
| `pnpm build` | 构建客户端产物与控制台静态资源（控制台产物输出到服务端的 `console-static/`） |
| `pnpm start` | 服务端 + `vite preview`（`:5173`）；控制台复用服务端端口 |
| `pnpm check:ports` | 启动后确认只有两个本应用监听 |

开发代理只存在于 `:5173` 的监听内部，不产生新的监听端口。生产构建不得把密钥、服务端模块或内部路径打包进浏览器。

使用 `pnpm check:ports` 核对现行网页启动进程树的 TCP 监听。手工核验时从 `Get-NetTCPConnection -State Listen`（Windows）或 `ss -ltnp`（Linux）按本应用的进程 PID 核对全部监听。用玩家会话请求控制台 API 时应返回 403。

## 8. 故障、降级与不变量

| 故障 | 在线表现 | 正式实验/运营 |
|---|---|---|
| 服务端未启动/崩溃 | 客户端显示不可连接；不伪造本地世界 | 运行暂停，重启后按持久任务与 fencing 恢复 |
| WebSocket 断线 | 现行浏览器可带游标续传，原生端重连后读取完整快照。见 [玩家投影与恢复](api.md#玩家投影与恢复) | 不把网络断线当成叙事事件或记忆衰减 |
| 客户端模块缺失/版本不兼容 | 组合不完整页面；不静默加载旧模块 | 该客户端会话不进入有效样本 |
| 控制台页面模块卸载 | 导航显示不可用原因；对应 API 仍受权限保护 | 不影响已发布事实与评分证据 |
| 可选 UI/声音/通知模块失败 | 隔离到自身区域并显示原因 | 关键证据缺失时实验判 invalid |
| 模型/存储/观测模块故障 | 按模块声明显式失败或降级并标记 | 不允许用回退结果伪装成功样本 |
| 端口被占用 | 启动失败并提示占用进程 | 不自动改端口 |

服务端保管模型密钥，并对本机控制台调用执行角色校验。部署模式的监听约束见[原生目标](#原生-demo-部署目标)及[现行浏览器部署](#1-部署不变量只有两个监听端口)。模块装配见 [模块目录](module-catalog.md)，配置冻结见 [配置](../platform/configuration.md)。

## 9. 验收

- 现行浏览器模式启动后只监听 `:5173` 和 `:3000`。原生 Demo 启动后只监听 `:3000`。两种模式的控制台都从 `:3000/console/` 打开。
- 玩家客户端能完成开局、点选、交谈、提案、暂停/恢复与设置修改；设置不改变规则结果。
- 控制台当前能力按角色验收，包括运行总览、模型布局查看、时钟与快照操作、trace 查看和评估 run 创建。尚未交付的席位接管与剧情运营按 [实现状态](../IMPLEMENTATION-STATUS.md) 跟踪，沿用原生切换的已公开能力范围。
- 玩家会话访问控制台 API 返回 forbidden；控制台响应与浏览器包不含模型密钥。
- 客户端 renderer/HUD/设置模块替换后，同一玩家的同一条 command 产生相同世界结果；替换控制台观测页不影响 trace 数据。
- 移除可选客户端模块或控制台页面后无残余订阅，导航显示不可用原因；移除必需模块时组合拒绝启动。
- 进程树监听与部署模式一致。世界数据与模型由服务端访问，控制台与玩家请求均由服务端鉴权。

服务端已有 Origin、角色鉴权和监听集成测试。原生候选包另按 [Godot 玩家端切换验收](../delivery/roadmap-and-acceptance.md#godot-玩家端切换验收) 完成实机检查。

## 10. 控制台页面首版规格

### 10.1 控制台宿主壳

- 登录方式同客户端：读取 `#token`，换取会话令牌，存进 `sessionStorage`。
- 顶栏有“当前角色”下拉框，只列出会话拥有的角色；切换后所有请求都带新的 `X-Active-Role`，页面重新加载数据。
- 导航由已装载页面模块的贡献生成，每个页面声明 `allowedRoles`，当前角色不在其中时导航项置灰并注明原因；装配里没有的页面显示“模块未装载”。
- 页面模块只经 `client-protocol` 调用 [API](api.md) 第 5 节的接口，不直接 `fetch` 未声明的路径。

### 10.2 各页面

| 页面模块 | 角色 | 数据来源 | 视图 | 操作 |
|---|---|---|---|---|
| `console.health.standard` | operator、researcher | `GET /console/health`，WS `console.health` | 整体健康状态、端口、三个 realm 的就绪状态、装配 hash、时钟、有数据来源的队列长度（待执行 turn、记忆维护排队与耗尽数）、预算消耗、最近 10 条失败、宿主热路径耗时（玩家投影构建与发布）；水位落后的 Agent 尚无数据来源，响应省略该字段 | 无 |
| `console.module-admin.standard` | operator、researcher | `/console/modules`、`/console/assemblies*` | catalog 表（按 realm 筛选）、装配列表、各 realm 的解析结果 | 查看 catalog 与装配详情（预检、diff 与保存草稿为目标能力） |
| `console.model-mounts.standard` | operator、researcher | `/console/model-layouts*` | 布局列表；布局详情（连接只显示适配器、主机名与 `credentialRef` 名称）；“按模型看挂载”与“按角色看路由”两个视图 | 静态校验布局草稿（保存草稿与连通性探测为目标能力） |
| `console.faction-ops.standard` | operator | `/console/campaign/*`（`/console/ops/*`、`/console/run-requests` 为目标） | 时钟状态；存档列表（三个非人类势力席位状态、接管视图与运行申请为目标视图） | 暂停/继续/单步 N tick；存档；恢复（席位接管/交还、席位命令与运行申请审批为目标操作） |
| `console.scenario-editor.standard`（目标，尚未实现） | operator | `/console/scenarios/*` | 卡片列表与在线分支中的状态 | YAML 编辑草稿并校验；沙盒预演；按 tick 发布；撤回未触发的卡；补偿；调试覆盖（醒目提示会污染当前 run） |
| `console.observability.standard` | researcher | `/console/timeline`、`/console/agents*`、`/console/turns*`、`/console/artifacts/*`、`/console/traces/*` | 世界时间线、Agent 检查器（人格、最后已知视图、记忆摘要、关系、承诺、水位）、turn 列表与详情（各阶段 requested/resolved/effective、attempt 请求响应、工具调用与对白）、trace 树 | 原文与脱敏切换查看（时间线筛选、记忆 diff 与分支对比页为目标视图） |
| `console.observability.lite`（目标，尚未实现） | researcher | `/console/turns*`、`/console/artifacts/*` | 只有 turn 列表与单个 turn 详情 | 同上 |
| `console.evaluation.standard` | researcher、evaluator | `/console/runs*`、`/console/experiments*` | 实验列表、run 列表与状态；分组指标汇总；run 详情（去密钥 manifest、污染标记、证据完整性）；报告（指标、分子分母、无效样本与原因、探针回答与得分） | 当前为只读评估页面（界面层创建与启停操作为目标能力） |
| `console.debug.standard` | researcher | `/console/debug/*` | 调度队列、模型池队列、整理队列 | 审计重放某个 turn 并比较请求 hash；注入调试唤醒（污染当前 run）；单步控制在 `console.faction-ops.standard` 提供 |
| `console.audit.standard`（目标，尚未实现） | researcher | `POST /console/exports`、`/console/artifacts/*` | 导出列表 | 创建脱敏或原文导出包并下载 |

每个页面的数据都按当前角色向服务端请求；页面隐藏某个按钮不能代替服务端鉴权。
