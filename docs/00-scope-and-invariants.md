# 首版范围与全局不变量

> 目标规范 v0.4，2026-11-18。范围、命名和数量以本文为准；各模块的细节由对应文档维护。目前只有文档，没有已实现的游戏、Agent 运行时或双端服务。实现从 [构建计划](delivery/build-plan.md) 开始。

## 1. 当前范围

| 事项 | 首版定义 |
|---|---|
| 产品 | 用轻数值 SLG 验证 Agent 在游戏中的应用；游戏本身也是“基础宿主 + 全职能模块”的示范 |
| 可插拔 | 不只是 memory：游戏规则、地图、时钟、资源、行动、协议、剧情、存档、Agent 认知、模型、工具、客户端 UI、控制台页面、存储与模型传输都通过模块/装配替换 |
| 宿主 | 三 realm 共享 contracts/kernel；宿主保留注册、能力图、生命周期、guard 顺序、版本/幂等/fencing、证据与配置冻结 |
| 部署 | 只有两个本地监听：玩家客户端 `127.0.0.1:5173`，服务端 `127.0.0.1:3000`（含 `/console/*` 控制台） |
| 玩家 | 单玩家；同一时刻一个玩家身份参与一个正式游戏世界 |
| 世界 | 一个共享世界观版本；一个正式世界状态，实验在隔离分支运行 |
| 开局 | 玩家选择五个人类派系之一，作为该派系的灰港特派员 |
| 表现 | TypeScript 全栈、2.5D 俯视等距地图、React 界面、独立场景适配层 |
| Agent | 标准完整 roster 为 20：5 个人类派系战略 Agent、3 个非人类势力战略 Agent、12 个角色 |
| NPC | 12 位有独立人格与记忆的可交互角色；战略 Agent 不额外冒充 12 位地图角色 |
| 上限 | 同一部署同时激活的 gameplay Agent 总数不超过 20，包含正式世界和实验 |
| 模型 | 集中定义 models，再通过 mounts 将多个 Agent 挂载到同一模型 |
| 行为 | 共享 ToolDefinition 实现一次；ToolBinding 按角色注册引用、约束与授权 |
| 运营 | 三个非人类势力（巡裔、根庭、泊星者）可独立选择 agent/human 控制；控制台从 `:3000/console` 操作 |
| 研究 | 服务端控制台提供可观测、可评估、可调试内容；玩家客户端只获得玩家投影与必要设置 |
| 规则与数据 | 首章规则与数值见 [规则](game/rules.md)，全部初始数据见 [内容包](game/content-pack.md) |
| 首版模块 | 以 [模块目录](architecture/module-catalog.md) 中“默认实现”与“首版还要交付”两类为准；标为 D 阶段的不做 |
| 首版不含 | 多人玩家联机、充值/活动、复杂战斗数值、第三方不可信插件执行、声音；美术资源按 [美术方向](game/art-direction.md) 的资产包交付（用户明确覆盖原范围） |

20 个身份是内容与系统上限，不等于 20 个并发推理请求。首个开发切片可以只激活三个核心角色，完整首版要覆盖标准 20 个身份和 12 个角色；必须写明所用的 roster preset，不能拿三个角色切片冒充完整交付。

满 20 个身份运行时，闭环实验先暂停正式世界、释放激活名额，再逐个分支执行，不额外启动一套 20 个 Agent。快照、审计回放和普通规则任务不算自主身份；辅助模型调用仍然计入资源和费用，不能借此创建隐藏子 Agent。

## 2. 权威边界

1. 世界权威侧拥有 authority：资源、通行、时钟、伤势、合同与行动结果；权限由 `platform.access-policy` provider 裁决。
2. Agent 拥有 policy：感知后的解释、记忆、选择、协商、行动提案与台词意图。
3. 共享 lore 不等于共享秘密。每个 Agent 只获得其授权和感知范围内的信息。
4. Agent 不能写世界数据库；所有副作用经 tool gateway 和标准 command handler。
5. memory 遗忘只影响角色可读层，不能删除审计历史；角色能读审计库不属于正常能力。
6. 三个非人类势力真人接管保留 agentId，递增 controllerEpoch，拒绝旧控制者的晚到命令。
7. 角色与派系是不同身份。派系意见必须传达后角色才知道；角色可在权限内拒绝或协商。
8. 模块不能绕过宿主 guard：授权、scope、预算、协议、提交、fencing 与证据顺序固定；换 provider 不等于放行。
9. 浏览器 realm 不持有世界权威、数据库连接或模型密钥；跨域只经授权 HTTP/WS 协议。
10. 两个本地端口是部署不变量；控制台复用服务端端口，不新增第三个 Web 服务。

## 3. 配置、装配与实验边界

model 连接、型号、采样与限额集中在模型池；roster 不复制 provider/model/API key。mounts 为每个必需的 (agentId, purpose) 解析出唯一 modelId。共享模型不共享会话、KV cache 私密前缀、记忆或人格。

