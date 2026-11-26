# 项目级 Agent Skills

`<项目根>/.agents/skills` 是项目级 skill 根目录，每个子目录是一个独立 skill，入口为 `SKILL.md`。

本目录当前只有一套技能包：[`gamedev/`](gamedev/README.md)，共 79 个游戏开发技能，入口是 [`gamedev/SKILL.md`](gamedev/SKILL.md)。它的分工、分类与全部技能清单见 [`gamedev/README.md`](gamedev/README.md)。

## 维护

- 本目录不参与源码编译、打包与运行时，仅是 Agent 的指令素材。
- 仓库检查中 `check:boundaries`、`check:catalog`、`check:assets` 跳过以 `.` 开头的目录，`check:docs` 只扫描入口文档与 `docs/`，因此本目录不在门禁范围。
- skill 流程与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。
- skill 默认向 `docs/` 写文件（例如 `gamedev` 内 `game-docs` 的设计文档），在本项目改为写入 `docs.local/`。该目录已被 `.gitignore` 忽略，用于存放本地审阅、审计与过程性文档，不进提交；只有明确需要随仓库交付的文档才写入 `docs/`。
- 上游更新时按目录覆盖，不要就地改写内容，否则下次同步难以比对。`gamedev` 来自 `gamedev-skills/awesome-gamedev-agent-skills`，覆盖前需拍平为 `<分类>/<技能名>/SKILL.md`（去掉上游多出的 `skills/` 一层），并把 `SKILL.md` 与 `references/` 里的 `skills/<分类>/` 改写为 `<分类>/`；同时剔除上游仓库根目录的 `LICENSE`、`NOTICE`、`CHANGELOG.md`、`CONTRIBUTING.md`、`.claude-plugin/` 与分类级 `README.md`。
