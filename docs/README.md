# Agent NPC 设计与验证平台

> 文档基线 v0.3，2026-11-18。首版是单玩家、统一世界观的 TypeScript 全栈 2.5D 游戏，最多 20 个 gameplay Agent。只有两个本地端口：玩家客户端 `:5173`，服务端 `:3000`（控制台在 `/console`）。当前是设计规范，没有运行时和实测数据。

游戏提供选择与后果，平台用来验证 Agent 的记忆、感知、上下文、压缩、模型和行为设计。目标是让 NPC 按自己的立场与经历行动，也让开发者查得清某个效果来自哪里、代价多少。

可插拔范围是全部职能，不只记忆。宿主只保留主板机制，游戏规则、地图、时钟、行动、剧情、Agent 认知、模型、工具、客户端界面、控制台页面和基础设施都通过明确的 port 接入，可以按装配替换。可以拿主机和 USB 设备作类比：接口稳定、设备可换、拔插受生命周期约束，但主机不让设备绕过安全与提交规则。

## 文档地图

| 分区 | 文档及职责 |
|---|---|
| 全局基线 | [首版范围、不变量与术语](00-scope-and-invariants.md) |
| 游戏 | [背景与势力](game/background.md)、[玩法与五派开局](game/gameplay.md)、[游戏规则系统](game/systems.md)、[20 个 Agent / 12 个 NPC 角色册](game/characters.md) |
| 系统架构 | [总览与七个决策](architecture/overview.md)、[事件/状态/恢复](architecture/events-and-state.md)、[公共契约](architecture/contracts.md) |
| 模块体系 | [模块边界](architecture/modules.md)、[全职能模块目录](architecture/module-catalog.md)、[插件机制](architecture/plugins.md)、[积木组合](architecture/composition.md) |
| 双端部署 | [两个本地端口与三运行域](architecture/two-endpoints.md)、[客户端与 2.5D](architecture/client-and-rendering.md)、[目标代码目录](architecture/code-structure.md) |
| Agent | [运行时与决策](agent/runtime.md)、[共享行为工具](agent/tools.md)、[集中模型池与挂载](agent/model-pool.md) |
| 认知模块 | [记忆](agent/memory.md)、[上下文](agent/context.md)、[压缩与工具视图](agent/compression-and-tool-view.md)、[世界环境感知](agent/perception.md) |
| 平台与控制台 | [配置与装配](platform/configuration.md)、[完整观测档案](platform/observability.md)、[评估与对比](platform/evaluation.md)、[运营/暂停/接管](platform/operations.md) |
| 交付与依据 | [阶段计划和验收](delivery/roadmap-and-acceptance.md)、[真实来源与设计决策](references/sources-and-decisions.md) |

阅读顺序：先读基线和游戏，再依次读总览、双端、模块边界、模块目录、插件、组合、各个 Agent 模块和验收。每类规则只由一份文档维护，其他文档引用；共同名词放在基线，跨模块数据放在 contracts，模块参数放在各自文档。

## 模块体系

模块化解决职责与依赖。模块是替换单位，建了多少目录不算证据。每个模块要有明确的 capability、port、状态所有权、配置 schema 和测试；模块之间不 import 实现，也不靠全局单例取依赖。严格解耦优先：内聚和可替换性冲突时拆开，必要的协议依赖必须版本化、可检查。

插件化解决打包、注册与生命周期。模块以可信插件包交付，由组合根显式登记，宿主校验 id、version、apiVersion、能力闭包、realm 和实例作用域后放进 catalog。拔插分三档：纯展示模块可以即时换；无状态页面在空闲边界换；有状态模块要先暂停、快照或导出，再进入新 run 或后继 branch。首版不支持上传任意不可信代码。

积木化解决装配与冻结。assembly 选择 server、client、console 三个 realm 的模块、能力绑定和配置引用；profile 只负责 Agent 认知子配方；models/mounts 与 toolsets/bindings 分别管理共享资源和共享行为。resolved manifest 冻结所有可比较条件，改变 server 模块或可比较配置必须新 run，不能热切在途 turn；无状态 client/console 模块可在空闲边界替换，但必须与当前 server assembly 兼容并记录 assembly hash。

双端分域解决信任边界。玩家客户端 `:5173` 只拿授权投影和必要设置；服务端 `:3000` 承载模型池、三个非人类势力的剧情运营、可观测/可评估/可调试的控制台和全部权威写入。控制台复用服务端端口，不新增第三个服务。浏览器域不持有密钥、数据库连接或世界权威。

~~~mermaid
flowchart LR
  CAT["module catalog"] --> ASM["assembly：server / client / console"]
  CONTENT["world pack / roster"] --> ASM
  ASM --> RUN["run + frozen manifest"]
  RUN --> MOD["modules"]
  MOD --> WORLD["authority 世界命令与事件"]
  MOD --> TRACE["trace / 证据 / 评估"]
  CLIENT["client :5173"] -->|"授权投影/命令"| RUN
  CONSOLE["console :3000/console"] -->|"控制台 API"| RUN
~~~

## 贯穿全项目的边界

角色是主体，模型是可挂载的资源。先配置连接和模型池，再把多个 Agent 的 decision/speech 等用途挂到同一个 modelId 上；同一个 Agent 也可以按用途挂不同模型。角色档案不复制 provider、型号、温度和密钥。共享模型只共享资源配置与额度，不共享记忆、消息或供应商私密会话。

行为只定义一次，按角色注册和授权。侦察、情报查询、递信、交涉、派遣、救援等工具只有一份 ToolDefinition/executor，多个 Agent 的 ToolBinding 引用它，并收窄对象、能力、预算和可见结果。执行仍然走同一套世界规则，换个工具名字绕不过权限。

世界只有一个，视角因人而异，实验互相隔离。所有主体使用同一份 lore 和正式世界，每个主体有自己的感知和记忆。实验 run 独占 branch，不污染正式世界；审计库里的真值不能直接变成 NPC 的知识。

## 设计如何进入游戏

玩家选五个人类派系之一，作为驻灰港特派员参与“水闸之前”。通过交涉、证据、承诺、护送、救援和修复影响局势；十二位角色各自记得不同经历，八个战略主体处理政策与外交。三个非人类势力（巡裔、根庭、泊星者）的剧情走向由服务端控制台的运营席位管理。玩家不是第 21 个 Agent。

首个对比轴是 M0 无长期记忆、M1 结构化账本、M2 记忆流/反思、M3 分层混合。先固定其他条件，再比较 NPC 的行动、关系、履约和体验；之后扩展上下文、感知、压缩、工具信息量和模型轴。游戏规则、客户端 UI、控制台页面也可以作为独立装配轴。

完整运行激活 20 个身份时，实验先暂停正式世界，再逐个分支执行。20 个身份不等于 20 个并发模型请求；调度器和集中模型池共同控制调用成本、优先级和背压。

## 准确性与交付边界

文档里的目录、接口、schema、模型布局和模块装配都是目标设计。配置示例标注为目标格式，引用必须在实现时真实存在并通过预检；不能据此声称游戏已经运行、模型已经连接或某种记忆方案最优。

已经核对过父项目的记忆资料、agent-prism 源码和固定版本的 deepseek-harness，并区分了可借鉴的机制和本项目新增的设计；外部模式来源见独立参考篇。首版不以多人联机、穷举全部实验轴或复杂数值系统作为完成条件。

实施时先交付两个端口和三个核心角色的最小闭环，再让 memory 成为可比较的实验轴，最后完成五派开局、12 个角色、20 个身份、共享工具、模型池和全模块替换证据。失败、未完成、降级和未测试项都要如实报告。
