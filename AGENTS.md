# Coding Agent 工作说明与规范总则

本项目是 TypeScript 全栈、单玩家轻数值 SLG 与研究控制台；3D 斜俯视是目标，2.5D 是序章灰盒。

## 最高指令与执行铁律（Meta-Directive）

本文件与 [.agents/rules/](.agents/rules/) 下的专项规范共同构成 AI Coding Agent 在本项目的强制执行准则。所有需求理解、代码编写、重构、审查、测试、提交以及 Pull Request 全生命周期维护，必须无条件遵循本项目规范，严禁变通、跳步或静默忽略。所有规则以本项目规范为准；若外部通用准则与本项目规范冲突，严格以本项目规范为准。

---

## 任何任务必须遵守的通用铁律（Universal Iron Laws）

无论任务类型、规模或涉及模块，所有 Agent 活动必须无条件恪守以下五大通用铁律：

### 1. 实证判断基准（Evidence-Based）
严格以实际代码、实际运行时行为、依赖关系和实际契约为依据进行判断；严禁仅凭代码表象、个人偏好或脱离上下文的教条式“最佳实践”臆断问题。每解决一个问题，必须严格执行四步确认（真实性 -> 影响风险 -> 预期行为 -> 最根本修复位置）。

### 2. 最小精准修改原则（Minimal & Precise Changes）
默认必须严格遵守最小精准修改原则，除非本次任务明确要求进行大型重构或大范围改动。在日常开发与维护中，只做任务要求的最小完整修改，不随意扩散修改范围，保持既有合理契约与模块边界。严禁为了迎合审查或指标而机械堆砌冗余判断、空壳接口、过度抽象或盲目重试。严禁新增未经批准的第三方依赖或外部服务。

### 3. 零推测与零残留交付（Zero Speculation & Zero Artifact Left Behind）
遇到架构未明确、依赖版本模糊或接口定义存疑时，立即停止猜测，先查源码配置、再查官方确切文档、最后向用户求证。交付前必须彻底清除临时调试输出（`console.log` 等）、废弃陈旧代码、临时 Mock 数据与遗留 `TODO`。

