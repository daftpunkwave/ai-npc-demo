# 文档导航

> **权威链**为设计、切片范围、工程文档，按该顺序裁决冲突。仓库内的 [design/README.md — 炉边议会](design/README.md) 是游戏设计权威，[00-scope-and-invariants.md — 序章切片范围](00-scope-and-invariants.md) 定义 Demo 范围，工程文档规定实施方式。
> 本页负责目录导航、阅读路径与主题归属。项目介绍见 [README.md — 项目概览](../README.md)；各子目录 README 提供完整文件索引，不在此重复维护。

## 1. 三层结构与全局入口

| 层 | 位置 | 回答什么 | 冲突时 |
|---|---|---|---|
| 目标设计 | [design/](design/README.md) | 这个游戏是什么：世界、玩法、数值、派系、角色、多人、资产 | **最高** |
| 切片范围 | [00-scope-and-invariants.md](00-scope-and-invariants.md) | Demo 做哪一段、做到什么程度、哪些不做 | 服从设计 |
| 工程实现 | [architecture/](architecture/README.md)、[agent/](agent/README.md)、[platform/](platform/README.md)、[delivery/](delivery/README.md) | 宿主、模块、Agent 运行时、观测、验收怎么搭 | 服从前两层 |

| 文档 | 用途 |
|---|---|
| [design/README.md — 完整游戏设计（权威）](design/README.md) | 世界、玩法、数值、派系、角色、多人、资产的目标设计 |
| [00-scope-and-invariants.md — 序章切片范围与不变量](00-scope-and-invariants.md) | 范围、15 个上场身份、6 种资源边界、验收与术语 |
| [IMPLEMENTATION-STATUS.md — 实现状态](IMPLEMENTATION-STATUS.md) | 已交付能力与代码、内容的迁移缺口 |
| [design/STRUCTURE.md — 设计目录与维护规则](design/STRUCTURE.md) | 三层结构、目录映射、不实现清单与维护规则 |
| [AGENTS.md — 开发规范](../AGENTS.md) | 工程约束、验证要求与 Git 工作流 |

## 2. 目录导航

| 目录入口 | 职责 |
|---|---|
| [design/README.md — 完整游戏设计](design/README.md) | 世界、玩法、议事、支持与吞并、城建、外交、多人、资产（设计权威） |
| [game/README.md — 序章切片规格](game/README.md) | 序章的世界摘要、15 人编制、玩家循环、结算规则与内容契约 |
| [game/art-direction.md — 表现与资产方向](game/art-direction.md) | 3D 斜俯视目标、2.5D 灰盒的定位、徽记与资产 P0 |
| [architecture/README.md — 架构与模块契约](architecture/README.md) | 宿主、插件、装配、公共契约、持久化与双端协议 |
| [agent/README.md — 认知与行为](agent/README.md) | 感知、记忆、上下文、工具、决策与模型调用 |
| [platform/README.md — 配置、研究与运营](platform/README.md) | 配置冻结、观测、实验评估与运营控制 |
| [delivery/README.md — 工程实施与验收](delivery/README.md) | 技术栈、实施顺序、测试与交付判据 |
| [references/README.md — 来源与设计决策](references/README.md) | 参考依据、借鉴边界与设计取舍 |

## 3. 阅读路径

| 目标 | 建议顺序 |
|---|---|
| 了解完整游戏 | [design/README.md](design/README.md) → [game-overview.md](design/game-overview.md) → [canon.md](design/world/canon.md) → [01-cycle-and-opening.md](design/gameplay/01-cycle-and-opening.md) |
| 了解 Demo 做哪一段 | [README.md](../README.md) → [00-scope-and-invariants.md](00-scope-and-invariants.md) → [game/README.md](game/README.md) → [game/gameplay.md](game/gameplay.md) |
| 开发实现 | [AGENTS.md](../AGENTS.md) → [tech-stack.md](delivery/tech-stack.md) → [build-plan.md](delivery/build-plan.md)，再按步骤阅读所列规格 |
| 写序章规则 | [game/rules.md](game/rules.md) → [game/content-pack.md](game/content-pack.md) → [domain-model.md](architecture/domain-model.md) |
| 做多人（设计层） | [design/multiplayer/README.md](design/multiplayer/README.md) → [01-seats-and-clock.md](design/multiplayer/01-seats-and-clock.md) → [02-authority-economy-fairness.md](design/multiplayer/02-authority-economy-fairness.md) |
| 排资产 | [design/assets/README.md](design/assets/README.md) → [01-inventory.md](design/assets/01-inventory.md) → [02-modeling-spec.md](design/assets/02-modeling-spec.md) |
| 研究评估 | [memory.md](agent/memory.md) → [runtime.md](agent/runtime.md) → [evaluation.md](platform/evaluation.md) → [observability.md](platform/observability.md) |
| 运营与策划 | [game/content-pack.md](game/content-pack.md) → [operations.md](platform/operations.md) → [design/gameplay/05-chapter.md](design/gameplay/05-chapter.md) |

## 4. 负责关系：每个主题只有一个负责文档

其他文档只引用负责文档，不复制它的定义。发现两处说法不一致时，以负责文档为准，并修正另一处。

