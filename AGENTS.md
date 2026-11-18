# AGENTS.md：给编码 Agent 的工作说明

本仓库是一个单玩家 2.5D 轻数值 SLG demo，用来验证游戏里 Agent NPC 的记忆、感知、上下文与行为设计：TypeScript 全栈，服务端 `127.0.0.1:3000`（含 `/console` 控制台），玩家客户端 `127.0.0.1:5173`。**当前只有设计文档，没有任何实现代码**；实现从 [构建计划](docs/delivery/build-plan.md) 的 S00 开始。

## 1. 开始前必读（按顺序）

1. [README](README.md)：项目一页概览。
2. [文档入口](docs/README.md)：文档地图与“哪个主题由哪篇文档负责”。
3. [首版范围与不变量](docs/00-scope-and-invariants.md)：范围、数量、术语。
4. [技术栈](docs/delivery/tech-stack.md)：依赖版本、目录与包名规则、脚本、编码约定。
5. [构建计划](docs/delivery/build-plan.md)：26 个步骤；每一步再读它列出的“先读”章节。

## 2. 工作方式

- 严格按构建计划的步骤顺序推进；上一步的完成判据没有全部满足，不开始下一步。
- 每一步结束都运行 `pnpm check`，全部通过后再提交；一步一个提交，提交信息用 Conventional Commits：`<type>(<scope>): <subject>`，type 取 feat/fix/docs/refactor/chore/test/perf。
- 每一步按构建计划第 0 节的格式写完成报告：做了什么、测试、检查结果、偏差、未决问题。失败就写失败，跳过就写跳过，没运行就写没运行。
- 规则、数值、ID、prompt、表结构、接口都以文档为准，照抄，不要自己“改进”。文档之间矛盾时，以负责该主题的文档为准（第 4 节），并在完成报告里指出矛盾。
- 文档没有覆盖、又会影响结果的选择：选最保守、最容易回退的做法，写进完成报告的“未决问题”，不要静默决定。
- 不新增文档里没有的依赖、端口、进程、数据库或外部服务；需要时先在完成报告里提出。

## 3. 硬性规则（任何一步都不能违反）

1. **只有两个监听端口**：`127.0.0.1:5173` 与 `127.0.0.1:3000`；端口被占用时启动失败，不自动换端口；不为开发便利另开端口（[两个端口](docs/architecture/two-endpoints.md)）。
2. **世界只有一条写入路径**：所有副作用都是命令 → 命令网关 → 规则处理器返回计划 → authority 在一个事务内提交。规则处理器是同步纯函数；**事务内禁止 await**（[领域模型](docs/architecture/domain-model.md) 第 4 节）。
3. **模型输出不是事实**：Agent 只能经工具网关提出命令，结果以 receipt 为准；`accepted` 不等于任务完成（[公共契约](docs/architecture/contracts.md) 第 2 节）。
4. **决策与对白分离**：decision 可以用本 Agent 知道的秘密；speech 是一次全新的请求，只含对受众可披露的资料，秘密永远不进入 speech 请求（[prompts](docs/agent/prompts.md) 第 3–4 节）。
5. **按授权投影**：玩家只拿到 `PlayerProjection`，Agent 只看到自己的 `AgentWorldView`；浏览器永远拿不到记忆、prompt、模型请求或密钥（[领域模型](docs/architecture/domain-model.md) 第 7–8 节）。
6. **模块之间只经契约**：模块只依赖 `@ai-npc/contracts` 与 SDK；不 import 其他模块，不 deep import；只有组合根显式登记模块（[代码目录](docs/architecture/code-structure.md)）。
7. **模块不直接接触环境**：不调用 `Date.now()`、`Math.random()`、`crypto.randomUUID()`、`process.env`、`fs` 或网络；一律用注入的 `HostServices` 与端口；只有 `kind = adapter` 的模块可以通过它封装的第三方库做网络与文件 I/O（[技术栈](docs/delivery/tech-stack.md) 第 7 节）。
8. **记忆不可变、按 revision 读取**：记录只追加行版本；检索绑定冻结的 revision；提交用 CAS（[记忆](docs/agent/memory.md) 第 11 节、[存储](docs/architecture/storage.md) 第 4 节）。
9. **实验隔离**：每个 run 独占一个分支；改变任何可比较配置都是新 run；全部署同时激活的 gameplay 身份不超过 20（[事件与状态](docs/architecture/events-and-state.md)）。
10. **不隐藏失败**：不吞错误，不用 fallback 冒充成功；严格实验中的无效样本单独计数（[评估](docs/platform/evaluation.md)）。
11. **密钥只在服务端环境变量**：配置与 manifest 只存 `credentialRef`；日志与 artifact 不出现密钥（[模型传输](docs/agent/model-transport.md) 第 8 节）。
12. **公平对照**：不给无记忆组（M0）任何历史旁路，例如把已结束的协议、全量关系或公共历史塞进上下文（[记忆](docs/agent/memory.md) 第 4 节）。
13. **测试确定**：常规测试只用确定性装配与固定种子；不对真实模型的逐字输出做断言；真实模型测试放在 `tests/live/`。
14. **中文文本不进代码**：玩家可见的中文与 prompt 模板放在内容包的 `prompts/`、`locale/`；代码注释与标识符用英文。

## 4. 文档负责关系

每个主题只有一个负责文档，完整对照表见 [文档入口](docs/README.md) 第 4 节。常用的几项：规则与数值看 [game/rules](docs/game/rules.md)，初始数据看 [game/content-pack](docs/game/content-pack.md)，命令与事件看 [architecture/domain-model](docs/architecture/domain-model.md)，接口看 [architecture/api](docs/architecture/api.md)，表结构看 [architecture/storage](docs/architecture/storage.md)，配置文件看 [platform/configuration](docs/platform/configuration.md) 第 10 节，prompt 看 [agent/prompts](docs/agent/prompts.md)。

## 5. 常用命令

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm check
```

```bash
pnpm test:e2e
```

`pnpm install` 与 `pnpm check` 在 S00 之后可用；`pnpm dev` 与 `pnpm test:e2e` 在 S10 之后可用（各脚本加入的步骤见 [构建计划](docs/delivery/build-plan.md) 第 0.2 节）。首次运行时复制 `.env.example` 为 `.env` 并按需填写模型配置；服务端启动时会打印玩家与控制台的登录地址。

## 6. 提交前检查

- 需求满足：本步构建计划的“产出”与“测试”都已完成，diff 中每一行都能追溯到本步要求。
- 已验证：`pnpm check` 通过；本步要求的 e2e 或人工验证已执行，或在报告中写明未执行的原因。
- 没有遗留：没有 `TODO`、被注释掉的代码、占位实现或调试输出。
- 没有越界：没有与本步无关的修改，没有破坏已有的契约或测试。
