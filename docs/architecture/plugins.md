# 模块、插件与宿主契约

> 状态：部分实现。`packages/kernel` 与 `packages/module-sdk` 已支持描述符校验、能力解析、状态访问范围与生命周期；描述符校验位于 kernel，服务端 `module-sdk` 的 `defineModule` 与浏览器 `client-sdk` 的 `defineBrowserModule` 调用同一份，kernel 解析装配时也拒绝不属于本 realm 能力命名空间的绑定。首批 `server` 模块已接入，`client` 和 `console` 的宿主接入已实现。本文规定插件与宿主的通用契约。参见 [modules.md — 模块边界](modules.md)、[module-catalog.md — 模块目录](module-catalog.md)、[composition.md — 装配](composition.md)、[configuration.md — 配置](../platform/configuration.md)。

## 1. 术语：模块、插件、积木

| 术语 | 定义 | 在本项目中的用法 |
|---|---|---|
| 模块（module） | 具有明确能力、端口、配置 schema、状态与替换价值的功能单元 | 设计单位；不要求每个小函数都是模块 |
| 插件（plugin） | 一个或多个 ModuleDefinition 的可分发包，带版本、依赖与生命周期 | 交付/安装单位；首版全部为可信内置插件 |
| 积木（block/assembly） | 按声明组合模块、内容、roster、profile、模型挂载与工具的装配 | 运行单位；由 assembly 文件与冻结 manifest 表达 |

因此“模块化/插件化/积木化”不是三套机制：模块是职责，插件是打包，积木是组合。[公共契约](contracts.md) 中的 `ModuleDefinition` 是所有 realm、所有职能共用的唯一注册描述符，不另建并行 registry；Agent 专篇中的“插件”指模块包。

首版使用可信内置代码插件，启动时显式注册；不支持上传任意 JS。capability ports、描述符和 scope 是工程约束，不能阻止同进程恶意代码主动访问 Node 资源，因此不构成安全沙箱。第三方不可信执行需要另行隔离设计。

稳定宿主中的授权、配额、事实提交、预算、fencing、证据契约和实验有效性判定不可卸载。模块只能在内核已建立的边界内工作。

## 2. ModuleDefinition 契约

`ModuleDefinition` 是 TypeScript 宿主的插件描述符。Godot 使用 C# 本地描述符实现同样的显式能力与生命周期原则，见 [client-and-rendering.md — Godot 原生玩家端](client-and-rendering.md#9-godot-原生玩家端)。

字段、schema 与 TypeScript 类型以 [公共契约](contracts.md) 第 3 节为准；下面只说明各字段在注册、解析与运行中的用途，不另建第二份 schema。

| 字段组 | 用途与约束 |
|---|---|
| id / realm / kind / version | 稳定身份、运行域、模块类别与不可变实现版本；相同 id/version 不能注册不同实现 |
| apiVersion | 与宿主契约匹配；不能只凭模块版本猜兼容性 |
| instanceScope | deployment/run/branch/agent/session，决定实例生命周期与状态命名空间 |
| provides / requires | 提供与依赖的能力及基数；requiresRemote 仅浏览器 realm，经握手校验 |
| configSchema / defaults | 严格 schema；未知键拒绝，单位/范围/默认值可检查 |
| stateSchemaVersion / migrationPaths | 有状态实现声明状态版本与迁移；无状态实现显式声明无状态 |
| contributions | 工具、事件卡、slot/route/panel 等扩展点贡献及排序 |
| experimentAxes | 参数说明、显示顺序与可比较轴；UI 与评估共用同一描述符 |
| create | 接收已解析配置和最小宿主能力，返回对应 kind 的 typed instance |

代码层使用 kind 到 port 的映射，memory 工厂只能返回 MemoryPort，不能用 `any` 或万能 `execute(Json)` 掩盖协议。一个模块可声明多个能力，但必须分别有端口与配置；不能用一个“游戏核心”能力吞掉全部规则。

## 3. 模块类别与扩展点

| 类别 | 作用 | 例子 | 冲突规则 |
|---|---|---|---|
| `service` | 提供独占能力，被装配解析为唯一 provider | `game.clock.controlled`、`agent.memory.ledger`、`platform.budget.standard` | 同一 capability/实例出现两个默认 provider 即预检失败；fallback 必须显式 |
| `contributor` | 向宿主扩展点贡献条目，可并存 | 共享 ToolDefinition、事件卡、HUD 面板、控制台页面 | 贡献 ID 与 slot 可唯一；顺序显式声明 |
| `adapter` | 对接外部技术，把第三方类型关在内部 | SQLite、模型 HTTP、PixiJS、HTTP/WS | 实现同一 port；不支持的能力显式报错 |