通用 purpose 为 decision、speech、memory-maintenance、compression、embedding；只为实际启用的能力要求绑定。evaluation 使用独立评估主体/配置，不混入 gameplay roster，不参与游戏行动。具体 schema 由 [模型池](agent/model-pool.md) 与 [配置](platform/configuration.md) 维护。

每个实验 run 独占 branchId，运行时绑定冻结 manifest：三 realm 模块、内容、roster/profile、模型挂载、工具授权与实验设置。换 memory、模型挂载、工具授权、内容版本或游戏规则必须新 run/后继分支；不能修改在途 turn 的配置。

memory 基线统一为：

| 组 | 模块 / preset |
|---|---|
| M0 | `agent.memory.none`；baseline-window（`memory-m0-window`）为主要基线，baseline-current（`memory-m0-current`）为诊断基线 |
| M1 | `agent.memory.ledger` / structured-ledger（`memory-m1-structured-ledger`） |
| M2 | `agent.memory.stream-reflection`（`memory-m2-stream-reflection`） |
| M3 | `agent.memory.layered-hybrid`（`memory-m3-layered-hybrid`） |

其余槽先固定合法基线。上下文、压缩、工具视图、感知、调度、模型、游戏规则与客户端 UI 是后续独立实验轴；首版不要求穷举全部组合。

“模块存在”不等于“本次生效”。每个 run 冻结 requested/resolved，并在运行中记录 effective；被装配选择但未实际调用的模块、被阈值跳过的压缩、被权限过滤的观察必须分别可见。

## 4. 统一术语

| 名称 | 含义 |
|---|---|
| module / 模块 | 具有能力、port、配置与状态的替换单元 |
| plugin / 插件 | 一个或多个模块定义的可分发包；首版全部可信内置 |
| assembly / 积木组合 | 三 realm 模块选择、能力绑定与配置引用的装配描述 |
| catalog / 模块目录 | 某版本可用模块的全集与元数据 |
| realm | `server` / `client` / `console` 三个运行域 |
| capability | 模块提供/消费的版本化能力 ID，如 `game.clock`、`agent.memory` |
| capability port / 能力端口 | 模块间 typed 接口；不是网络监听端口。两个本地监听端口另称“网络端口”或“部署端口” |
| instanceScope | deployment / run / branch / agent / session |
| worldId / branchId / agentId | 世界、隔离分支、稳定自主身份；构成 MemoryScope |
| worldSeq | branch 内单调的事实序号；不同 branch 不能直接比较 |
| worldTick | 持久化逻辑时间；遗忘、截止与行动推进使用它 |
| observationSeq | 某 Agent 获得观察的序号，映射到世界 frontier |
| durableThroughSeq / derivedThroughSeq | 即时摄入与按策略应完成派生整理的水位 |
| inputFrontier / memoryRevision | 决策输入边界和不可变记忆视图 |
| causationIds / correlationId | 多来源因果引用 / 同一业务链关联 |
| controllerEpoch / turnLeaseEpoch | 控制者与单轮任务的 fencing 代次 |
| ToolDefinition / ToolBinding | 共享行为实现 / 主体注册与权限约束 |
| modelId / mounts | 可复用模型配置身份 / 模型与 Agent-purpose 的挂载关系 |
| ModuleDefinition / ResolvedModuleSet | 模块描述符 / 握手时可公开的已解析模块清单 |
| trigger | 唤醒某个 Agent 的持久化原因（玩家对话、邀请、到期提醒等），由调度器合并成 turn |
| 委托 Delegation / 通行许可 PassageGrant / 知识授权 | 派系授予某主体动用队伍与库存的权限 / 受控道路的通行权 / 某主体获知某条证据或秘密的记录 |
| releasePolicyId | 一条资料能向谁披露的标签：public、parties、faction、holders、private |
| AgentWorldView / PlayerProjection | Agent 的最后已知视图 / 玩家的授权投影，见 [领域模型](architecture/domain-model.md) 第 8 节 |
| decision_submit / speech.commit | decision 循环的收尾工具 / 宿主提交已校验对白的内部命令 |
| preset / variant patch | 一组命名的参数（如 `memory-m1-structured-ledger`）/ 实验时整块替换 profile 槽位的补丁 |
| 分支复制 forkBranch | 把一个分支的全部分支级数据拷贝成新分支，用于快照、恢复与实验，见 [存储](architecture/storage.md) 第 3 节 |

## 5. 验收与诚实性

架构要可插拔、可定位、可对比；记忆要影响行动、关系和承诺，不能只让台词变长。失败、降级、未应用选项和成本未知都要显式记录。所有数量、阈值、预算和时长都是初始配置，尚无实测最优结论。

首版验收必须至少证明：换 game 规则模块、换 client UI 模块、换 agent 认知模块、换 console 页面各一次，只改模块、装配与配置；两个端口之外无监听；玩家/控制台权限不串；缺必需模块时组合拒绝启动。只增加目录、包或接口数量不算模块化证据。

详细实现验收由 [路线与验收](delivery/roadmap-and-acceptance.md) 统一维护，逐步实施与每步完成判据见 [构建计划](delivery/build-plan.md)。发现文档冲突先修正拥有该规范的文档，再同步引用；不能在代码里悄悄选择另一套语义。
