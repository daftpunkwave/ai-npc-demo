# 序章切片范围与全局不变量

> **权威链**见 [README.md — 文档导航](README.md#1-三层结构与全局入口)。本文定义 **Demo 序章切片** 的实现范围与工程不变量。
> 三者冲突时：设计 > 本文 > 工程文档。发现冲突先改拥有该规范的文档，再同步引用；不能在代码里悄悄选择另一套语义。
> 当前实现与本文的差距单独记在 [实现状态](IMPLEMENTATION-STATUS.md)，它是迁移清单，不是第二套规则。

## 1. 切片范围

《炉边议会》的 Demo 是设计第 1 季第 1 周（序章《水闸之前》，t0–167）的垂直切片。它验证三件事：Agent 能否按立场、记忆与授权行动；玩家能否把话变成可执行的条款；世界能否被观测、复现与评估。

| 事项 | 切片定义 | 设计依据 |
|---|---|---|
| 产品 | 用轻数值 SLG 验证 Agent 在游戏中的应用；游戏本身是“基础宿主 + 全职能模块”的示范 | [概览](design/game-overview.md) |
| 玩家 | **灰港公社党魁**，占 `seat.commune`，手里一票；不是旁观者，也不是市长 | [核心循环](design/gameplay/01-cycle-and-opening.md) |
| 可玩范围 | 序章七日 t0–167：九张局势卡、三项读数、任务与协议、t144 一项程序案、t168 评估 | [序章](design/gameplay/05-chapter.md) |
| 切片终点 | t168 评估后**切片结束**；设计上此刻进入第 1 季第 2 周，开放世界不在本切片内 | [序章](design/gameplay/05-chapter.md) |
| 世界 | 一个共享世界观版本；一个正式世界状态，实验在隔离分支运行 | [设定速查表](design/world/canon.md) |
| 派系 | 五个人类派系同城共治；本切片只开放公社席，其余四席由 AI 党魁运行 | [派系索引](design/factions/README.md) |
| Agent | 每局 **15 个**：本派 8 名支持者 + 4 名 AI 党魁 + 3 名外域 Agent | [43 具名身份名册](design/characters/roster.md) |
| NPC 名册 | 43 个具名身份（40 人类 + 3 外域）；15 个上场，28 个以简报、传闻、证人、替补出现 | [名册](design/characters/roster.md) |
| 时间 | 1 tick = 1 游戏小时；**20 秒/tick**；1 日 8 分钟；序章七日约 56 分钟 | [速查表](design/world/canon.md) |
| 地图 | 序章加载近城 **6 节点、9 条路**；外域 7 节点、7 条路在 t168 后启用 | [灰港地图](design/world/grayharbor.md) |
| 资源 | 设计共 6 种；序章只结算 **供给、能源、医疗** 三种库存；材料、食物、水在 t168 按设计初值起算 | [序章结算边界](design/gameplay/05-chapter.md) |
| 表现 | Godot 原生 Demo 以正式 **3D 斜俯视**画面验收，重新设计玩家界面、交互和美术。现行 2.5D 等距版本用于灰盒验证 | [界面与镜头](design/gameplay/06-player-experience.md)、[原生玩家端](architecture/client-and-rendering.md#9-godot-原生玩家端) |
| 部署 | 原生目标为 Godot 玩家进程直连唯一的本机 TS 服务端监听 `127.0.0.1:3000`，控制台复用 `/console/*`。现行网页部署另用 `127.0.0.1:5173` | [原生部署目标](architecture/two-endpoints.md#原生-demo-部署目标) |
| 运营 | 三个外域（巡裔、根庭、泊星者）可由 Agent 或真人控制；控制台从 `:3000/console` 操作 | 本文第 2 节 |
| 研究 | 控制台提供可观测、可评估、可调试内容；玩家客户端只获得授权投影 | [评估](platform/evaluation.md) |

**切片范围以外**：城建与地块、正式法案与完整议程（序章仅含 t144 程序案）、世界导演及其战略指令和时代任务、支持态势与吞并、袭击与损毁修复、四季与寒潮、多人联机、开放世界的完整资产管线。序章的局势压力由剧情卡投放，整体范围与接口边界见 [STRUCTURE.md — 设计目录结构与维护规则](design/STRUCTURE.md#3-序章不实现的系统)。

### 1.1 15 个上场身份

| # | agentId | 显示名 | 类型 | 说明 |
|---|---|---|---|---|
| 1 | `npc-wenzhao` | 闻昭 | 本派支持者 | 行政主管 / 资深支持者 |
| 2 | `npc-yinuo` | 伊诺 | 本派支持者 | 通信官 / 广播 |
| 3 | `npc-wenyuan` | 温原 | 本派支持者 | 物资官 / 库房 |
| 4 | `npc-taoan` | 陶安 | 本派支持者 | 工务长 / 工程 |
| 5 | `npc-muzhi` | 穆枝 | 本派支持者 | 医政 / 医院 |
| 6 | `npc-luchen` | 陆沉 | 本派支持者 | 治安 / 民兵联络 |
| 7 | `npc-ahe` | 阿禾 | 本派支持者 | 配给 / 食堂 / 民意 |
| 8 | `npc-qilu` | 祁录 | 本派支持者 | 档案 / 记录 / 情报 |
| 9 | `human-independent` | 岑雁 | AI 党魁 | 砾火同盟 |
| 10 | `human-earth-alliance` | 林芜 | AI 党魁 | 地生共约 |
| 11 | `human-pacifist` | 唐箴 | AI 党魁 | 止戈议团 |
| 12 | `human-alien-accord` | 乔述 | AI 党魁 | 远星协进会 |
| 13 | `species-fauna` | 追风 | 外域 Agent | 巡裔 |
| 14 | `species-flora` | 青枝 | 外域 Agent | 根庭 |
| 15 | `species-extraterrestrial` | 洛 | 外域 Agent | 泊星者 |

- `agentId` 是运行身份；资产 `characterId` 是姓名拼音（`wenzhao`、`cenyan`…）。两者映射见 [速查表 §13](design/world/canon.md#13-id-对照表)。
- 名册首位人物的职责随席位控制权切换。玩家占公社席时，闻昭以 `npc-wenzhao` 担任资深支持者。其余四派各上场一名 AI 党魁，其他七名成员留在背景名册。
- 43 名册中未上场的 28 人仍然存在：他们以简报署名、传闻来源、证人、替补与编年史出现，不调用模型。

### 1.2 序章资源边界

| 资源 | 序章 | t168 起 |
|---|---|---|
| 供给 `supply` | 按库存点结算，任务预留与消耗 | 城市资源按设计初值起算 |
| 能源 `energy` | 按库存点结算，修复任务消耗 | 城市资源按设计初值起算 |
| 医疗 `medical` | 按库存点结算，救援预留 | 城市资源按设计初值起算 |
| 材料 `materials` | 不结算，只作为叙事与维修报价 | 纳入城市总量 |
| 食物 `food` | 不结算 | 纳入城市总量 |
| 水 `water` | 不结算，果园水量是独立仪表 | 纳入城市总量 |

序章独立结算切片库存。t168 交接时按设计初值重建六种城市资源，序章七日的消耗留在原库存账中。初值见 [01-baseline.md — 资源与仪表](design/balance/01-baseline.md#3-资源与仪表)。

## 2. 权威边界

1. 世界权威侧拥有 authority：资源、通行、时钟、伤势、合同与行动结果；权限由 `platform.access-policy` provider 裁决。
2. Agent 拥有 policy：感知后的解释、记忆、选择、协商、行动提案与台词意图。
3. 共享 lore 不等于共享秘密。每个 Agent 只获得其授权和感知范围内的信息。
4. Agent 不能写世界数据库；所有副作用经 tool gateway 和标准 command handler。
5. memory 遗忘只影响角色可读层，不能删除审计历史；角色能读审计库不属于正常能力。
6. 三个外域真人接管保留 agentId，递增 controllerEpoch，拒绝旧控制者的晚到命令。
7. 角色与派系是不同身份。派系意见必须传达后角色才知道；角色可在权限内拒绝或协商。
8. 模块不能绕过宿主 guard：授权、scope、预算、协议、提交、fencing 与证据顺序固定；换 provider 不等于放行。
9. 世界权威、数据库连接和模型密钥归服务端。玩家与控制台均经授权 HTTP/WS 协议访问服务端。
10. 服务端与控制台共享 `127.0.0.1:3000`。原生 Demo 的监听和进程边界见 [原生 Demo 部署目标](architecture/two-endpoints.md#原生-demo-部署目标)。
11. 单机也要保留席位和实际动作者的记录，供命令授权、事件追溯、授权投影和存档回放。参见 [02-authority-economy-fairness.md — 首版接口保留项](design/multiplayer/02-authority-economy-fairness.md)。

## 3. 配置、装配与实验边界

model 连接、型号、采样与限额集中在模型池；roster 不复制 provider/model/API key。mounts 为每个必需的 (agentId, purpose) 解析出唯一 modelId。共享模型不共享会话、KV cache 私密前缀、记忆或人格。

通用 purpose 为 decision、speech、memory-maintenance、compression、embedding；只为实际启用的能力要求绑定。evaluation 使用独立评估主体/配置，不混入 gameplay roster，不参与游戏行动。具体 schema 由 [模型池](agent/model-pool.md) 与 [配置](platform/configuration.md) 维护。

每个实验 run 独占 `branchId`，由服务端冻结装配、内容、名册及适用的 Agent 与模型配置。会话装配和运行清单的证据归属见 [配置冻结](platform/configuration.md#7-冻结清单与实际生效)。更换 memory、模型挂载、工具授权、内容版本或游戏规则必须新建 run 或后继分支。在途 turn 继续使用其冻结配置。

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
| assembly / 装配 | 三 realm 模块选择、能力绑定与配置引用的描述 |
| realm | `server` / `client` / `console` 三个运行域 |
| capability | 模块提供/消费的版本化能力 ID，如 `game.clock`、`agent.memory` |
| capability port / 能力端口 | 模块间 typed 接口；不是网络监听端口 |
| worldId / branchId / agentId | 世界、隔离分支、稳定自主身份；构成 MemoryScope |
| seatId / actorId | 席位（`seat.commune`）/ 实际动作者（AI 党魁与外域用 `factionId`，玩家派支持者用 `npc-<拼音>`） |
| worldSeq / worldTick | 分支内单调事实序号 / 持久化逻辑时间 |
| observationSeq | 某 Agent 获得观察的序号，映射到世界 frontier |
| causationIds / correlationId | 多来源因果引用 / 同一业务链关联 |
| controllerEpoch / turnLeaseEpoch | 控制者与单轮任务的 fencing 代次 |
| ToolDefinition / ToolBinding | 共享行为实现 / 主体注册与权限约束 |
| modelId / mounts | 可复用模型配置身份 / 模型与 Agent-purpose 的挂载关系 |
| trigger | 唤醒某个 Agent 的持久化原因，由调度器合并成 turn |
| 委托 Delegation / 通行许可 PassageGrant / 知识授权 | 派系授予主体动用队伍与库存的权限 / 受控道路的通行权 / 某主体获知某条证据或秘密的记录 |
| releasePolicyId | 一条资料能向谁披露的标签：public、parties、faction、holders、private |
| AgentWorldView / PlayerProjection | Agent 的最后已知视图 / 玩家的授权投影，见 [领域模型](architecture/domain-model.md) 第 8 节 |
| decision_submit / speech.commit | decision 循环的收尾工具 / 宿主提交已校验对白的内部命令 |
| preset / variant patch | 一组命名的参数 / 实验时整块替换 profile 槽位的补丁 |
| 分支复制 forkBranch | 把一个分支的全部分支级数据拷贝成新分支，见 [存储](architecture/storage.md) 第 3 节 |

## 5. 验收与诚实性

架构要可插拔、可定位、可对比；记忆要影响行动、关系和承诺，不能只让台词变长。失败、降级、未应用选项和成本未知都要显式记录。所有数量、阈值、预算和时长都是初始配置，尚无实测最优结论。

在线、实验分支与探针沙盒共用 15 个活动 gameplay 身份的部署配额。暂停后仍处于激活状态的身份继续计入配额。参见 [operations.md — 故障与配额操作](platform/operations.md#9-故障与配额操作)。

下列为完整序章的验收目标。原生客户端替换以 [Godot 玩家端切换验收](delivery/roadmap-and-acceptance.md#godot-玩家端切换验收) 为准，迁移范围覆盖已公开玩法与现有控制台功能。尚未实现的表决、席位等继续列入完整序章目标。

完整序章验收至少包括以下结果。

1. 15 个身份全部可装载；缺任一必需 profile 时拒绝启动，不静默降级。
2. 玩家作为公社党魁能投出 t144 那一票；投票结果进入议事录。
3. 九张局势卡按设计时点触发；三项读数按 20 秒/tick 结算到 t168。
4. 序章只结算供给、能源、医疗三种库存；材料、食物、水在 t168 按设计初值出现。
5. 换 game 规则模块、换 client UI 模块、换 agent 认知模块、换 console 页面各一次，只改模块、装配与配置。
6. 监听范围按[部署模式](architecture/two-endpoints.md)验收，玩家授权投影与控制台角色权限分别核验。

只增加目录、包或接口数量不算模块化证据。详细实现验收由 [路线与验收](delivery/roadmap-and-acceptance.md) 统一维护，逐步实施与每步完成判据见 [构建计划](delivery/build-plan.md)。
