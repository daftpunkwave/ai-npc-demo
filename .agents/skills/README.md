# 项目级 Agent Skills

`<项目根>/.agents/skills` 是项目级 skill 根目录，每个子目录是一个独立 skill，入口为 `SKILL.md`。

## 技能一览

### 开发、架构与图表

| Skill | 用途 |
|---|---|
| `dev-workflow` | 需求理解、方案设计、代码实现、代码审查、Bug 修复五步流程 |
| `ledger-tasks-yylo` | git 原生任务账本，跨会话推进多步开发、按依赖排序、记录状态回执 |
| `ontoly-software-graph` | 架构审查、请求链路追踪、依赖影响分析与重构爆炸半径评估 |
| `diagram-design` | 60 余种图型（架构、时序、状态机、ER、依赖、UML 等），可导入 `.drawio`、Mermaid、`.excalidraw` |
| `archify` | 架构、工作流、时序、数据流画成可交互独立 HTML，内联 SVG，支持深浅色与导出 |
| `codegen-diagram` | 技术栈图、系统架构图、数据结构图、E-R 图，输出 `.drawio` |
| `drawio-diagram` | 模型架构图、算法流程图、UML 图、学科示意图，支持按参考图风格迁移 |
| `excalidraw-diagram` | 手绘风 `.excalidraw` 图 |
| `chrome-automation` | CDP 接管现有 Chrome 会话做网页自动化，保留登录态 |

### 设计与界面

| Skill | 用途 |
|---|---|
| `frontend-design` | 生产级前端界面，规避模板化的通用审美 |
| `voltagent-awesome-design-md` | 74 份成熟产品的 `DESIGN.md` 视觉规范，按现成规范产出 UI |
| `web-design-analyzer` | 从截图逆向提取配色、排版与组件特征，产出 Design System 数据 |
| `anatomy` | 等轴测（isometric）技术插图，用实体物件讲清系统或组件如何工作 |
| `ip-as-logo` | 极简、缩到 32×32 仍可辨识的角色化图标 |

### 文档与模板

| Skill | 用途 |
|---|---|
| `project-docs` | 面向新人的项目文档集（架构、代码导读、调试等） |
| `codegen-doc` | 论文章节、项目梳理、重点问题、简历项目描述，格式由调用方指定 |
| `md-report-summary` | 周报、工作汇报、总结复盘、项目介绍 |
| `expert-prompt-migrator` | 专家或角色提示词规范化，并迁移到其他模型平台复用 |
| `skill-template` | 新建自定义 skill 的起点模板 |

## 外部运行依赖

部分 skill 的脚本需要本目录之外的运行时或浏览器，缺失时只有对应步骤不可用。这些依赖不随本目录引入，需要时另行确认后再装。

| Skill | 依赖 | 当前状态 |
|---|---|---|
| `anatomy` | Node.js ≥ 20.10、Chrome 或 Chromium | 本机 Node v26.13.1 已满足 |
| `diagram-design` | Python 3 | 导入导出与 self_check 脚本可用；部分校验脚本仅上游仓库检出时提供 |
| `web-design-analyzer` | Python 3 + Pillow ≥ 10 | 本机未安装 Pillow，`scripts/analyze_design.py` 补齐前不可用 |
| `chrome-automation` | Node.js、Chrome | 需 Chrome 已开启调试端口 |
| `ontoly-software-graph` | Ontoly MCP 服务与图产物 | 未接入时只能作为方法参考，无法产出图证据 |

## 维护

- 本目录不参与源码编译、打包与运行时，仅是 Agent 的指令素材。
- 仓库检查中 `check:boundaries`、`check:catalog`、`check:assets` 跳过以 `.` 开头的目录，`check:docs` 只扫描入口文档与 `docs/`，因此本目录不在门禁范围。
- skill 流程与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。
- skill 默认向 `docs/` 写文件（例如 `dev-workflow` 的阶段产物、`project-docs` 的文档集），在本项目改为写入 `docs.local/`。该目录已被 `.gitignore` 忽略，用于存放本地审阅、审计与过程性文档，不进提交；只有明确需要随仓库交付的文档才写入 `docs/`。
- 上游更新时按目录覆盖，不要就地改写内容，否则下次同步难以比对。`anbeime/skill` 下多数技能是 `<目录>/<同名子目录>/SKILL.md` 的嵌套结构，覆盖前需拍平为 `<目录>/SKILL.md`，并剔除 `__MACOSX`、`.DS_Store`、`.github` 与上游自带的协议文件；`diagram-design` 的内层多一层 `skills/`。
