# 玩家客户端、UI 模块与 2.5D 场景

> 目标设计。玩家访问 http://127.0.0.1:5173，世界权威、模型和后台管理在 http://127.0.0.1:3000。两个端口是固定的部署边界，详见 [双端口拓扑](two-endpoints.md)。客户端宿主与可替换功能的规则由本文维护，图形界面不是不可拆的游戏主体。控制台页面是同一套模块机制在 `console` realm 的另一个宿主，见 [模块目录](module-catalog.md)。

## 1. 客户端宿主保留什么

apps/client 只保留启动、模块装载、依赖与能力校验、扩展槽容器、生命周期、错误边界和协议客户端接入。地图、渲染、镜头、输入、HUD、对话、角色册、派系开局、设置、通知、音频这些功能都由 ModuleDefinition 注册，不写死在宿主页面里。宿主不提供模块可以绕过的“全局 store”，也不提供直接注入 DOM 的入口。

模块之间按 contracts 里的 typed port 交互，不直接 import 另一个模块的实现，也不靠全局可写 store 找隐式依赖。宿主只把模块声明所需的 capability handle 注入实例；跨客户端与服务端的调用只能走 client-protocol 和授权网络协议，不能跨进程注入服务端对象。

低耦合优先指改一个功能时不必修改无关模块。它不等于没有契约，也不意味着每次函数调用都要广播到一个无限制的事件总线。模块内部按单一职责组织，模块之间通过明确的输入输出协作。

## 2. 功能模块与扩展槽

| 模块类别 | 贡献的视图/交互 | 依赖的 capability | 可替换性约束 |
|---|---|---|---|
| scene-renderer | 场景表面、精灵与资源 | 授权 scene view、相机状态 | 更换后端不改变世界结果或所见权限 |
| camera | 平移、缩放、跟随 | 视口与选择状态 | 不自行读取世界数据库 |
| projection/input | 坐标变换、命中、交互意图 | renderer hit port、command client | 不直接宣布移动/任务成功 |
| hud | 局势、资源等级、任务状态 | 授权 world/task view | 不内嵌经济或战斗结算 |
| dialogue | 已提交对话、证据卡、提案入口 | conversation view、command client | 不持有私密 decision context |
| character/faction | 人物册、派系开局 | 已授权角色内容、campaign client | 不复制模型编辑器或阵营规则 |
| settings | 允许的玩家偏好 | preference port | 不直接修改运行中的 module assembly |
| notifications/audio | 提醒、声音与反馈 | 已授权 presentation events | 不把提示声音当作世界事实 |

`scene`、`hud`、`dialogue`、`overlay`、`sidebar`、`modal`、`settings.section`、`notification`、`boot.screen` 等 slot 由客户端宿主定义。`UiExtension` 是所属 ModuleDefinition 的视图贡献记录，包含 extensionId、slot、requiredCapabilities、order 与 viewRef；它不构成另一套带独立权限的注册系统。

扩展先验证依赖和重复 ID，再按显式布局与顺序装载。必需能力不存在时给出组合不完整错误；可选面板可以显示不可用原因，但不能伪造功能已生效。卸载视图要释放订阅、事件处理、图形资源和临时状态，不得卸载仍被必需模块使用的 provider。

## 3. 两个 origin 的职责

