# 全职能模块职责与依赖边界

> 状态：部分实现。`server` 已接入首批游戏、存储、授权、运营与传输 provider，以及感知、公平调度、记忆、决策与模型池等 Agent 认知 provider；`client` 与 `console` 模块已实现并绑定三份装配。本文定义各模块的职责、依赖与数据所有权。参见 [module-catalog.md — 模块目录](module-catalog.md)、[plugins.md — 插件机制](plugins.md)、[composition.md — 装配](composition.md)、[code-structure.md — 代码目录](code-structure.md)。

## 1. 设计原则：宿主保留，职能可换

整个游戏与研究平台采用同一套模块机制，不只替换 memory。游戏规则、地图、时钟、行动、存档、剧情、Agent、模型、工具、网络、渲染、界面、设置、观测、评估和调试都通过明确的 port 接入宿主。

这里的“严格解耦”指实现不互相依赖、状态不隐式共享、交互只用版本化契约。必要的协议依赖明确声明，也不可能消除所有交互。权衡时本项目优先解耦：如果“模块内高内聚”会诱使把两个可独立替换的职能塞进一个大模块，就拆开并显式声明依赖。内聚只是模块内部的组织原则，不该为了少写几行引用而复制逻辑。不要求每个函数独立成插件；按可独立替换的职责划界，保留唯一 runtime，不复制循环。

宿主类似保留接口的主机；职能模块类似遵守协议的设备。接口稳定不意味着每个设备必须同时在线，也不意味着有状态服务可以任意热拔。缺少必需能力时，组合应拒绝启动或明确停止。

首版仍为单玩家、统一世界观。现行运行时使用 TypeScript，原生目标采用 Godot C# 玩家端与 TypeScript 服务端、控制台。标准 15 个 Agent 由 8 名公社支持者、4 名 AI 党魁和 3 名外域 Agent 组成。玩法范围与配额由 [全局基线](../00-scope-and-invariants.md) 维护。

## 2. 最小宿主保留什么

| 通用机制 | 宿主责任 | 不放进宿主的职能实现 |
|---|---|---|
| 契约解析 | 校验 port/schema/API 版本、必需能力、依赖图 | 水闸规则、关系算法、任务类型 |
| 注册与装配 | 实例级 registry、显式绑定、贡献所有权 | 自动扫描全部目录并执行模块 |
| 生命周期 | 启动、就绪、暂停、drain、撤销、释放 | 具体存档格式、图形资源、模型连接 |
| 调用关口 | 强制调用已绑定的授权、预算、规则与协议验证 port | 某个派系权限策略、具体行为裁决 |
| 作用域与代次 | 传递并检查 scope、revision、lease/epoch | 读取角色私密认知或直接决定态度 |
| 事件与证据协议 | 类型化路由、因果关联、提交/观测边界 | 固定数据库、日志 UI、评分算法 |
| 故障传播 | 不允许必需能力失效后伪装 ready | 隐式换插件、清状态、吞错误 |

kernel 中不得出现角色姓名、派系 ID、SLG 资源、memory 类型、供应商模型或具体 UI 页面。稳定的是机制及不变量，具体功能实现均由 module 提供。

授权、事实提交、预算、审计等是必需 capability 的契约；它们的 provider 可以替换，调用和校验流程不能绕过。换 provider 必须保持契约语义，不能用“替换授权模块”把所有权限默认放行。

## 3. 全职能边界表