扩展点包括：客户端宿主 slot（`scene`、`hud`、`dialogue`、`sidebar`、`modal`、`settings.section`、`notification`、`overlay`、`boot.screen`）、工具目录、事件卡目录、命令 handler、事件订阅、模型 purpose 路由、控制台 route/panel/action。每个扩展点由宿主定义 ID、基数、权限标签和 disposer 所有权；模块只在 definition 中声明贡献，运行期由宿主登记。

模块的 UI 贡献是 ModuleDefinition 的一部分（extensionId、slot、requiredCapabilities、order），不是第二套拥有独立权限的注册系统。

## 4. 注册、解析与冻结

1. 每个宿主创建实例级 Registry；禁止模块 import 时向进程全局 Map 自注册，禁止自动扫描全部目录并执行。
2. 组合根显式 import 可信模块定义并注册；注册返回精确 disposer，所有权属于本次宿主启动。
3. 校验重复 ID/版本、contract 兼容、参数 schema、能力闭包、realm 兼容、实例作用域、扩展点冲突；错误包含模块与原因。
4. 发布 catalog 的只读快照；客户端只接收本 realm 可公开描述符，不获得工厂、凭据或内部状态。
5. 创建 run/会话时解析 assembly、profile、模型/工具挂载；缺失实现、能力、必需 purpose 或非法组合拒绝启动。
6. 为本次 run 冻结已解析实例计划、模块版本、config hash 与 artifact 版本；后续 catalog 变化不能改变在途运行。
7. 先预留全平台 Agent 配额与模块资源，再创建状态与实例；失败按相反顺序释放，不能留下半个活动分支。
8. 浏览器 realm 连接时执行握手：server 返回本 realm 已解析模块清单与远端能力描述；客户端验证本地内置模块能满足，不满足则显示组合不完整，不静默降级。

同一模块定义可被多个主体引用，实例状态是否共享由 `instanceScope` 与契约明确规定。instanceScope 决定生命周期维度，不替代状态 scope：memory 实例的生命周期按 agent，但状态仍按 branch + agent 隔离。模型传输客户端可共享；工具定义为宿主共享，但调用上下文与 ToolBinding 永远按主体生成。

## 5. 生命周期、拔插与撤销

| 阶段 | 宿主行为 | 模块责任 |
|---|---|---|
| `create` | 注入已解析配置、scope、ports 和取消信号 | 初始化实例；不偷偷启动无法管理的后台循环 |
| `start` | 按依赖顺序启动，等待必要就绪条件 | 注册监听/任务，返回 readiness 或明确失败 |
| `running` | 驱动 typed 调用、预算、trace 和 fencing | 返回新值/计划，遵守幂等与取消契约 |
| `drain` | 停止新任务，设置短租约/期限并等待提交边界 | 排空短操作；长计算可取消并留下恢复记录 |
| `dispose` | 逆依赖释放资源，收回注册与配额 | 释放监听器、句柄和缓存；重复调用安全 |

“可插拔”按状态与阶段分级：

| 对象 | 允许的更换方式 |
|---|---|
| 纯展示偏好、主题、声音、通知 | 可在会话内即时切换，不影响运行组合 |
| 无状态客户端页面、只读控制台面板、可选 UI contributor | 在空闲边界卸载/装载，释放订阅与图形资源 |
| 有状态模块（memory、clock、scenario、storage、model transport） | 必须在暂停点：fence 在途输出、快照/导出、创建新 run 或后继 branch、预检后切换 |
| 必需能力 provider | 活动组合中不可拔空；先停止组合或准备兼容替代，再迁移状态 |
| 宿主固定 guard | 不可卸载、不可替换为放行实现 |

`dispose` 不是删除持久状态。旧分支的状态与 artifact 受保留策略管理，不能因模块实例退出而清库。移除工具 binding 后，已进入队列的调用不可继续执行；执行网关要重新核对 binding revision 与权限。

取消后晚到的模型/整理结果仍须通过 turn epoch、controller epoch 或 revision CAS。`AbortSignal` 只是合作式取消通知，不能用来证明副作用不会发生。启动失败、drain 超时和资源释放失败分别记录；必需实例未就绪时 realm 不可标成 ready，不能跳过失败模块后继续声称同一配置运行成功。

## 6. 宿主能力与不可绕过的 guard

普通模块获得：scoped storage、授权查询、受预算的模型调用、时钟/随机源、trace、配置读取，具体接口为 [公共契约](contracts.md) 第 3 节的 `ModuleCreateInput` 与 `HostServices`。storage adapter 的原始连接只由组合根注入；普通 memory/context/decision 不获得数据库句柄或全局 world 对象。

宿主固定执行以下顺序，模块不能把这些步骤设为可选 hook：

