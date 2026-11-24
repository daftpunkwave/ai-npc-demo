# Agent 专项规范体系（.agents/rules/）

本目录是项目中面向 AI Coding Agent 的专项执行规范体系，服从根目录 [AGENTS.md](../../AGENTS.md)。

---

## 体系架构与目录层级

在 `<项目根>/.agents/` 顶级目录下，按照资产类型划分三个平级领域：
- **`rules/`（本目录）：** Agent 必须严格恪守的工程规范、工作流与质量准则；
- **[`skills/`](../skills/README.md)：** Agent 执行特定任务（架构分析、图表生成、UI 设计等）的项目级技能库；
- **`notes/`：** Agent 跨会话记录的过程性开发笔记、决策背景与上下文经验。

---

## 专项规范索引

| 子目录 | 规范文档 | 核心职责 |
|---|---|---|
| `git/` | [pr-lifecycle.md](git/pr-lifecycle.md) | 分支策略、PR 模板执行、端到端负责制、推送等待、双渠道提取、Resolve 铁律、Squash 规则 |
| `git/` | [commit-standards.md](git/commit-standards.md) | Conventional Commits、类型表、标题正文要求、对外独立自解与 Diff 视角 |
| `issue/` | [issue-workflow.md](issue/issue-workflow.md) | 前置按需建单、Issue 模板执行、右侧 Sidebar 配置、生命周期维护与闭环准则 |
| `review/` | [twelve-dimensional-criteria.md](review/twelve-dimensional-criteria.md) | 编码审查十二维工程准则（Correctness、Security 等十二维深度核查清单） |
| `review/` | [gates-and-triage.md](review/gates-and-triage.md) | 门禁分级处置（红线必改项零容忍、非阻塞告警甄别与建单防丢弃、审查线程处理） |
| `architecture/` | [engineering-iron-laws.md](architecture/engineering-iron-laws.md) | 解耦优先于内聚（全职能插件化）、单一职责物理隔离（SRP 500行）、依赖倒置（DIP）、网络端口白名单、单向依赖 |
| `conventions/` | [naming-and-headers.md](conventions/naming-and-headers.md) | 意图导向命名、绝对黑名单、高危泛化词管控、代码自解释、手写源码核心文件头规范 |
| `testing/` | [verification-and-testing.md](testing/verification-and-testing.md) | 针对性门禁分级（文档/注释跳过全量测试）、代码全量门禁（`pnpm check`）、强有效断言与反脆弱 Mock |