| 模块族 | 负责的能力 | 不应依赖的实现 |
|---|---|---|
| game/world | 世界状态、规则裁决、状态变化计划 | 具体模型、renderer、研究页面 |
| game/map | 地点、道路、可达与通行查询 | 屏幕坐标和 PixiJS 对象 |
| game/clock | 逻辑时间、暂停/单步与到期触发建议 | 模型网络耗时、客户端帧率 |
| game/resources | 资源种类、预留/消耗/返还规则 | 具体 UI 数值展示或某 NPC 私账 |
| game/actions | 运输、救援、修复等行动贡献与结果 | 某 NPC 专用 executor 副本 |
| game/agreements | 提案、确认、履约与改约规则 | 自动替所有角色回忆合同 |
| game/comms | 对话、消息、广播、证据分享与知识授权 | 替角色决定说什么、绕过受众规则 |
| game/scenario | 局势卡、前置条件、受众与补偿计划 | 不可见的强制剧情胜负 |
| game/save | 一致检查点、导入/迁移协调 | 任意复制正在写的数据库文件 |
| agent/runtime（宿主固定，不在 catalog） | mailbox、turn 管线、模型/工具受控调用 | 任一 memory/model 的内部实现 |
| agent/cognition | 感知、记忆、context、压缩、decision、调度 | 全量世界数据库、相邻模块深层文件 |
| agent/models | 集中 models/mounts、purpose 路由、共享资源限额 | 角色人格、个人会话共享 |
| agent/tools | 共享定义、主体 binding、执行与 receipt | 绕过世界 command authority |
| platform/runtime | scope、授权策略、command 协调、任务与配额 provider | 玩家 UI 或模型策略内部 |
| platform/research | 观测档案、评估协议与 run 管理、评分、调试查询 | 改变正在观察的业务结果 |
| client/features | 场景、输入、HUD、对话、人物册、必要设置 | 服务端数据库、凭据、未公开剧情 |
| console/features | 模型挂载、三势力剧情运营、观测、评估、调试、模块装配页面 | 凭隐藏按钮提供安全保证 |
| adapters | HTTP/WS、SQLite/artifact、模型传输、图形后端 | 向业务 port 泄露第三方内部类型 |

表中是职责族，不要求每行或每个函数成为独立 npm package。独立替换或有独立状态/配置价值的能力才形成模块；最小版本可让一个模块提供一组高度相关的 ports，但绑定和所有权必须可检查。run/branch/manifest 的创建、持久化与冻结由服务端宿主（`apps/server/src/host`）协调，评估协议与报告由 `platform.evaluation` 模块提供；两者不是同一层。`packages/experiment` 只负责准备实验环境：加载并交叉检查内容包、名册、RunSpec、profile、toolset、模型布局与实验规格，不创建 run、分支或 manifest。

## 4. 静态依赖方向

| 消费方 | 允许依赖 |
|---|---|
| packages/contracts | 必需的纯类型/schema 基础依赖，不依赖宿主和功能实现 |
| packages/kernel | contracts 和通用运行机制，不依赖 modules 或游戏内容 |
| packages/module-sdk | contracts、kernel 的受控公共接口，不反向加载实现 |
| packages/client-sdk / client-protocol | 浏览器宿主辅助与网络适配接口，不含世界规则 |
| packages/authority / agent-runtime / observability | 服务端固定机制，不 import 具体模块实现，也不依赖 `packages/experiment` 的加载实现；observability 目前是只导出包名的保留包，trace、span 与证据协议在 contracts 的 `api-observe.ts` |
| packages/experiment | contracts 与文件/YAML 读取；只做加载与交叉检查，不 import kernel、运行时或具体模块实现 |
| 一个职能模块 | 按 realm/kind 使用 [技术栈](../delivery/tech-stack.md) 第 2 节的源码与包依赖白名单 |
| apps/client 的组合根 | 客户端 module 的公开定义、client-sdk 与通用宿主 |
| apps/server 的组合根 | 服务端 module 的公开定义、authority/agent-runtime 与通用宿主 |
| apps/console 的组合根 | 控制台 module 的公开定义、client-sdk 与通用宿主；不持有服务端对象 |

模块只能通过 requires 声明的 typed port 获得依赖；直接 import 另一个模块的实现、跨目录 deep import、通过全局 service locator 取依赖都不允许。requires 可以依赖 port，不能指定“调用某文件里的私有函数”。服务端规则处理器拿到的端口视图只包含该模块自身的 provides 与 requires；访问未声明的游戏能力立即失败，源码访问与 requires 的差异由 `pnpm check:catalog` 对账。