### 4. 对外内容与改动必须独立可读（Self-Contained & Independent Readability）
用户回复、提交信息（Commit）、PR 说明、Issue、审查意见及代码注释必须做到外部受众独立可读与复核。**严禁出现任何内部项目管理编号、构建计划步骤编号或阶段引用**（如禁止“完成 section 3.2”等）。必须聚焦于具体业务场景、代码变更与技术原因（Changed What & Why）。详见专项规范 [Git 提交与对外交付规范](.agents/rules/git/commit-standards.md#4-对外内容与改动必须独立可读)。

### 5. 分支安全与严格授权（Protected Branch & Strict Authorization）
`main` 是默认保护分支，严禁直接向 main 提交代码。提交、推送、创建 PR 与合并必须获得本次任务明确授权，不继承历史授权。从最新 main 创建 `<type>/<kebab-case-description>` 格式的独立任务分支；一次提交只处理一个逻辑变更。详见专项规范 [Git 分支与 PR 全生命周期规范](.agents/rules/git/pr-lifecycle.md)。

---

## 按需阅读与任务规格路由（On-Demand Routing）

**按需查阅铁律：** 严禁任何任务均机械通读全量文档。Agent 应根据承接的具体任务类型，精准查阅对应的负责文档；无需关心的领域文档坚决不读，最小化上下文噪音：

| 任务类型 | 建议查阅的负责文档 | 核心关注点与边界 |
|---|---|---|
| **常规 Bug 修复 / 局部缺陷排查** | 目标模块源码及对应测试；若涉及接口契约查阅 [模块边界](docs/architecture/modules.md) | 四步确认定位根因，做最小精准修改，不破坏既有行为与测试 |
| **规则数值 / 机制逻辑 / 剧情世界观** | [范围、序章切片与不变量](docs/00-scope-and-invariants.md) 与 [设定速查表](docs/design/world/canon.md) | 规则定量落地，术语保持全局一致，严禁静默篡改既定不变量与初值 |
| **模块新增 / 架构重构 / 依赖治理** | [技术栈与边界白名单](docs/delivery/tech-stack.md)、[模块边界](docs/architecture/modules.md)、[代码结构](docs/architecture/code-structure.md) | 遵循 realm/kind 白名单，严禁深层导入与循环依赖，全职能插件化 |
| **首版里程碑步骤开发** | [分步构建计划 (docs/delivery/build-plan.md)](docs/delivery/build-plan.md) 当前步骤的“先读”章节 | **仅在明确承接构建计划步骤推进时查阅**；日常维护与常规修复不读 |
| **文档编写、更新与规范修订** | [文档导航入口 (docs/README.md)](docs/README.md) 与 [文档编写与维护规范 (docs/AGENTS.md)](docs/AGENTS.md) | 严格遵循中文标点规范（直角引号非必要不使用），基于真实代码实证编写，消除 AI 腔 |
| **全局背景概览（新开发者初次接入）** | [项目全局概览 (README.md)](README.md) 与 [文档导航入口 (docs/README.md)](docs/README.md) | 仅在初次接入或需宏观了解整体系统全貌时阅读 |

> [!TIP]
> 规则、数值、业务 ID、API、配置与 prompt 以 [文档导航的主题负责文档](docs/README.md#4-负责关系每个主题只有一个负责文档) 为准，不得在实现时凭猜测静默改变。修改前先阅读目标及相关调用链路，寻找已有抽象。

---

## 分级专项规范索引（Specialized Specifications Directory）

在执行具体工作流环节时，按需查阅并严格执行对应的专项规范：

| 领域模块 | 规范文档 | 核心职责与触发场景 |
|---|---|---|
| **PR 流程** | [Git 分支与 PR 全生命周期规范](.agents/rules/git/pr-lifecycle.md) | 分支策略、端到端 PR 负责制、PR 模板执行、推送前自审、CI 等待防抢跑、双渠道问题提取、评论 Resolve 三条件铁律、Squash 合并规范 |
| **Git 提交** | [Git 提交与对外交付规范](.agents/rules/git/commit-standards.md) | Conventional Commits 类型与 Scope、默认中文要求、标题正文规范、Diff 视角与对外独立自解 |
| **提 Issue** | [Issue 创建、管理与维护规范](.agents/rules/issue/issue-workflow.md) | 前置按需建单策略、Issue 模板执行、右侧 Sidebar 结构化配置、全生命周期维护与闭环准则 |
| **审查重点** | [编码审查十二维工程准则](.agents/rules/review/twelve-dimensional-criteria.md) | 涵盖 Correctness、Edge Case、Security、Contract、Decouple、Dependency、Performance、Resilience 等十二维深度核查清单与最终复核 |
| **质量门禁** | [门禁分级与审查处理策略](.agents/rules/review/gates-and-triage.md) | 仓库实际门禁基准、红线必改项（Bug/Security/Secrets 零容忍）、非阻塞告警误报甄别与建单防丢弃、审查线程处理 |
| **架构与工程** | [架构设计与核心工程铁律](.agents/rules/architecture/engineering-iron-laws.md) | 解耦优先于内聚（全职能插件化）、单一职责物理隔离（SRP 500行）、依赖倒置（DIP）、网络端口白名单（5173/3000）、单向依赖与 Import 隔离 |
| **命名与风格** | [命名规范、代码注释与核心文件头规范](.agents/rules/conventions/naming-and-headers.md) | 意图导向命名、绝对黑名单与高危泛化词管控、代码自解释、手写源码核心文件头（三要素）规范、Git 客观性事实性约束 |
| **测试与交付** | [本地验证、测试有效性与交付标准](.agents/rules/testing/verification-and-testing.md) | 针对性门禁分级（文档/注释跳过全量测试）、代码全量门禁（`pnpm check`）、强有效断言与反脆弱 Mock |
| **文档维护** | [文档编写与维护规范](docs/AGENTS.md) | `docs/` 目录下基于真实代码的实证撰写、标点规范（直角引号非必要不使用）、术语全库一致性与修改存疑界限 |

---

## 本地补充与优先级规则

共享规则以本规范体系及各主题负责文档为准。本机可配置被 git 忽略的 `AGENTS.local.md`；它仅补充本地开发者偏好，严禁覆盖或削弱项目硬约束。

规范优先级判定顺序：
```text
项目根目录 AGENTS.md
  └── .agents/rules/*/ 各分级专项规范 = docs/AGENTS.md
        └── 项目根目录 AGENTS.local.md
              └── 全局 AGENTS.md
```

同类型规范若有冲突，以上级或专门负责文档为准；发现任何潜在冲突必须主动向用户报告，严禁私自裁决。