| 主题 | 负责文档 |
|---|---|
| 世界、玩法、数值、派系、角色、多人、资产（目标设计） | [design/README.md](design/README.md) |
| 切片范围、15 个上场身份、资源边界、术语 | [00-scope-and-invariants.md](00-scope-and-invariants.md) |
| 序章可结算规则与数值 | [game/rules.md](game/rules.md)；目标数值以 [design/balance/01-baseline.md](design/balance/01-baseline.md) 为准 |
| 序章世界背景摘要 | [game/background.md — 世界背景（序章摘要）](game/background.md)；完整设定以 [design/world/background.md — 世界背景](design/world/background.md) 为准 |
| 序章表现与资产使用 | [game/art-direction.md — 表现与资产方向](game/art-direction.md)；目标 3D 与资产口径见 [design/assets/README.md — 资产总纲](design/assets/README.md) |
| 序章初始数据、剧情卡数据（cardId/trigger/effects）、名册、脚本、模板 | [game/content-pack.md](game/content-pack.md)；ID 以 [design/world/canon.md §13](design/world/canon.md#13-id-对照表) 为准 |
| 15 人编制、人格契约、关系与验收 | [game/characters.md](game/characters.md)；完整 43 具名身份以 [design/characters/roster.md](design/characters/roster.md) 为准 |
| 序章玩家循环、t144 表决；九张卡的玩家决策 | [game/gameplay.md](game/gameplay.md)；设计意图见 [design/gameplay/05-chapter.md](design/gameplay/05-chapter.md) |
| 命令、事件、聚合归属、受众、投影、原因码 | [domain-model.md](architecture/domain-model.md) |
| 事务、投递、水位、快照的语义 | [events-and-state.md](architecture/events-and-state.md) |
| 表结构与分支复制 | [storage.md](architecture/storage.md) |
| 通用类型与错误码 | [contracts.md](architecture/contracts.md) |
| HTTP 与 WebSocket 接口 | [api.md](architecture/api.md) |
| 模块清单、默认装配、替换演示 | [module-catalog.md](architecture/module-catalog.md) |
| 目录与包结构 | [code-structure.md](architecture/code-structure.md) |
| 端口、鉴权、控制台页面 | [two-endpoints.md](architecture/two-endpoints.md) |
| 客户端交互与场景适配 | [client-and-rendering.md](architecture/client-and-rendering.md)；目标 3D 见 [design/gameplay/06](design/gameplay/06-player-experience.md) 与 [design/assets/02](design/assets/02-modeling-spec.md) |
| turn 管线、调度、确定性决策 | [runtime.md](agent/runtime.md) |
| 记忆 / 感知 / 上下文 / 压缩与工具视图 | [memory.md](agent/memory.md) / [perception.md](agent/perception.md) / [context.md](agent/context.md) / [compression-and-tool-view.md](agent/compression-and-tool-view.md) |
| 工具定义、绑定、工具清单 | [tools.md](agent/tools.md) |
| prompt 模板与模型输入输出 | [prompts.md](agent/prompts.md) |
| 模型路由、排队、预算 / 线协议 | [model-pool.md](agent/model-pool.md) / [model-transport.md](agent/model-transport.md) |
| 配置文件格式与预检 | [configuration.md](platform/configuration.md) |
| 观测、档案、脱敏 | [observability.md](platform/observability.md) |
| 实验、指标、报告 | [evaluation.md](platform/evaluation.md) |
| 暂停、存档、席位、剧情运营（Demo） | [operations.md](platform/operations.md)；多人席位/托管/权威见 [design/multiplayer/02](design/multiplayer/02-authority-economy-fairness.md) |
| realm/kind 依赖白名单、技术栈与源码 header | [tech-stack.md](delivery/tech-stack.md) |
| 共享 Agent 工作流、Git 授权与本地补充边界 | [AGENTS.md](../AGENTS.md) |
| 实施顺序与完成判据 | [build-plan.md](delivery/build-plan.md) |
| 已交付能力与迁移缺口 | [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) |
| 切片验收（Demo） | [roadmap-and-acceptance.md](delivery/roadmap-and-acceptance.md)；整局验收见 [design/gameplay/05](design/gameplay/05-chapter.md) 与 [design/gameplay/16](design/gameplay/16-campaign-arc.md) |
| 参考依据、借鉴边界与设计取舍 | [references/README.md — 来源与设计决策](references/README.md) |
| 序章模块映射与可替换边界 | [game/systems.md — 职能边界](game/systems.md) |

## 5. 文档维护约定

1. **设计改动只改 `docs/design/`。** 它是仓库内唯一的设计权威，不设外部镜像，也不从仓库外同步。
2. **切片范围的改动只改 `00-scope-and-invariants.md`。** 各工程文档引用它，不复制范围定义。
3. **规则数值只有一个来源。** 序章的阈值、日耗、门槛与加成写在 [game/rules.md](game/rules.md)；初始库存与内容数据写在 [game/content-pack.md](game/content-pack.md)；设计目标值写在 `design/balance/`。三处不重复定义同一组数字。
4. **序章文档只定义切片内的规则。** 切片外系统的入口与接口以 [00-scope-and-invariants.md — 序章切片范围](00-scope-and-invariants.md#1-切片范围) 为准。
5. **文档链接使用“原始文件名 — 中文名称”。** 未存在的目标文件、代码示例与无可访问地址的来源不伪造链接。
6. **变更后运行 `pnpm check:docs`。** 它检查根 `README.md`、`AGENTS.md`、服务端 README 和 `docs/**/*.md` 的相对链接、标题锚点与 Markdown 表格列数。
7. **交付进度集中维护。** 已交付范围与迁移缺口记录在 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](IMPLEMENTATION-STATUS.md)。计划、导航与主题规格引用该页。接口条目可就地标注可用性。实施顺序和完成判据见 [build-plan.md — 构建计划](delivery/build-plan.md)。