公共 DTO、port 和协议 schema 归 contracts；内容包各文件的 schema、内容索引、名册与已解析 profile 的形状同样归 contracts，加载与交叉检查的实现归 `packages/experiment`。模块私有 configSchema 和内部类型归模块自身。新增参数不应迫使修改 kernel；新增公共语义才升级对应契约。避免把所有业务类型塞进一个巨型公共对象。

SDK/数据库/PixiJS 类型停在适配器内部，不能进入世界领域接口。纯算法优先复用现有无状态公共接口；新增公共库须先更新依赖白名单，不借“共享库”绕过状态和权限边界。

## 5. 两个本地端口与三个运行域

下表描述现行浏览器部署。Godot 部署只监听服务端端口，玩法、研究与服务端仍各有运行域。见 [two-endpoints.md — 原生 Demo 部署目标](two-endpoints.md#原生-demo-部署目标)。

| 端点/域 | 地址或归属 | 能力 |
|---|---|---|
| 玩家客户端 | http://127.0.0.1:5173 | 灰盒游戏、交互、必要设置（浏览器 client realm） |
| 服务端 HTTP | http://127.0.0.1:3000 | API、WS、控制台资产；Node server realm |
| 服务端控制台 | 同端口 /console/* | 浏览器 console realm，模型挂载/运营/观测/评估/调试 |

现行浏览器模式仅使用表中的两个监听端口。控制台是服务端提供的界面，不代表浏览器执行世界规则或持有模型密钥。console 与 server 即使同源仍跨进程，必须经 API/WS port 通信。端口、origin、角色与设置的完整契约见 [两个本地端口与三运行域](two-endpoints.md)。

每个执行域有本地 composition root 和 registry；共享装配规范不等于跨进程共享 DI 对象。client/console 模块依赖远程能力的 transport port，不直接注入 Node 对象、数据库连接或 server ModuleInstance。

连接与页面职责见 [双端部署](two-endpoints.md)，场景接口见 [客户端与渲染](client-and-rendering.md)。

## 6. 模块之间怎样交互

| 交互 | 适用范围 | 约束 |
|---|---|---|
| typed query port | 本域顺序读取/计算 | 授权与冻结版本明确，不通过 query 写世界 |
| typed command port | 有副作用的请求 | 服务端身份、幂等、读集、版本和 receipt |
| 已提交事件 | 通知变化、异步唤醒 | 有序事实、outbox/inbox、至少一次投递与去重 |
| module contribution | 页面、工具、规则 handler、事件订阅 | 由宿主登记所有权、检查冲突并返回 disposer |
| HTTP/WS transport | client/console 与 server | 只传序列化协议、受众投影和游标 |

事件驱动不等于把每次函数调用广播出去。内部纯计算使用 port，跨功能变化通过已提交事件传递；不能靠订阅全局事件偷看秘密，也不能用事件顺序代替声明依赖。

多个规则模块参与一次动作时，各自只通过 authority 提供的事务内接口（`WorldTx`）登记自己拥有的状态变更，并经对方的 ops 修改对方的状态；authority 在同一个事务里统一提交或回滚（[领域模型](domain-model.md) 第 4 节）。模块不能各自提交半个世界结果，导致资源预留和任务不一致。

## 7. 状态所有权与隔离

世界状态、感知观察、个人 memory、模型视图、审计副本和 UI 本地状态分别归属对应模块。换 UI 不改记忆；换 memory 不改世界真值；换世界规则是显式规则版本变更，不能伪装成 memory 参数。

每份状态登记 owner、scope、schemaVersion、导出/迁移路径。主体认知使用 world/branch/agent；UI 偏好可按设备/玩家作用域；连接池和账号额度允许部署共享，但不得保存跨 Agent 私密会话。

共享 ToolDefinition 实现一次，ToolBinding 按主体注册；共享 models 条目通过 mounts 解析，不复制 provider 参数。代码和只读定义可复用，可写执行状态不隐式共享。具体协议见 [工具](../agent/tools.md) 和 [模型池](../agent/model-pool.md)。

实验 run 独占 branch。索引、缓存、后台任务、导出和 artifact 与主数据使用相同的隔离规则，不只隔离主表。换模块所需的状态准备发生在新分支或显式维护边界。

## 8. 替换验收必须覆盖游戏和界面

- 换一个地图/通行 provider，玩家命令和 Agent 工具仍使用相同 port；差异由规则版本与结果解释。
- 换时钟 provider，在相同受控 tick 脚本下结果可重建；真实排队耗时不变成剧情时间。
- 换存档或持久化 provider，快照、inbox、jobs、revision 与 receipt 契约仍成立。
- 换场景 renderer、HUD 或人物册模块，卸载后无残余订阅，世界/Agent 结果不变。
- 换模型池、memory、context 或工具视图，不复制 runtime 或执行器，实际差异可在 trace 查看。
- 换观测、评估或调试页面/实现，不改变世界事实；正式实验缺关键证据时显式 invalid。
- 换控制台页面或模块装配面板，不改变 trace/评估数据生成；玩家会话仍被拒绝。
- 按运行模式核对[监听端口](two-endpoints.md)。控制台静态资源和 API 由 TS 服务端提供。

首版每个必需功能先有一个合法默认 provider；“可插拔”需要契约和替换证据，不要求立即实现所有功能的多个高级算法。至少以游戏规则/时钟、渲染/界面和 Agent 三类替换示范证明边界。

## 9. 架构守门

架构边界由 `pnpm check` 中的 `check:boundaries` 与 `check:catalog`、启动期绑定校验和契约测试共同守门。检查失败时修正所有者模块、依赖方向或契约，不增加宽泛 allowlist 绕过。下文的共享契约名单与表名白名单只在检查器内维护，只登记有代码和文档依据的条目；检查器同时反向核对条目仍然有效，即共享契约仍由所有者包声明、登记的表仍被模块源码引用，过期条目同样报错。

`pnpm check:boundaries` 只读取 workspace 包清单与手写源码文本，不执行被检查代码，违规输出带规则编号：

| 规则 | 检查内容 |
|---|---|
| 1 | 跨包引用只走已声明的公开入口，workspace 依赖须写进包清单，禁止深层导入与跨包相对路径 |
| 2 | 模块按 realm/kind 白名单使用源码与包依赖；模块定义文件不静态加载实现 |
| 3 | 浏览器 realm 不引用 Node 内置模块、服务端专属包与服务端第三方库 |
| 4 | kernel 与 contracts 不引用模块包、宿主应用与 React、PixiJS、Fastify 等实现库 |
| 5 | 宿主应用只在 `src/host/module-catalog.ts` 引用模块包 |
| 6 | 包依赖无环，依赖声明与源码使用一致，禁止非字面量动态导入 |
| 7 | 手写源码带中文文件头，非测试源文件不超过 500 行，个别豁免须写明理由 |
| 8 | 共享契约唯一定义 |
| 9 | 服务端模块源码表名白名单 |

规则 8 维护跨包共享契约名单及每个名字的唯一所有者包。名单目前包括访问裁决类型 `AccessAction`、`AccessRequest`、`AccessDecisionReason`、`AccessDecision`、`AccessPolicy`，上下文段名与段预算 `ContextUserSegmentKind`、`ContextSegmentKind`、`contextSegmentBudgetsSchema`，宿主注入面与存储端口 `HostServices`、`StoragePort`、`StorageTransaction`，以及宿主绑定给模块的 `GameContent`、`SavePort`、`ObservabilitySources`。其他包的生产源码再声明同名的 `interface`、`type`、`class`、`enum`、函数或变量即失败；导入、再导出、注释和字符串不算声明。扫描覆盖服务端与浏览器两个 realm 的 workspace 包：浏览器 realm 按白名单不能导入 module-sdk 等服务端专属包，归这些包所有的名字对浏览器源码不生效，归 contracts 所有的名字在浏览器源码中同样不得重复声明。六个客户端模块各自声明的 `WorldViewLike` 没有可导入的所有者，不在名单内。

规则 9 扫描 `modules/server` 下各模块 `src` 中的表引用，包括存储事务的 `.table("t")`、`.rows("t")` 调用，以及字符串中 SQL 的 FROM、JOIN、INTO、UPDATE 子句。模块只能引用白名单中登记在它名下的表，未登记的模块不能引用任何表；表名来自变量或模板插值时无法静态核对，同样失败。当前登记如下：

| 模块 | 可引用的表 | 依据 |
|---|---|---|
| `game.clock.controlled` | `clock` | 时钟 provider 拥有该表 |
| `game.save.sqlite` | `snapshots`、`branches`、`runs`、`world_aliases` | 快照写 `snapshots` 行；恢复时归档旧在线分支、写新的 `live` run 并切换 `online` 别名，见 [存储](storage.md) 第 3 节 |
| `agent.model-pool.shared` | `model_attempts`、`runs` | 每次尝试写一行 `model_attempts`；归档失败或进程中断时把 run 标记为证据不完整，见 [模型池](../agent/model-pool.md#124-预算与费用) |
| `platform.budget.standard` | `budget_ledger` | 预算 provider 拥有预留与结算账本 |
| `platform.observability.sqlite` | `trace_spans` | 其他数据经 `ObservabilitySources` 读取，见 [存储](storage.md#4-常用查询) |

`platform.storage.sqlite` 实现 storage port 本身，迁移、分支复制、备份与按表名读写覆盖全部表，是唯一豁免。宿主 `apps/server` 与 authority、agent-runtime、module-sdk 等固定机制包按存储文档各自拥有多张表并负责跨表协调，不在规则 9 范围内。

`pnpm check:catalog` 用与宿主启动相同的 kernel 解析器校验模块目录与 `config/assemblies` 下的全部装配，装配层面的检查项见 [模块目录](module-catalog.md#10-目录守门与验收)。它还对账服务端模块源码访问的能力与 provides/requires 声明：访问未声明或目录中不存在的能力、写下不合语法的能力 ID、声明了却从未访问的 requires，以及用非字面量键读取端口容器（如 `ports[key]`、`asPorts(context)[key]`、`const { [key]: port } = context.modules`），都会在启动前失败。端口容器按名字识别，包括 `ports`、`modules` 与以 `Ports` 结尾的名字；把容器转存到其他名字后再索引、或经 `Object.values` 等方式枚举，不在识别范围。浏览器 realm 经 client-sdk 的 `usePort` 取端口，不做这项对账。

静态扫描之外，还有三项约束在启动期或类型检查中执行：

- 宿主绑定游戏端口时比对模块定义与规则贡献各自声明的 `ownsAggregates`，集合不一致即在启动期失败并列出差异，违规用例见 `tests/integration/game-port-binder.test.ts`；
- `tests/contract/host-services-surface.test.ts` 锁定 `HostServices` 的字段全集，存储与模型只能经 requires 声明的 typed port 获得，该断言在 `pnpm typecheck` 中求值；
- 缺失、循环或重复绑定在 ready 前拒绝，规则处理器拿到的端口视图只含自身 provides 与 requires，访问其他能力立即失败。

验收不只问“memory 能换吗”，而是问“新增或替换一个游戏、界面、基础设施或 Agent 功能时，是否只变该模块、显式 catalog/装配与配置，是否无需修改其他实现”。若公共 port 不足，先评审升级影响，不能靠 any 或万能 WorldContext 穿透边界。

目录和扩展工作流见 [code-structure](code-structure.md)，完整能力覆盖见 [module-catalog](module-catalog.md)，交付验收见 [roadmap-and-acceptance](../delivery/roadmap-and-acceptance.md)。
