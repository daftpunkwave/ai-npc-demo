# 全平台模块装配、设置与冻结清单

> 目标规范。本篇拥有配置对象关系、生效边界和双端设置工作流。可替换单元覆盖游戏、Agent、平台服务、客户端、后台视图和适配器；module 不是 memory 的别名。

## 1. 配置对象与所有者

| 对象 | 负责什么 | 规范拥有者 |
|---|---|---|
| module catalog | 可用 ModuleDefinition、版本、能力、生命周期 | architecture/module-catalog 与 plugins |
| module assembly | 三 realm 当前选择哪些职能实现、能力绑定、参数与依赖连接 | architecture/composition 与本篇 |
| world pack | lore、地图、规则数据、角色、局势版本 | game 与 events-and-state |
| roster | 激活身份、profileRef、toolsetRef | game/characters |
| Agent profile | 组合内某类 Agent 的策略子配方、预算 | agent 专篇与 composition |
| connections/models | 供应商连接、模型能力、参数和资源限额 | agent/model-pool |
| mounts | modelId + agentIds + purposes | agent/model-pool |
| toolsets/bindings | 共享 ToolDefinition 引用与调用限制 | agent/tools |
| player preferences | 语言、声音、镜头、通知等纯展示偏好与测试 preset | 客户端 settings module |
| console layout/roles | 控制台页面贡献、默认角色与面板布局 | console 模块与 two-endpoints |
| RunSpec / resolved manifest | 选择上述版本与初态 / 完整冻结解析结果 | 本篇与 evaluation |

ModuleDefinition 是所有 realm/所有职能的统一注册描述符；模块私有 configSchema 随自身描述符，新增私有参数不修改所有共享契约。公共 DTO/port/schema 归 contracts。

## 2. 全平台装配与 Agent 子配方

RunSpec 的 moduleAssemblyRef 选择全平台组合，包括 game、agent、platform、client、console、adapters 类职能实现及其配置/连接。Agent profile 只描述主体策略子配方，不能暗中决定整个世界的地图、时钟、持久化或 UI 实现。assembly 文件为 `server`、`client`、`console` 三段；浏览器 host 连接后通过 `GET /api/v1/session/assembly?realm=...` 取得本域 resolved 模块清单并验证本地可信 catalog，不满足则拒绝 ready，见 [两个本地端口](../architecture/two-endpoints.md)。

Agent profile 层级保持平台基线 → 场景 profile → 可复用 Agent profile → 实验 variant patch。全平台 assembly 变体也必须声明改变的模块/连接/参数，不能通过扫描顺序覆盖；具体模块引用和 cardinality 以 [组合规范](../architecture/composition.md) 为准。

指定配置块整体替换、数组整体替换，不隐式深合并。defaults 只填 schema 明确允许省略的字段。未知 ID/字段、错误单位、重复定义、不兼容 port、依赖环、必需能力缺失、冲突 provider 均拒绝预检；不静默选第一个实现。

models/mounts 由 modelLayoutRef 集中选择，不是 Agent profile 的隐式覆盖层。roster 不嵌 provider/model/credential，mounts 不覆盖人格或权限。purposes 为 decision、speech、memory-maintenance、compression、embedding；evaluation 使用独立 evaluator，不进入 gameplay mounts。

## 3. RunSpec 目标示例

~~~yaml
schemaVersion: 1
id: watergate-memory-ledger
moduleAssemblyRef: local-slg-standard-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: standard-20
modelLayoutRef: shared-model-layout-v1
player:
  principalId: player-1
  factionId: human-neutral
mode: closed-loop
initialState:
  kind: snapshot
  snapshotRef: watergate-common-start
variant:
  id: ledger
  profilePatchRef: memory-ledger-v1
clock:
  kind: controlled
failurePolicy: strict
~~~

这是目标格式，引用内容与模块必须在实现时实际存在并通过 schema/能力校验。clock.kind 是所选时钟模块声明支持的运行模式，不选择另一套隐式时钟实现。对 console/UI 贡献的选择也进入 assembly 版本，不能靠隐藏硬编码菜单补足缺模块。

每个新实验 run 独占 branchId，不允许指定复用活动分支。live 接收自由玩家输入，closed-loop 使用冻结脚本；冷启、快照、合法观察历史重建分别声明，不混用。玩家设置与 console 布局不属于 RunSpec；它们可即时生效，但不能改变 assembly、规则或世界状态。

## 4. 双端设置分工

玩家入口为 http://127.0.0.1:5173；服务端控制台为 http://127.0.0.1:3000/console/*。API 与 WebSocket 由同一服务端监听器提供，不另启配置、运营或实验 Web 端口。

| 入口 | 功能模块提供的设置 | 不允许的操作 |
|---|---|---|
| 玩家 settings（`:5173`） | 显示/语言、声音、镜头、输入辅助、暂停/保存、获准的测试 preset | 密钥编辑、全知视角、直接热换运行中 provider |
| 服务端模块装配（`:3000/console`） | 全平台 module 选择、依赖/能力、配置 diff、生命周期与迁移计划 | 绕过最终 guard、静默卸载必需能力 |
| 服务端模型池（console） | 连接别名、模型配置、能力验证、批量挂载 | 向玩家下发 credentials、逐 Agent 复制模型参数 |
| 服务端剧情运营（console） | 三个非人类势力席位、事件卡、世界时钟/存档 | 修改已发布历史而不留记录 |
| 服务端研究（console） | trace/请求响应、评估、重放、断点/单步和故障定位 | 调试真值自动进入角色知识 |
| 控制台会话/角色（console） | 登录、角色切换、面板布局 | 因本机访问跳过鉴权；用隐藏菜单替代授权 |