1. 认证与会话。
2. 解析主体、受众与 scope。
3. 按权限与知识边界过滤。
4. 校验输入 schema 与协议版本。
5. 做预算与并发准入。
6. 调用模块，执行纯计算、计划或查询。
7. 在服务端裁决命令并提交事务。
8. 复核 fencing、幂等与版本。
9. 归档证据并生成授权投影。

授权输入过滤、scoped state 与来源校验、预算与协议检查、模型/工具网关、命令裁决、受众安全对白发布，这个顺序在服务端不可跳过。模块可以拒绝自身输入，但不能把这些 guard 设为可选。

hook 分为 transform、guard、observe：transform 返回不可变新版本；guard 可拒绝；observe 只读。使用显式 stage 和 before/after 约束拓扑排序，冲突或环在预检报错；不能依赖注册顺序决定 prompt 顺序。模型上下文的 phase 字段仅使用 decision/speech，与处理 stage 分开。

模型调用必须通过集中模型池：gameplay 请求根据 `(agentId, purpose)` 解析挂载，evaluator 使用独立评估配置。模块不能自行读 provider 环境变量或另建 SDK client；embedding、反思和压缩等辅助请求也计入原主体/run 的成本与预算。工具实现以共享 ToolDefinition 注册，按 roster 的 `toolsetRef` 与主体策略建立 ToolBinding；调用前后保留完整结果，模型只接收 tool-view 处理后的授权视图。

## 7. scoped state 与迁移

主体可写认知状态的命名空间至少包含 `worldId`、`branchId`、`agentId`（如适用）、`moduleId` 与 `stateSchemaVersion`。部署共享资源另行声明，不能保存跨主体私密会话；查询、索引、缓存、导出与维护 jobs 使用一致 scope。

每个实验 run 独占一个 branch；同一 branch 不同时绑定两个 run。读取绑定冻结 frontier/revision，写入计划绑定 baseRevision 和来源；发布失败不能覆盖较新的记录。详见 [事件与状态](events-and-state.md) 与 [记忆](../agent/memory.md)。

更换有状态模块只在暂停点进行。用户明确选择冷启动、从合法观察重建或支持的迁移；宿主先创建新 branch，保留旧分支，再导入并验证状态、索引和水位。失败不切换在线别名，不静默清空记忆。

同版本导出/导入必须行为等价；跨版本必须有显式迁移路径和测试。不能因为 JSON 可以解析就认定语义兼容，也不能把无来源摘要迁移成已验证事实。适配器类模块（例如存储）的持久化 schema 由适配器自己的迁移机制管理，不属于主体 scoped state，因此不声明 `stateSchemaVersion` 与 `migrationPaths`；这两个字段只描述模块按主体 scope 导入导出的状态。

## 8. 跨 realm 与信任边界

| 规则 | 说明 |
|---|---|
| 模块只在所属 realm 加载 | server 模块不得进入浏览器 bundle；client/console 模块不得 import server 实现 |
| 浏览器模块能力来自协议 | 只能依赖 `client-protocol` 的类型化 API 与 `requiresRemote` 声明，不获得 Node 对象、数据库连接或密钥 |
| 控制台同源不等于同进程 | console 页面仍通过 API/WS 获得授权数据；不因 `127.0.0.1` 跳过会话与角色检查 |
| 凭据只在 server secret 路径 | 控制台只显示连接别名、能力与验证状态；manifest 只保存 credentialRef |
| 模块不能静默降级 | 缺必需能力拒绝 ready；可选模块失败显示原因；实验证据缺失判 invalid |
| 可信代码才有进程内权限 | 首版不加载外部不可信插件；未来第三方执行需独立进程/容器与独立权限模型 |

## 9. 扩展验收

- 注册：重复实现、未知参数、版本不兼容、能力缺失和 realm 冲突均在运行前失败。
- 隔离：伪造 scope、跨主体/分支查询、共享缓存串读、浏览器读取密钥均被拒绝。
- 一致性：重复 ingest 幂等，过期发布 CAS 失败，冻结 revision 不包含未来观察。
- 生命周期：启动失败回收资源；撤销后无残余监听/工具 binding；晚到输出无法提交。
- 有效性：trace 显示 requested/resolved/effective、applied/skipped/failed 及输入输出差分；必需阶段 skipped 不进入有效样本。
- 可替换：增加或替换模块只触及模块自身、组合根登记及配置，不修改领域规则或复制 runtime。
- 共享能力：多个 Agent 引用同一模型条目和工具定义，仍保有独立预算、权限、会话和 trace。
- 双端替换 client 或 console 模块时，只变更本域实现和装配。按 [部署规格](two-endpoints.md) 核对应用监听。

正式实验失败策略与报告分母见 [评估](../platform/evaluation.md)；交付入口见 [路线与验收](../delivery/roadmap-and-acceptance.md)。
