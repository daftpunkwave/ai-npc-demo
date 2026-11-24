# Git 提交规范与对外交付规范

本文件是项目中 Git 提交（Commit）信息书写、PR 文案描述及对外交付内容的专项规范，服从根目录 [AGENTS.md](../../../AGENTS.md)。

---

## 1. 提交格式（Conventional Commits）

提交信息采用 Conventional Commits 规范格式：
```text
<type>(<scope>): <subject>

[可选 body 正文]

[可选 footer / trailers]
```
其中 `scope` 可选；`type` 严格按下表选择：

| type | 用途 |
|---|---|
| feat | 新增或扩展功能 |
| fix | 修复错误行为 |
| docs | 文档与开发规范 |
| refactor | 不新增功能、不修复缺陷的结构调整 |
| perf | 性能优化 |
| test | 测试用例、夹具与测试基础设施 |
| style | 不影响行为的格式调整，不指界面功能 |
| build | 构建、打包、编译配置与依赖管理 |
| ci | CI/CD 自动化：检查、发布、部署与回滚 |
| chore | 不属于以上类型的日常维护 |
| revert | 撤销既有提交，使用 `git revert` 并说明原因 |

### 1.1 Scope 与职责区分细则
- **CI/CD：** CI 与 CD 共用 `ci` 类型，以 `ci(check)`、`ci(release)`、`ci(deploy)`、`ci(rollback)` 区分职责；
- **依赖升级：** 统一使用 `build(deps)`，不设独立的 `deps` 类型；
- **安全修复：** 统一使用 `fix(auth)` 等对应职责 scope，不设独立的 `security` 或 `hotfix` 类型；
- **撤销提交：** `git revert` 自动生成的标题可保留标准格式。

---

## 2. 语言与字符约束

- **默认全中文：** Commit 和 PR 的标题、正文、评论默认使用中文，保留英文专有名词（如 deadlock、WebSocket）及 Conventional Commits 的 type/scope；
- **字符长度放宽：** 所有提交文本均不设每行 72 字符的硬性换行限制。

---

## 3. 标题与正文要求

- **标题（Subject）：** 用具体业务场景或功能概括改动，动词开头，简明扼要；严禁出现无信息量的空泛标题（如 `fix: update files`、`chore: format code`、`refactor: optimize logic`）；
- **正文（Body）：** 清晰说明实际变更内容、技术原因、验证结果及兼容性影响；
- **严禁密钥泄露：** 严禁提交密钥、Token、本地密码或本地私有配置。

---

## 4. 对外内容与改动必须独立可读

所有公开交付物（Commit、PR 描述、Issue、审查意见与回复、交付报告、发布说明、公开文档）必须做到完全独立可读：

1. **对外交付独立自解：**
   - 外部受众或审查者脱离特定对话上下文也能独立理解和复核；
   - 严禁依赖受众无权访问的内部材料、未公开草稿、本地配置、未提交代码或隐含约定；
   - 必要背景、接口契约、配置要求与可复核证据随交付直接提供。
2. **严禁内部编号与计划引用：**
   - 严禁出现如“implement phase 2”、“complete section 3.2 of spec”、“finish todo list”等内部开发计划、里程碑或阶段章节引用；
   - 无论标题还是正文，均不得提及内部阶段标签。
3. **纯粹代码与 Diff 视角（Changed What & Why）：**
   - 必须以纯粹的代码视角与变更视角说明为什么改、改了什么、影响什么、如何验证和验收；
   - 所有表述必须聚焦于实际的代码变更与技术逻辑。
4. **禁止推测与未来计划：**
   - 严禁在 Commit 和 PR 中解释未实际发生变更的模块；
   - 严禁描述未落实、计划中的未来工作。
