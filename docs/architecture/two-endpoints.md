# 两个本地端口与三运行域

> 状态：目标设计，尚未实现。本文拥有端口、origin、运行域、玩家设置与服务端控制台的部署边界。模块清单见 [模块目录](module-catalog.md)，客户端渲染见 [客户端与 2.5D](client-and-rendering.md)，观测与评估界面见 [观测](../platform/observability.md) 与 [评估](../platform/evaluation.md)。
>
> 术语提醒：本文的“端口”指网络监听端口；模块之间通过 capability port/能力端口 交互，见 [模块边界](modules.md) 与 [公共契约](contracts.md)，两者不是同一概念。

## 1. 部署不变量：只有两个监听端口

| 端口 | 归属 | 谁访问 | 承载 |
|---|---|---|---|
| `127.0.0.1:5173` | 玩家客户端 host（浏览器 realm） | 玩家 | 2.5D 场景、交互、对话、人物册、开局、必要设置 |
| `127.0.0.1:3000` | 服务端 host（Node realm） | 玩家客户端、控制台浏览器 | 权威世界、模型池、REST API、WebSocket、控制台静态资源与 API |

控制台不是第三个服务：它的静态资源由服务端 `:3000` 的 `/console/*` 提供，浏览器页面通过同源 API/WS 与服务端通信。开发期的客户端热更新也只使用 `:5173` 同一端口，不得为方便另开后台端口。

以下情况视为部署验收失败：

- 新增 `ops-web`、`lab-web`、`admin-web` 或独立 HMR 端口；
- 为“只在开发时”方便启动第三个监听器，并在文档中写成可接受；
- 客户端直连数据库、模型供应商或控制台私有接口绕过服务端；
- 控制台页面直接嵌入服务端 Node 对象或持有 API 密钥。

端口被占用时服务端或客户端应显式失败并给出占用提示，不能自动递增到 `3001`/`5174`；未文档化的端口会破坏本契约。端口号只从环境配置读取一次，客户端与服务端各自校验。

## 2. 三运行域，不是三个后端服务

| 运行域 | 执行位置 | 信任与状态 | 可以做 | 不可以做 |
|---|---|---|---|---|
| `server` | Node 进程，`:3000` | 唯一权威写者；持有数据库、密钥、模型连接 | 世界裁决、Agent 管线、模型/工具调用、证据归档、控制台 API | 把密钥下发浏览器；跳过最终 guard |
| `client` | 浏览器页面，`:5173` | 只读授权投影；本地偏好 | 渲染、输入意图、HUD/对话、玩家设置 | 写世界、读全知 trace、改模块装配、读模型密钥 |
| `console` | 浏览器页面，`:3000/console/*` | 有会话与角色的操作/研究视图 | 模型挂载、三势力运营、观测、评估、调试、模块装配 | 因本机访问跳过鉴权；把真值自动变成角色知识 |

三种 realm 共享 `packages/contracts` 的 DTO/port/schema 与 `packages/kernel` 的宿主机制，但各有独立组合根与模块注册表。跨域只允许版本化 HTTP/WS 协议；不能共享进程内对象、数据库连接或可写 store。

~~~mermaid
flowchart LR
  subgraph CLIENT["client realm · 127.0.0.1:5173"]
    CH["client host"]
    CM["scene / hud / dialogue / settings modules"]
  end
  subgraph SERVER["server realm · 127.0.0.1:3000"]
    SH["server host + guards"]
    GM["game modules"]
    AM["agent modules"]
    PM["platform / adapters"]
    CA["console API + static assets"]
  end
  subgraph CONSOLE["console realm · 127.0.0.1:3000/console"]
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
| 模块与装配 | `console.module-admin.standard` | catalog、装配 diff、预检、更换计划 | operator / researcher |
| 模型池 | `console.model-mounts.standard` | connections/models/mounts、批量挂载、能力验证 | operator / researcher |
| 三势力运营 | `console.faction-ops.standard` | 三个非人类势力席位 agent/human、暂停/单步/快照 | operator |
| 事件卡与剧情 | `console.scenario-editor.standard` | 草稿、预演、发布、撤回、补偿、污染标记 | operator |
| 可观测 | `console.observability.standard` | 世界时间线、Agent 检查器、请求/响应、记忆 diff、分支对比 | researcher |
| 可评估 | `console.evaluation.standard` | run 创建、指标、报告、判定与失败分母 | researcher / evaluator |
| 可调试 | `console.debug.standard` | 有界单步/重放、预算与队列、故障定位、测试注入 | researcher |
| 审计与导出 | `console.audit.standard` | 按权限脱敏、导出、保留策略 | researcher |

“可运营”具体指：

1. **模型挂载**：先集中定义 connection/model，再把多个 Agent 的 purpose 挂载到模型；控制台可预览 resolved 路由与费用，但不下发密钥。
2. **三势力剧情走向**：巡裔、根庭、泊星者三个非人类势力各有一个运营席位，可独立选择 agent 或 human 控制；可编辑、预演、发布事件卡，暂停/单步/快照/恢复世界。
3. **运营与研究的隔离**：human 席位仍是原 agentId 的控制者变化，不新增玩家或 Agent；研究真值不自动进入席位输入；调试覆盖产生 `ScenarioOverride` 与污染标记。

控制台页面被隐藏、按钮被禁用或菜单项不存在，都不是授权；所有控制台 API 都重新校验会话、角色、资源 scope 与期望 epoch/version。

## 5. 请求与数据流

