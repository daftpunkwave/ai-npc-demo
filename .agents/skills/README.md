# 项目级 Agent Skills

`<项目根>/.agents/skills` 是项目级 skill 根目录，每个子目录是一个独立 skill，入口为 `SKILL.md`。

本目录现有 20 个 skill：一套游戏开发技能包 `gamedev`，以及 19 个单点技能。

## 技能一览

### 游戏开发

| Skill | 用途 |
|---|---|
| `gamedev` | 游戏开发技能总入口。先按项目指纹识别引擎（Godot、Unity、Unreal、Ebitengine、Bevy、Phaser、PixiJS、three.js、Defold、LÖVE、pygame、Roblox），再按任务挑出最少的一组 skill 去读；做游戏、加玩法、画美术、调 UI、做音频、写 AI、选品类或准备发行时使用。内含 79 个具体技能，清单见 [`gamedev/README.md`](gamedev/README.md) |

### 开发、架构与图表

| Skill | 用途 |
|---|---|
| `dev-workflow` | 开发流程五步法：需求理解、方案设计、代码实现、代码审查、Bug 修复 |
| `ledger-tasks-yylo` | git 原生任务账本，跨会话保存任务状态、按依赖排序、记录状态回执、串行化多 worktree 交付 |
| `ontoly-software-graph` | 基于 Ontoly 确定性软件图做架构审查、请求链路追踪、依赖分析与影响分析，再回退到源码检索 |
| `diagram-design` | 60 余种图型（架构、时序、状态机、ER、时间线、泳道、象限、甘特、桑基、鱼骨、Wardley 等），输出 HTML/SVG/PNG，可导入 `.drawio`、Mermaid、`.excalidraw` |
| `archify` | 架构、工作流、时序、数据流、生命周期图，输出可交互独立 HTML 并内联 SVG，支持深浅色、轨迹动效与多格式导出 |
| `codegen-diagram` | 技术栈图、系统架构图、数据结构图、E-R 图，输出 `.drawio`（mxGraph XML） |
| `drawio-diagram` | 模型架构图、算法流程图、感受野示意图等 `.drawio` 图表，支持从零生成与按参考图风格迁移 |
| `excalidraw-diagram` | 手绘风 `.excalidraw` 图表：系统架构、流程、数据结构与自由白板草图 |
| `chrome-automation` | 通过 CDP 接管现有 Chrome 会话做网页自动化，保留登录态，实时可视化执行过程 |

### 设计与界面

| Skill | 用途 |
|---|---|
| `frontend-design` | 生产级前端界面与组件，产出有创意、打磨到位且规避模板化「AI 通用审美」的设计 |
| `voltagent-awesome-design-md` | 73 份成熟产品的 `DESIGN.md` 视觉规范（Claude、Cursor、Vercel、Stripe、Apple、Tesla 等），按现成规范产出风格一致的 UI |
| `web-design-analyzer` | 从网页截图逆向提取配色、排版与组件特征，产出结构化 Design System 数据与 AI Coding Prompt |
| `anatomy` | 等轴测（isometric）技术插图：用实体物件讲清系统、算法或组件如何工作，含精确部件、四色明暗、画框标注与缓动，可导出 A4 PDF |
| `ip-as-logo` | 极简角色化方形图标：圆润厚重造型、双主色、单一背景色、下角构图，可缩到 32×32 仍可辨识 |

### 文档与模板

| Skill | 用途 |
|---|---|
| `project-docs` | 面向新人的项目文档集，输出到 `docs/`：架构、设计思想、语言特性、代码导读、运行时模型、构建、对接、调试、设计规范共 9 篇 |
| `codegen-doc` | 论文章节、项目梳理、重点问题、简历项目描述，格式由调用方指定 |
| `md-report-summary` | 周报、工作汇报、总结、介绍、述职、复盘；无草稿时从 Web 检索再总结，有草稿时整理润色 |
| `expert-prompt-migrator` | 将专家或角色提示词规范化为可移植格式，迁移到 DeepSeek、豆包、Kimi、Claude、Ollama 等平台复用 |
| `skill-template` | 新建自定义 skill 的起点模板，复制后替换 `SKILL.md` 中的占位符 |

## 外部运行依赖

部分 skill 的脚本需要本目录之外的运行时或浏览器，缺失时只有对应步骤不可用。这些依赖不随本目录引入，需要时另行确认后再装。

| Skill | 依赖 | 当前状态 |
|---|---|---|
| `anatomy` | Node.js ≥ 20.10、Chrome 或 Chromium | 本机 Node v26.13.1 已满足 |
| `diagram-design` | Python 3 | 本机 Python 3.15.2 可用；导入导出与 `self_check` 脚本可用，部分校验脚本仅上游仓库检出时提供 |
| `gamedev` | `create-game-assets` 脚本需 Python 3.11+ 与 Pillow 13+；其余脚本多数只用标准库 | 本机 Python 版本满足，但未安装 Pillow，需先按 `gamedev/disciplines/create-game-assets/scripts/requirements.txt` 安装 |
| `web-design-analyzer` | Python 3 + Pillow ≥ 10 | 本机未安装 Pillow，`scripts/analyze_design.py` 补齐前不可用 |
| `chrome-automation` | Node.js、Chrome | 需 Chrome 已开启调试端口 |
| `ontoly-software-graph` | Ontoly MCP 服务与图产物 | 未接入时只能作为方法参考，无法产出图证据 |

## 维护

- 本目录不参与源码编译、打包与运行时，仅是 Agent 的指令素材。
- 仓库检查中 `check:boundaries`、`check:catalog`、`check:assets` 跳过以 `.` 开头的目录，`check:docs` 只扫描入口文档与 `docs/`，因此本目录不在门禁范围。
- `.gitattributes` 将 `.agents/skills/**` 标记为 `linguist-vendored`，其中示例代码不计入 GitHub 语言统计。
- `.codacy.yml` 排除 `.agents/**`，本目录不参与 Codacy 静态分析。
- skill 流程与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。
- skill 默认向 `docs/` 写文件（例如 `dev-workflow` 的阶段产物、`project-docs` 的文档集、`gamedev` 内 `game-docs` 的设计文档），在本项目改为写入 `docs.local/`。该目录已被 `.gitignore` 忽略，用于存放本地审阅、审计与过程性文档，不进提交；只有明确需要随仓库交付的文档才写入 `docs/`。
- 上游更新时按目录覆盖，不要就地改写内容，否则下次同步难以比对。
  - `gamedev` 来自 `gamedev-skills/awesome-gamedev-agent-skills`：覆盖前需拍平为 `<分类>/<技能名>/SKILL.md`（去掉上游多出的 `skills/` 一层），把 `SKILL.md` 与 `references/` 里的 `skills/<分类>/` 改写为 `<分类>/`，剔除上游仓库根目录的 `LICENSE`、`NOTICE`、`CHANGELOG.md`、`CONTRIBUTING.md`、`.claude-plugin/` 与分类级 `README.md`，并保留 `ebitengine-game/assets/starter/licenses/Go-Fonts.txt`（模板内第三方字体授权）。
  - 其余技能来自 `anbeime/skill`：多数是 `<目录>/<同名子目录>/SKILL.md` 的嵌套结构，覆盖前需拍平为 `<目录>/SKILL.md`，并剔除 `__MACOSX`、`.DS_Store`、`.github` 与上游自带的协议文件；`diagram-design` 的内层多一层 `skills/`。