| 地址 | 玩家能看到/请求什么 | 不提供什么 |
|---|---|---|
| 127.0.0.1:5173 | 游戏场景、交谈/任务、人物册、派系开局、必要设置 | 模型凭据、全知 trace、导演席位管理 |
| 127.0.0.1:3000/console/* | 按角色授权的模型挂载、三势力剧情运营、观测、评估、调试、模块装配 | 不因本地访问就跳过鉴权 |
| 127.0.0.1:3000/api/v1/* | 玩家或后台获准使用的 REST API | 未授权原始世界日志/记忆 |
| 127.0.0.1:3000/api/v1/streams | 有会话与 channel scope 的 WebSocket | 无限制广播所有角色私密事件 |

后台 UI 的静态资源由 apps/server 的同一个监听端口提供，仍在浏览器里执行；不能再为运营或实验界面启动第三个 Web 监听端口。开发资源更新和 WebSocket 也必须复用两端口拓扑，不能以开发模式为借口额外开放后台端口。

## 4. 客户端数据流

数据先从 transport 进入 authorized projection reducer，转为 typed scene/UI view-model，再交给已装载的功能模块。网络 reducer 属于可替换的客户端投影模块，通过 ProjectionPort 提供只读订阅和版本信息；模块不能各自维护一份互相矛盾的权威世界。

客户端维护 worldTick、projectionVersion、streamSeq 与当前 branch 标识。断线重连时携带最后确认的游标续传；缺口过大就重取快照。重连不会新建 NPC，进入实验分支必须有可见标识。

SceneSnapshot/SceneDelta 只包含玩家已知的节点、可见角色、获准任务、路线和展示等级，不包含私密记忆、完整 prompt、未发布剧情或凭据。render、camera、input、HUD 都消费同一份授权投影，模块化不能扩大可见范围。

角色点选先转成实体或世界坐标的意图，再提交标准 command；最终是否合法由服务端的模块组合处理，并经宿主提交关口验证。客户端只显示 accepted 和后续任务状态，不把精灵移动当作行动已经完成。

## 5. 2.5D 渲染适配

React 是首版的 UI 适配目标，PixiJS 是首版的场景适配目标，两者都不构成宿主契约。PixiJS 官方定位是面向 Web 的 2D 渲染器，支持 WebGL 和可选的 WebGPU；本项目在它之上用等距精灵表现 2.5D，不依赖完整的 3D 物理。[官方介绍](https://pixijs.com/8.x/guides/getting-started/intro)

SceneRenderer port 接收授权场景、相机和选择状态，输出 entity-picked/location-picked 这类意图。projection 负责世界与屏幕的变换，input 负责命中和交互，renderer 负责资源与显示；三者可以分别提供实现，但在 assembly 中必须满足相容的坐标、命中和视口契约。

基础投影为 `screenX=(x-y)×tileWidth/2`、`screenY=(x+y)×tileHeight/2-height×heightStep`。高度在首版用于视觉表现；路径、位置、可达、视野和到达由服务端的规则和地图模块决定。视觉遮挡与知识权限分开。

深度按落脚点、地形层和稳定次序排序。平移或缩放之后，命中转换要保持世界目标不变；移动只是对已接受路径做插值。请求失败时显示最近的合法位置和原因，不能由渲染器补造完成事件。

场景每帧更新相机、插值和必要的精灵，React 按业务变化刷新，不按渲染帧重建整个世界。图形资产是版本化内容，URL 由内容包验证，不接受 LLM 提供的任意资源地址。

## 6. 玩家必要设置

`client.settings.standard` 模块向 `settings.section` slot 贡献设置；设置模块可以替换，缺失时使用宿主默认值，并说明当前不可自定义。偏好经 preference port 保存，作用域是设备或玩家，不进入 run manifest，也不能改变世界规则。

| 设置 | 生效边界 |
|---|---|
| 语言、字号、字幕、对比度、通知、声音 | 纯展示偏好，经 preference port 本地/用户级保存，即时应用并可恢复默认 |
| 镜头速度、缩放范围、交互辅助 | 只改变视口/输入表达，不改变规则距离、知识和权威状态 |
| 图形质量 | 仅调整当前 renderer 支持的性能参数，不暗中更换 module implementation |
| 游戏暂停/保存/恢复 | 走有权限的 campaign API，不只是暂停客户端画面 |
| 测试 preset 入口 | 展示获准选择的组合摘要，申请新 run/branch，不能直接热改当前世界 |

模型和模块的详细装配、API 凭据、世界真值与评分原文都在服务端控制台。玩家的测试入口不能借设置项取得后台权限；只有已授权的研究操作才能创建相应实验。控制台与玩家的 origin 和角色规则见 [两个本地端口](two-endpoints.md)。

## 7. 生命周期、故障与验收

纯偏好变更可以即时生效；切换功能实现或 module assembly 时，在受控边界销毁旧实例、校验依赖再重建，新 run 和 branch 的生效规则见 [配置](../platform/configuration.md)。不承诺任何有状态功能都能在帧中间热拔。

可选 UI 模块的失败隔离在自身区域内，并显示原因；renderer、transport 这类必需能力失效时显示不可运行或重连状态，不用静态画面假装世界还在运行。服务端是否继续按 campaign 策略决定，客户端不能自行决定世界回滚。

验收必须覆盖：两个端口之外没有新增监听；替换 renderer、camera、HUD、设置中的任一实现，不改动无关模块；移除必需 provider 会被拒绝；卸载后没有资源或监听残留；相机变化不改变 command 的世界目标；重连不复制角色；player 来源读不到后台 trace；原始 token 不提前显示给玩家；无画面适配也能用于规则实验；控制台页面替换后，玩家域仍然访问不到后台 API。

职责与接口的归属见 [模块设计](modules.md)、[模块目录](module-catalog.md)、[公共契约](contracts.md)；跨端接口以 [双端口拓扑](two-endpoints.md) 为准。

## 8. 首版实现规格

### 8.1 页面布局与 slot

```text
+--------------------------------- hud (top bar, 56px) ---------------------------------+
| scene (PixiJS canvas, fills the rest)                        | sidebar (right, 360px) |
|   overlay (above the canvas, unused in v1)                   |  tabs: 人物 / 地点 /   |
|                                                              |        任务 / 协议 /   |
|                                                              |        笔记            |
+------------------------- dialogue (bottom panel, 240px, collapsible) -----------------+
notification: toasts at the top-right; modal: centered dialog; boot.screen: full screen before a campaign exists
settings.section: rendered inside the settings modal opened from the HUD gear button
```

宿主用 React 组件 `<Slot name="hud" />` 渲染该 slot 下所有已装载模块的视图，按 `order` 升序排列。

### 8.2 启动流程

1. 读取 `location.hash` 的 `token`，调用 `POST /api/v1/auth/login`，把 `sessionToken` 存进 `sessionStorage`，清掉 hash。已有会话时跳过。
2. `GET /api/v1/session`，再 `GET /api/v1/session/assembly?realm=client`。
3. 校验本地 `module-catalog.ts` 能满足返回的每条绑定（模块 ID、版本、apiVersion 一致）；不满足就显示“组合不完整”页面并列出缺失项，不加载任何模块。
4. 按依赖顺序 `create` → `start` 全部模块实例。
5. `GET /api/v1/campaign`：没有 campaign 时只渲染 `boot.screen`（开局选择）；有 campaign 时 `GET /api/v1/world/view`，再申请 WS 票据并订阅 `player` 频道。
6. 渲染全部 slot；WS 断线时 HUD 显示“重连中”，带 `fromStreamSeq` 重连。

### 8.3 客户端模块之间的端口

| 端口 | 提供者 | 接口 |
|---|---|---|
| `ProjectionPort` | `client.world-view.standard` | `getSnapshot(): PlayerProjection`、`subscribe(listener): () => void`、`streamSeq` |
| `CommandClient` | 宿主（`client-protocol`） | `send(type, payload): Promise<CommandReceipt>`：生成 `commandId`，网络失败时用同一个 `commandId` 重试最多 3 次 |
| `SelectionPort` | `client.input.standard` | `get(): { kind: "node" \| "character" \| "team" \| "task", id } \| null`、`select(sel)`、`subscribe` |
| `CameraPort` | `client.camera.standard` | `get(): { x, y, zoom }`、`pan(dx, dy)`、`zoomTo(z)`、`follow(entityId)` |
| `ScreenProjectionPort` | `client.screen-projection.isometric` | `worldToScreen(x, y, h)`、`screenToWorld(px, py)`，公式见第 5 节，`tileWidth = 64`、`tileHeight = 32` |
| `SceneRenderer` | `client.scene-renderer.*` | `mount(container)`、`render(view: SceneView)`、`onPick(cb)`、`unmount()` |
| `PreferencePort` | 宿主 | `get(key)`、`set(key, value)`，存于 `localStorage`，键前缀 `ai-npc.pref.` |

`SceneView` 由 world-view 从投影派生：节点、道路（含当前状态）、角色与队伍的位置、在途任务（路线与出发/到达 tick）、当前选择。

### 8.4 场景绘制（`client.scene-renderer.pixi`）

首版不使用美术资源，全部用 PixiJS 的 `Graphics` 与 `Text` 绘制：

| 元素 | 画法 |
|---|---|
| 节点 | 等距菱形（64×32），按设施类型填色；下方写节点名 |
| 道路 | 两节点中心连线：open 为灰色实线，restricted 为橙色虚线，closed 为红色实线加“×”；risk 每高一级线宽 +1 |
| 角色 | 直径 10 的圆，颜色取派系色，围绕所在节点均匀排布，悬停显示姓名 |
| 队伍 | 边长 10 的方块，同样按派系色；在途时沿路线插值移动：`进度 = min(1, (worldTick − departTick) / (nominalCompletionTick − departTick))`；任务被标记延误后停在终点前 90% 处，直到收到完成事件 |
| 选择 | 选中对象加白色描边 |

派系色：砾火 `#c0392b`、地生 `#27ae60`、止戈 `#f1c40f`、远星 `#8e44ad`、灰港 `#7f8c8d`、巡裔 `#d35400`、根庭 `#16a085`、泊星者 `#2980b9`。

图形对象设置 `eventMode = "static"`，点击时向 `SelectionPort` 发出 `location-picked` 或 `entity-picked`。拖拽平移、滚轮缩放（范围 0.5–2.0，由设置限制）由 camera 处理；平移与缩放只改视口，不改任何世界坐标。

`client.scene-renderer.null` 实现同一端口，不绘制，只把最近一次收到的 `SceneView` 保存在 `window.__aiNpcSceneLog`，供测试读取。

### 8.5 交互到命令

| 玩家操作 | 界面 | 结果 |
|---|---|---|
| 选择开局派系 | `boot.screen` 的五张卡片（名称、首个委托、接触角色） | `campaign.start`（暂停时也被接受）；受理后先重新执行第 8.2 节第 5 步的有 campaign 分支（获取投影、申请 WS 票据并订阅），再调用 `POST /api/v1/campaign/resume`，`expectedRunVersion` 取投影的 `clock.runVersion` |
| 点击角色 | 底部对话面板打开与该角色的会话 | 输入文字发送 → `dialogue.say`；发出后显示“等待回应”，直到收到回话或投影的 `awaitingReplyFrom` 不再包含该角色 |
| 对话面板“出示证据” | 从笔记里选证据 | `information.share`（受众为当前角色） |
| 对话面板“提议” | 协议表单：当事人、条款类型与参数、有效期 | `agreement.propose` |
| 点击节点 | 侧栏“地点”页：该节点的库存（等级，委托库存显示精确值）、队伍、角色 | — |
| 地点页“派遣” | 派遣表单：任务类型、我能派遣的队伍、参数、可邀请的角色 | `task.dispatch` |
| 任务页 | 我的任务列表：受理状态与任务状态分两列显示 | 可撤销的任务显示“撤销” → `task.cancel` |
| 协议页 | 我参与的协议与条款状态；收到的提案显示接受/拒绝/还价 | `agreement.respond` |
| HUD 暂停/继续/保存 | 已暂停时 HUD 醒目显示“已暂停 · 点击继续”（服务端重启后时钟总是暂停的） | `POST /campaign/pause`、`/resume`、`/snapshots`，`expectedRunVersion` 取投影的 `clock.runVersion` |

为了无障碍与端到端测试，侧栏“地点”与“人物”页同时提供可点击的 DOM 列表，与画布点击等价。关键元素带 `data-testid`：`faction-start-<factionId>`、`list-node-<nodeId>`、`list-character-<agentId>`、`dialogue-input`、`dialogue-send`、`dialogue-line`、`hud-pause`、`hud-resume`、`hud-save`、`dispatch-submit`、`task-row-<taskId>`。

投影需要为“等待回应”提供 `awaitingReplyFrom: string[]`：玩家在某会话中的最后一句之后，对方还没有回话，且对方的 turn 处于排队或进行中。它只暴露“正在处理”这一状态，不暴露任何内容。

### 8.6 HUD 两种实现

| 内容 | `client.hud.standard` | `client.hud.compact` |
|---|---|---|
| 时间与时钟 | “第 3 天 14 时 · 运行中”+ 暂停/继续按钮 | 时钟图标 + 天数 |
| 三个指标 | 名称、数值、等级色条（等级阈值见 [规则](../game/rules.md) 第 4 节） | 三个彩色圆点（危急红、紧张黄、稳定绿），悬停显示数值 |
| 水闸分配 | 文字 | 图标 |
| 我的委托余额 | 三种资源的剩余数量 | 隐藏，点击展开 |
| 提醒、设置、保存 | 按钮 | 按钮（可整体折叠成一行） |

两者读取同一个 `ProjectionPort`，发出同样的命令；替换时只改装配里的一行绑定。

### 8.7 设置项（`client.settings.standard`）

| 设置 | 首版取值 | 生效方式 |
|---|---|---|
| 语言 | 仅 `zh-CN`（下拉框只有一项） | — |
| 字号 | 小 / 中 / 大 | 根元素 `font-size` |
| 高对比度 | 开 / 关 | 切换 CSS 变量 |
| 通知 | 四个级别各自开关 | 过滤 toast |
| 声音 | 显示“声音模块未装载” | 首版没有 `client.audio` |
| 镜头速度、缩放范围 | 0.5–2.0 | 交给 camera |
| 图形质量 | 标准 / 清晰（PixiJS `resolution` 1 或 2） | 重建画布 |
| 暂停 / 保存 | 与 HUD 相同 | campaign API |
| 测试 preset | 列出 `GET /api/v1/presets`，填写说明后提交 | `POST /api/v1/run-requests` |

设置保存在 `PreferencePort`，不进入 run manifest，也不影响任何世界结果。
