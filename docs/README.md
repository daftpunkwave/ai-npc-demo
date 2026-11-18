# 文档导航

本页负责目录导航、阅读路径与主题归属。项目介绍和架构图见 [README.md — 项目概览](../README.md)；各子目录的 README 提供完整文件索引，不在此重复维护。

## 1. 全局入口

| 文档 | 用途 |
|---|---|
| [00-scope-and-invariants.md — 范围与不变量](00-scope-and-invariants.md) | 确认范围、数量、术语与比较基线 |
| [AGENTS.md — 开发规范](../AGENTS.md) | 查询工程约束、验证要求与 Git 工作流 |

## 2. 目录导航

| 目录入口 | 职责 |
|---|---|
| [game/README.md — 世界、玩法与规则](game/README.md) | 世界背景、角色、玩法、规则与内容数据 |
| [game/art-direction.md — 美术与表现资源](game/art-direction.md) | 世界资产包、派系徽记、风格与冲突记录 |
| [architecture/README.md — 架构与模块契约](architecture/README.md) | 宿主、插件、装配、公共契约、持久化与双端协议 |
| [agent/README.md — 认知与行为](agent/README.md) | 感知、记忆、上下文、工具、决策与模型调用 |
| [platform/README.md — 配置、研究与运营](platform/README.md) | 配置冻结、观测、实验评估与运营控制 |
| [delivery/README.md — 工程实施与验收](delivery/README.md) | 技术栈、实施顺序、测试与交付判据 |
| [references/README.md — 来源与设计决策](references/README.md) | 参考依据、借鉴边界与设计取舍 |

## 3. 阅读路径

| 目标 | 建议顺序 |
|---|---|
| 了解项目 | [README.md — 项目概览](../README.md) → [00-scope-and-invariants.md — 范围与不变量](00-scope-and-invariants.md) → [architecture/README.md — 架构导览](architecture/README.md) |
| 开发实现 | [AGENTS.md — 开发规范](../AGENTS.md) → [tech-stack.md — 技术栈与约定](delivery/tech-stack.md) → [build-plan.md — 构建计划](delivery/build-plan.md)，再按步骤阅读所列规格 |
| 研究评估 | [memory.md — 记忆](agent/memory.md) → [evaluation.md — 评估与实验](platform/evaluation.md) → [observability.md — 观测与档案](platform/observability.md) |
| 运营与策划 | [game/README.md — 游戏导览](game/README.md) → [content-pack.md — 内容包](game/content-pack.md) → [operations.md — 运营与恢复](platform/operations.md) |

## 4. 负责关系：每个主题只有一个负责文档

其他文档只引用负责文档，不复制它的定义。发现两处说法不一致时，以负责文档为准，并修正另一处。

| 主题 | 负责文档 |
|---|---|
| 范围、数量、术语、memory 基线 | [00-scope-and-invariants.md — 范围与不变量](00-scope-and-invariants.md) |
| 游戏规则与数值 | [rules.md — 游戏规则与数值](game/rules.md) |
| 初始数据、剧情卡、名册、实验脚本、模板文件结构 | [content-pack.md — 内容包](game/content-pack.md) |
| 命令、事件、聚合归属、受众、投影、原因码 | [domain-model.md — 领域模型](architecture/domain-model.md) |
| 事务、投递、水位、快照的语义 | [events-and-state.md — 事件、状态与恢复](architecture/events-and-state.md) |
| 表结构与分支复制 | [storage.md — 存储](architecture/storage.md) |
| 通用类型与错误码 | [contracts.md — 公共契约](architecture/contracts.md) |
| HTTP 与 WebSocket 接口 | [api.md — 接口](architecture/api.md) |
| 模块清单、默认装配、替换演示 | [module-catalog.md — 模块目录](architecture/module-catalog.md) |
| 目录与包结构 | [code-structure.md — 代码结构](architecture/code-structure.md) |
| 端口、鉴权、控制台页面 | [two-endpoints.md — 双端部署](architecture/two-endpoints.md) |
| 客户端交互与渲染 | [client-and-rendering.md — 客户端与渲染](architecture/client-and-rendering.md) |
| turn 管线、调度、确定性决策 | [runtime.md — 运行时](agent/runtime.md) |
| 记忆 / 感知 / 上下文 / 压缩与工具视图 | [memory.md — 记忆](agent/memory.md) / [perception.md — 感知](agent/perception.md) / [context.md — 上下文](agent/context.md) / [compression-and-tool-view.md — 压缩与工具视图](agent/compression-and-tool-view.md) |
| 工具定义、绑定、工具清单 | [tools.md — 工具](agent/tools.md) |
| prompt 模板与模型输入输出 | [prompts.md — Prompt 与对白](agent/prompts.md) |
| 模型路由、排队、预算 / 线协议 | [model-pool.md — 模型池](agent/model-pool.md) / [model-transport.md — 模型传输](agent/model-transport.md) |
| 配置文件格式与预检 | [configuration.md — 配置与冻结](platform/configuration.md) |
| 观测、档案、脱敏 | [observability.md — 观测与档案](platform/observability.md) |
| 实验、指标、报告 | [evaluation.md — 评估与实验](platform/evaluation.md) |
| 暂停、存档、席位、剧情运营 | [operations.md — 运营与恢复](platform/operations.md) |
| realm/kind 依赖白名单、技术栈与源码 header | [tech-stack.md — 技术栈与约定](delivery/tech-stack.md) |
| 共享 Agent 工作流、Git 授权与本地补充边界 | [AGENTS.md — 开发规范](../AGENTS.md) |
| 实施顺序与完成判据 | [build-plan.md — 构建计划](delivery/build-plan.md) |
| 切片验收 | [roadmap-and-acceptance.md — 切片验收](delivery/roadmap-and-acceptance.md) |

## 5. 文档维护约定

- 目录 README 负责导航，主题文档负责定义；修改定义时同步引用方，不在入口复制规则正文。
- 文档链接使用“原始文件名 — 中文名称”；阅读路径和跨文档指引提供可点击跳转。未存在的目标文件、代码示例与无可访问地址的来源记录不伪造链接。
- 新增、移动或重命名文档时，更新所属目录索引；改变主题归属时同步本页第 4 节及引用方。
- 明确区分设计规格与实测结果，不把计划或验收要求表述为已验证能力。
- 变更后检查相对链接、标题锚点和差异格式；检查命令及适用阶段见 [build-plan.md — 构建计划](delivery/build-plan.md)。未运行的检查如实说明。
