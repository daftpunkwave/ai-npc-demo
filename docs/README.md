# Agent NPC 设计与验证平台

> 文档基线 v0.3｜2026-11-18。首版：单玩家、统一世界观、TypeScript 全栈、2.5D 俯视角；最多 20 个 gameplay Agent。两个本地端口：玩家客户端 `:5173`，服务端 `:3000`（含控制台）。当前为设计规范，尚无运行时与实测成绩。

游戏提供选择与后果，平台验证 Agent 的记忆、感知、上下文、压缩、模型和行为设计。目标是让 NPC 因自己的立场与经历采取行动，并让开发者能查清效果来自哪里、代价多少。

本项目的可插拔范围是**全部职能模块**，不只是记忆：基础宿主保留主板机制，游戏规则、地图、时钟、行动、剧情、Agent 认知、模型、工具、客户端界面、控制台页面与基础设施都通过明确 port 接入，可按装配替换。用主机与 USB 设备作类比：接口稳定、设备可换、拔插有生命周期与状态迁移约束，但主机不会让设备绕过安全与提交规则。

## 文档地图

| 分区 | 文档及职责 |
|---|---|
| 全局基线 | [首版范围、不变量与术语](00-scope-and-invariants.md) |
| 游戏 | [背景与势力](game/background.md) · [玩法与五派开局](game/gameplay.md) · [游戏规则系统](game/systems.md) · [20 Agent / 12 NPC 角色册](game/characters.md) |
| 系统架构 | [总览与七个决策](architecture/overview.md) · [事件/状态/恢复](architecture/events-and-state.md) · [公共契约](architecture/contracts.md) |
| 模块体系 | [模块边界](architecture/modules.md) · [全职能模块目录](architecture/module-catalog.md) · [插件机制](architecture/plugins.md) · [积木组合](architecture/composition.md) |
| 双端部署 | [两个本地端口与三运行域](architecture/two-endpoints.md) · [客户端与 2.5D](architecture/client-and-rendering.md) · [目标代码目录](architecture/code-structure.md) |
| Agent | [运行时与决策](agent/runtime.md) · [共享行为工具](agent/tools.md) · [集中模型池与挂载](agent/model-pool.md) |
| 认知模块 | [记忆](agent/memory.md) · [上下文](agent/context.md) · [压缩与工具视图](agent/compression-and-tool-view.md) · [世界环境感知](agent/perception.md) |
| 平台与控制台 | [配置与装配](platform/configuration.md) · [完整观测档案](platform/observability.md) · [评估与对比](platform/evaluation.md) · [运营/暂停/接管](platform/operations.md) |
| 交付与依据 | [阶段计划和验收](delivery/roadmap-and-acceptance.md) · [真实来源与设计决策](references/sources-and-decisions.md) |

阅读顺序：先读基线与游戏，再按“总览 → 双端 → 模块边界 → 模块目录 → 插件 → 组合 → 具体 Agent 模块 → 验收”进入实现。每类规则只有一个拥有者，其余页面引用；共同名词由基线维护，跨模块数据由 contracts 维护，专有参数由所属模块维护。

## 四种组织方式

**模块化：职责与依赖。** 模块是替换单位，不是目录数量。每个模块有明确 capability、port、状态所有权、配置 schema 和测试；模块之间不 import 实现，不通过全局单例偷依赖。严格脱耦优先：当内聚与可替换性冲突时优先拆开；必要的协议依赖必须版本化、可检查。

**插件化：打包、注册与生命周期。** 模块以可信插件包交付，组合根显式登记，宿主校验 id/version/apiVersion/能力闭包/realm/实例作用域后进入 catalog。拔插分级：纯展示可即时换；无状态页面在空闲边界换；有状态模块必须暂停、快照/导出、新 run 或后继 branch。首版不支持上传任意不可信代码。

**积木化：装配与冻结。** assembly 选择 server/client/console 三 realm 的模块、能力绑定与配置引用；profile 只负责 Agent 认知子配方；models/mounts 与 toolsets/bindings 分别管理共享资源与共享行为。resolved manifest 冻结一切可比较条件，换模块必须新 run，不能热切在途 turn。

**双端分域：两个端口、三个运行域。** 玩家客户端 `:5173` 只拿授权投影与必要设置；服务端 `:3000` 承载模型池、三势力剧情运营、可观测/可评估/可调试控制台与全部权威写入；控制台复用服务端端口，不新增第三服务。浏览器域不持有密钥、数据库或世界权威。

## 三个核心边界

**角色是主体，模型是可挂载的资源。** 先配置连接与模型池，再将多个 Agent 的 decision/speech 等用途挂载到同一 modelId；同一个 Agent 也可按用途挂载不同模型。角色档案不复制 provider、型号、温度和密钥。共享模型只共享资源配置与额度，不共享记忆、消息或供应商私密会话。

**行为定义一次，按角色注册与授权。** 通用侦察、已知情报查询、递信、交涉、派遣、救援等工具只有一份 ToolDefinition/executor；多个 Agent 的 ToolBinding 引用它，并收窄对象、能力、预算和可见结果。具体执行仍走同一世界规则，不能靠工具名字绕过权限。

**世界唯一，视角不同，实验隔离。** 所有主体使用同一 lore 和正式世界；每个人有独立感知与记忆。实验 run 独占 branch，不污染正式世界；审计库中的真值不能直接成为 NPC 的知识。

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

## 设计如何进入游戏

玩家选五个人类派系之一，作为驻灰港特派员参与“水闸之前”。通过人物交涉、证据、承诺、护送、救援和修复影响局势；十二位角色各自记得不同经历，八个战略主体处理政策与外交。三个非人类势力（巡裔、根庭、泊星者）的剧情走向由服务端控制台的运营席位管理。玩家不是新增 Agent。

首个对比轴为 M0 无长期记忆、M1 结构化账本、M2 记忆流/反思、M3 分层混合。先固定其他条件，再比较 NPC 的行动、关系、履约与体验；随后扩展上下文、感知、压缩、工具信息量和模型轴；游戏规则、客户端 UI、控制台页面也可作为独立装配轴。

完整运行激活 20 身份时，实验先暂停正式世界再逐分支执行。20 身份不是 20 个并发模型请求；调度器和集中模型池共同控制调用成本、优先级与背压。

## 准确性与交付边界

文档中的目录、接口、schema、模型布局与模块装配均为目标设计。配置示例明确标注目标格式，引用必须在实现时实际存在并通过预检；不能据此声称游戏已经运行、某模型已连接或某种记忆最优。

已核对父项目记忆资料、agent-prism 源码与固定版本 deepseek-harness，并区分可借鉴机制和本项目新增设计；外部模式来源见独立参考篇。首版不以多人联机、全部实验轴穷举或复杂数值系统作为完成条件。

实施时先交付两个端口与三个核心角色的最小闭环，再让 memory 成为真正有效的比较轴，最后完成五派开局、十二角色、二十身份、共享工具、模型池与全模块替换证据。所有失败、未完成、降级和未测试项必须如实报告。