这些页面均由 console 类模块贡献到后台宿主的 route/panel/action slots；替换面板不改变对应 runtime provider。前端和服务端分别校验自身依赖，浏览器视图只能经 API 消费服务端能力，不直接实例化数据库或 model 模块。

## 5. 模型、工具与角色设置

先定义 connections/models，再在模型卡片下勾选多个 Agent 和 purposes。UI 同时提供“模型→挂载主体”和“角色→已解析模型”视图。移走某主体的用途后再新增挂载；重复键不靠后者覆盖。

Agent 策略参数、游戏规则模块参数、剧情策略、调度、存档与感知参数，都从对应 ModuleDefinition.configSchema 生成表单和帮助。通用表单无法表达时可贡献专有编辑器，但提交仍用相同 schema 校验。

ToolDefinition 实现只登记一次，toolset/binding 引用定义并收窄能力；工具面板展示 effective permissions 与 viewConstraints。切换 UI 不得改执行权限，编辑 binding 不能将角色提升为阵营控制器。

玩家五派开局与 roster preset 在新 campaign/明确分支边界选择。standard-20 是完整 roster，core-3 仅开发/诊断，不能把关闭面板等同于主体未激活。

## 6. 预检和预览

1. 校验单玩家、内容引用、20 gameplay 身份总配额和正式世界唯一别名；确认只有两个本地端口。
2. 解析全平台 assembly：三 realm 实现存在、API/port 版本相容、连接 cardinality 正确、无依赖环，必需能力有唯一或显式有序 provider；catalog 快照 hash 与 assembly hash 可复算。
3. 校验 client/console 贡献的 slot、requiredCapabilities、remote 依赖与运行侧；浏览器模块不能要求服务端内存对象或凭据。
4. 解析 Agent profile、模型挂载和工具 binding；缺用途、能力不兼容、超模型窗口或越权约束均拒绝。
5. 校验世界/观察/记忆 frontier、状态 schema 与迁移路径；不能换 provider 后清库冒充成功。
6. 校验预算、任务/监听/人数配额、持久化和必需 artifact 可用；所有资源先预留后激活。
7. 展示 requested/resolved diff、影响主体、realm、必需停止项、迁移/回滚计划和预计调用预算，用户能看懂究竟换了哪块积木。

纯 dry-run 不创建活动主体、不改世界、不发模型请求；连通性探测为独立、有预算且留痕的测试。缺依赖的可选 UI 可显示不可用；缺必需 runtime provider 不能进入 ready。

## 7. 冻结清单与实际生效

manifest 保存 module assembly、每模块 ID/实现版本/配置 hash、runtime/client/console 侧、port 连接与内容版本；同时保存 roster/派系、Agent 子配方、模型池去密钥快照/挂载、tool binding、prompt/schema/tokenizer、初态 frontier、时钟、随机源、脚本、失败策略与停止规则。连接过世界的 client/console assembly hash 一并记录，便于解释 UI/控制台差异。

requested 是用户选择，resolved 是装配解析，effective 是本阶段实际使用。effective 与 applied/skipped/failed 在运行证据中追加，不回写覆盖 manifest；只记录模块名字不足以重建组合。

界面必须显示“当前运行”“草稿”“下个运行生效”和配置来源。观测面板被隐藏不代表观测 provider 未运行；也不能因为 registry 有模块就声称本次经过了它。

## 8. 生效、替换与迁移

纯展示偏好可即时生效且不改变运行组合。更换任何功能实现、依赖连接、模型挂载、规则/内容版本或工具权限时，先准备新 assembly/run/后继 branch；暂停、fence、快照、排空/导出、显式迁移/重建、预检后切换。不得把草稿保存当热更新成功。

必需 provider 不可直接拔除；必须拒绝卸载，或先显式停止/解除依赖整个组合。可撤销注册不是任意状态兼容的承诺，drain/dispose 与跨进程 UI 卸载分别留记录。

密钥轮换可保持 credentialRef，记录修订，不入 manifest 明文；供应商后台变化仍可能破坏可比性，记录可获模型指纹/请求标识。

## 9. 验收

换一项游戏规则、存档、镜头、HUD、控制台页面或 memory 实现都只修改模块自身/装配配置，无需改无关模块；UI 编辑和运行校验使用同一 schema。缺必需能力时启动/卸载都显式失败。两个端口承担全部界面/API/WS；玩家设置无后台权限；模型批量挂载不串状态；从 manifest 可重建同一组合。浏览器页面不得因为本机访问获得服务端角色，端口/会话校验见 [两个本地端口](../architecture/two-endpoints.md)。

模块细节见 [模块边界](../architecture/modules.md)、[插件机制](../architecture/plugins.md)、[积木组合](../architecture/composition.md)、[双端口](../architecture/two-endpoints.md)。