| 入口 | 用途 | 关键边界 |
|---|---|---|
| `GET /` on `:5173` | 客户端 host 静态资源 | 只加载 client realm 模块与授权投影 |
| `POST /api/v1/commands` | 玩家/运营标准命令 | 鉴权、幂等、版本、scope、controller/turn fencing |
| `GET /api/v1/world/view` | 当前 principal 的授权投影 | 不返回原始全局事件或他人记忆 |
| `WS /api/v1/streams` | 投影、已提交对白、任务状态 | 授权 channel、游标补齐、缺口重取快照 |
| `GET /api/v1/session` | 会话、角色、协议版本、realm 装配描述 | 只返回本角色可见能力 |
| `GET /api/v1/session/assembly`（`realm=client` 或 `console`） | 已解析的本域模块清单与兼容性 | 不含工厂、密钥或服务端对象 |
| `/api/v1/console/*` | 控制台的运营、模型、观测、评估、调试、模块管理 | 同源会话 + 角色；与玩家 API 分开授权 |
| `/console/*` | 控制台静态资源 | 由 server 提供；不得启动第三端口 |

一次玩家交互：客户端提交 command → 服务端 guard 校验 → 世界/Agent 模块处理 → 提交事实与 outbox → 授权投影/WS 增量 → 客户端 reducer → 已装载 UI 模块。控制台读取同一事件的审计视图，但不会产生新的角色获知。

玩家客户端与 NPC 使用同一 command 与规则管线；控制台操作也通过标准 command/API，不允许直接写数据库。所有失败区分 forbidden、validation、version-conflict、stale-controller、stale-turn、not-ready、budget-exhausted、module-missing、assembly-incompatible 等错误。

## 6. 鉴权、会话与本地运行

本地 demo 不等于无鉴权：

- 服务端启动时生成本地操作员会话与玩家会话种子，或从环境注入；控制台必须登录/携带会话，不能凭 `127.0.0.1` 直接获批。
- 角色至少区分 `player`、`operator`、`researcher`、`evaluator`；一个账号可持有多个角色，但每次请求按当前角色与 scope 校验。
- CORS 只允许 `http://127.0.0.1:5173` 与 `http://127.0.0.1:3000` 的明确 origin；WebSocket 握手校验 origin、会话与 channel scope。
- 模型凭据只存在服务端环境/secret store；控制台只看到连接别名、模型能力与验证状态。
- 浏览器端状态（偏好、缓存、未提交草稿）与权威状态分开；刷新页面不能重放已提交副作用。

单玩家首版允许同一操作员兼任 player 与 operator，但必须显式切换角色/视图；研究数据与扮演界面不能共享携带真值的缓存。

## 7. 启动、开发与测试

| 命令/场景 | 行为 |
|---|---|
| `pnpm dev` | 并行启动 server（`:3000`）与 client（`:5173`）；控制台在 `:3000/console` |
| `pnpm dev:server` / `pnpm dev:client` | 只启动单侧；另一侧按契约显示不可用，不新建第三个监听 |
| `pnpm build` | 构建 server、client、console 静态资源；console 资源进入 server 产物 |
| `pnpm start` | 启动 server 与 client 两个监听；控制台复用 server 端口 |
| `pnpm test` | 契约、边界、装配、目录检查与两端口 e2e（目标脚本） |

开发代理可以存在于 `:5173` 或 `:3000` 内部（同一监听的反向代理），但不得产生新的监听端口。客户端 API base URL 只通过环境配置注入；生产构建不得把密钥、服务端模块或内部路径打包进浏览器。

两端口验收建议在启动后执行：`Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 5173,3000`（Windows）或 `ss -ltnp`，确认只有两个本应用监听；再用无控制台权限的玩家会话请求控制台 API，确认返回 forbidden。

## 8. 故障、降级与不变量

| 故障 | 在线表现 | 正式实验/运营 |
|---|---|---|
| 服务端未启动/崩溃 | 客户端显示不可连接；不伪造本地世界 | 运行暂停，重启后按持久任务与 fencing 恢复 |
| WebSocket 断线 | 带最后游标重连；缺口过大重取快照 | 不把网络断线当成叙事事件或记忆衰减 |
| 客户端模块缺失/版本不兼容 | 组合不完整页面；不静默加载旧模块 | 该客户端会话不进入有效样本 |
| 控制台页面模块卸载 | 导航显示不可用原因；对应 API 仍受权限保护 | 不影响已发布事实与评分证据 |
| 可选 UI/声音/通知模块失败 | 隔离到自身区域并显示原因 | 关键证据缺失时实验判 invalid |
| 模型/存储/观测模块故障 | 按模块声明显式失败或降级并标记 | 不允许用回退结果伪装成功样本 |
| 端口被占用 | 启动失败并提示占用进程 | 不自动改端口 |

只有两个监听端口、客户端不持密钥、控制台不因本地访问绕过鉴权，是部署层的硬不变量。模块目录与装配见 [模块目录](module-catalog.md)，配置冻结见 [配置](../platform/configuration.md)。

## 9. 验收

- 启动后机器上只有 `:5173` 与 `:3000` 两个本应用监听；控制台可从 `:3000/console` 打开。
- 玩家客户端能完成开局、点选、交谈、提案、暂停/恢复与设置修改；设置不改变规则结果。
- 控制台能完成模型挂载、三势力席位接管/交还、事件卡发布、trace 查看、评估 run 创建与调试单步。
- 玩家会话访问控制台 API 返回 forbidden；控制台响应与浏览器包不含模型密钥。
- 客户端 renderer/HUD/设置模块替换后，同一玩家的同一条 command 产生相同世界结果；替换控制台观测页不影响 trace 数据。
- 移除可选客户端模块或控制台页面后无残余订阅，导航显示不可用原因；移除必需模块时组合拒绝启动。
- 无第三个 Web 端口、无客户端直连数据库/模型、无隐藏按钮替代鉴权。

以上均为目标验收，尚无运行时或实测记录。
