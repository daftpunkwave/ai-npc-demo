# 构建计划：从空仓库到首版

> 状态：实施手册。本文把首版（切片 A、B、C、M，见 [路线与验收](roadmap-and-acceptance.md)）拆成 26 个按顺序执行的步骤。每一步都写明先读什么、产出什么、要写哪些测试、怎样算完成。实现者（包括编码 Agent）**严格按顺序执行**：前一步的完成判据没有全部满足，不开始下一步。工程约定见 [技术栈](tech-stack.md)，编码 Agent 的工作规则见仓库根目录的 [AGENTS.md — 开发规范](../../AGENTS.md)。

## 0. 怎样使用本计划

### 0.1 通用规则

- **每一步的固定收尾**：`pnpm check` 全部通过，组成见 [脚本、配置与装配](#02-脚本配置与装配随步骤增长)。本步新增的测试都在其中，代码须清理 `TODO`、被注释掉的代码和调试输出。获准提交后一步一个提交，提交授权与格式见根目录 [AGENTS.md](../../AGENTS.md)。
- **规格优先**：本文规定产出、位置和验证方式，规则细节以“先读”列出的规格为准。两处文档互相矛盾时，以 [文档导航的主题负责关系](../README.md#4-负责关系每个主题只有一个负责文档) 为准，并在完成报告里记录发现的矛盾。
- **不确定时不猜**：文档没有覆盖、又会影响结果的选择，选择最保守、最容易回退的做法，把问题与所做的选择写进完成报告的“未决问题”。
- **确定性优先**：切片 A 之前不接真实模型；常规测试都用确定性装配 `local-slg-test-v1`、确定性模型传输与固定种子。
- **完成报告**：每一步完成后记录实际产出、验证、偏差与未决事项。提交说明或 PR 描述用功能名称概括改动，格式遵循 [AGENTS.md — 对外内容与改动必须独立可读](../../AGENTS.md#对外内容与改动必须独立可读)。

```text
<交付的功能>
- done: <files / modules created>
- tests: <test files> (<n> passed)
- checks: pnpm check = pass
- deviations: <none | what differs from the docs and why>
- open questions: <none | list>
```

### 0.2 脚本、配置与装配随步骤增长

脚本与配置文件在用到它们的那一步才创建，不提前写占位内容。两份主装配 `local-slg-standard-v1` 与 `local-slg-test-v1` 在 S09 首次创建，之后每一步只追加本步实现的模块绑定；到 S24 时内容必须与 [配置](../platform/configuration.md) 第 10.1 节完全一致。每一步结束时，两份装配都必须能被 `pnpm check:catalog` 解析通过。

| 步骤 | `package.json` 新增脚本 | 新增或修改的配置 | 装配新增的绑定（标准 / 测试相同，除非注明） |
|---|---|---|---|
| S00 | `typecheck`、`test`、`check:docs`、`check`（= typecheck + test + check:docs） | `.env.example` | — |
| S03 | `check:boundaries`（并加入 `check`） | — | — |
| S05 | — | `config/rosters/standard-15.yaml`、`core-3.yaml`、`config/runs/online-default.yaml` | — |
| S09 | `dev:server`、`check:catalog`（并加入 `check`） | 两份主装配和已提前交付的剧情替换装配 `local-slg-escalating-v1` | server：九个 game 绑定（主装配的 scenario 为 `game.scenario.watergate`）、`platform.storage.sqlite`、`platform.secrets.env`、`platform.access-policy.roster`、`platform.operations.standard`、`transport.http-ws.fastify`。无 `agentSlots`，client 与 console 的 bindings 为空 |
| S10 | `dev:client`、`dev`、`build`、`start`、`test:e2e` | — | client：第 5 节全部 client 绑定（标准用 `client.scene-renderer.pixi`，测试用 `client.scene-renderer.null`） |
| S11 | `dev`、`build` 加入 console 构建 | — | server：`platform.observability.sqlite`、`platform.module-admin.standard`；console：health、module-admin、`console.observability.standard` |
| S12 | `check:ports` | — | — |
| S15 | — | `config/toolsets/*.yaml` | — |
| S16 | — | `config/profiles/platform-baseline.yaml`（decision 槽暂为 `agent.decision.deterministic`）、`scene-watergate.yaml`、两个 Agent profile | server：`agent.scheduling.fair`、`agent.tools.game-tools`；`agentSlots`：perception local；memory none、ledger；context ordered-blocks；compression none、window；toolView structured；decision deterministic |
| S17 | — | baseline 的 decision 槽改为 `agent.decision.model`，标准 run 叠加 `decision-deterministic` patch；`config/model-layouts/deterministic-model-layout-v1.yaml`；`config/pricing.yaml`；`config/profiles/variants/decision-deterministic.yaml` | 仅测试装配的 server 加 `agent.model-pool.shared`、`platform.budget.standard`、`platform.model-transport.deterministic`，`agentSlots.decision` 加 `agent.decision.model`；标准装配仍只有 deterministic decision，不绑定 pool/transport |
| S18 | — | `shared-model-layout-v1.yaml`、`claude-model-layout-v1.yaml` | 标准装配加 `agent.model-pool.shared`、`platform.budget.standard`、`platform.model-transport.openai-compatible`、`platform.model-transport.anthropic`，`agentSlots.decision` 加 `agent.decision.model`；标准 run 移除过渡用 decision patch |
| S19 | — | `memory-m1-structured-ledger` variant | console：model-mounts、faction-ops、debug |
| S20 | — | 其余四个记忆 variant 文件（`memory-m0-window`、`memory-m0-current`、`memory-m2-stream-reflection`、`memory-m3-layered-hybrid`） | `agentSlots.memory` 加 stream-reflection、layered-hybrid |
| S21 | — | `config/runs/exp-*.yaml` | server：`platform.evaluation.standard`；console：evaluation |
| S22 | — | `config/presets/*.yaml` | console：scenario-editor、audit |
| S24 | — | 定稿已有的剧情替换装配，新增 HUD 和控制台两份替换装配 | client 的 `client.hud.compact`、console 的 `console.observability.lite` 只出现在各自替换装配里 |

`pnpm check:assets` 随资产包入仓加入 `check`，不占构建步骤；它校验 `assets/manifest.json` 与内容包的节点、派系覆盖。

装配没有 `agentSlots` 时，服务端宿主不启动 Agent 运行时，也不解析名册里的 `profileRef`/`toolsetRef` 与 RunSpec 的 `modelLayoutRef`（S09–S15 的在线世界没有 NPC 行动）。有 `agentSlots` 时解析 profile/toolset；仅绑定 `agent.model-pool` 时才解析、校验 RunSpec 的 `modelLayoutRef`（S16 虽有 `agentSlots`，仍不读取尚不存在的模型布局文件）。有 `agentSlots` 时，`agent.scheduling` 与 `agent.tools` 成为必需能力；`agentSlots` 中各模块声明的 `requires`（例如 `agent.decision.model` 需要 `agent.model-pool`）也纳入能力闭包检查。

S17 的共享 baseline 使用 model decision；标准在线 RunSpec（`online-default.yaml`）须在 `variant.profilePatchRefs` 末尾追加 `decision-deterministic`，测试模型路径的 RunSpec 则显式移除该 patch、选择测试装配与 `deterministic-model-layout-v1`。profile 合并后再检查所选槽是否在装配白名单中：标准最终为 deterministic，测试最终为 model，二者都可运行；不得让标准装配依赖尚未实现的真实 transport。S18 标准装配具备 pool/transport 后移除这一过渡 patch、选择真实布局。

### 0.3 控制台与玩家接口的实现步骤

| 接口（[API](../architecture/api.md)） | 步骤 |
|---|---|
| 第 2 节（登录、会话、装配握手、健康检查、WS 票据）、第 3 节（玩家接口，`/presets`、`/run-requests` 和程序案命令除外）、第 4 节 `player` 频道 | S09 |
| 第 5.1 节；第 5.5 节的 `/timeline` 与 `/agents`；WS `console.health`、`console.timeline` | S11 |
| 第 5.2 节的只读与校验接口；第 5.3 节的时钟、存档与恢复；第 5.5 节其余接口；WS `console.turns` | S19 |
| 第 5.6 节的 run、实验与报告 | S21 |
| 第 5.2 节的草稿与连通性测试、第 5.3 节的席位与运行申请、第 5.4 节、第 5.6 节的导出、玩家的程序案命令与 `/presets`、`/run-requests` | S22 |

## 1. 步骤总览

下表列出实施顺序与计划产出。当前交付范围和迁移缺口见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。

| 阶段 | 步骤 | 产出 | 对应切片 |
|---|---|---|---|
| 工程骨架 | S00–S03 | workspace、contracts、kernel、module-sdk、client-sdk、边界检查 | — |
| 服务端世界 | S04 | SQLite 存储、分支复制和备份 | A |
| 服务端世界 | S05 | 内容与配置加载 | A |
| 服务端世界 | S06 | authority、命令网关、job 与事件消费者 | A |
| 服务端世界 | S07 | 时钟、地图、库存与世界规则 | A |
| 服务端世界 | S08 | 通信、行动、协议、剧情与存档 | A |
| 服务端世界 | S09 | 服务端宿主、玩家 HTTP/WS、装配预检 | A |
| 浏览器两端 | S10 | 客户端协议、宿主与启动脚本 | A |
| 浏览器两端 | S11 | 控制台宿主、首批页面与服务端接口 | A |
| 浏览器两端 | S12 | 双端端口检查 | A |
| Agent 管线 | S13–S17 | 感知与调度、记忆 M0/M1、上下文与工具网关、turn 主循环、模型池与确定性模型传输 | A |
| Agent 管线 | S18 | OpenAI 兼容和 Anthropic 模型传输 | A |
| 切片 A 验收 | S19 | 三核心角色端到端验证 | A |
| 记忆对比 | S20–S21 | M2、M3、实验与探针、评估页面 | B |
| 完整切片 | S22–S23 | 15 个身份的完整运行、t144 程序案、运营与剧情页面 | C |
| 可插拔验收 | S24 | 四类模块替换与证据 | M |
| 可插拔验收 | S25 | 交付包 | M |

## 2. 工程骨架

### S00 仓库骨架

- **先读**：[技术栈](tech-stack.md) 全文。
- **产出**：根目录的 `package.json`（只含 0.2 节 S00 行的脚本）、`pnpm-workspace.yaml`、三个 tsconfig、`vitest.config.ts`、`.env.example`；在 `.gitignore` 追加 `data/`、`data-e2e/`、`apps/server/console-static/`、`apps/client/dist/`、`test-results/`、`playwright-report/`；`packages/` 下九个包（`package.json` 与 `src/index.ts`，index 先导出包名常量 `export const packageName = "@ai-npc/<name>"`）；`tests/` 与 `scripts/` 两个包。
- **实现** `scripts/check-docs.ts`：检查项目文档的相对链接、标题锚点与 Markdown 表格列数。扫描范围与用法见 [README.md — 文档维护约定](../README.md#5-文档维护约定)。
- **测试**：`tests/contract/smoke.test.ts`：断言九个包的 `packageName` 与目录一致。
- **完成判据**：`pnpm install` 成功，`pnpm check` 通过，文档链接、锚点与表格列数均无错误。

### S01 contracts

- **先读**：[公共契约](../architecture/contracts.md)、[领域模型](../architecture/domain-model.md) 第 1–9 节、[API](../architecture/api.md) 第 3、4、7、9 节、[模型传输](../agent/model-transport.md) 第 2、6、7 节。
- **产出**：`packages/contracts/src/` 下按主题分文件的 Zod schema 与类型：`json.ts`（Json、规范 JSON 序列化）、`ids.ts`（ID 前缀与格式校验）、`envelopes.ts`（EventEnvelope、CommandEnvelope、CommandReceipt、AuthContext）、`frontier.ts`（InputFrontier、MemoryScope）、`observation.ts`、`memory.ts`、`errors.ts`（错误码与 DomainError）、`reason-codes.ts`、`commands.ts`（第 5 节每种命令的 payload schema，`Term` 为按 `kind` 的判别联合）、`events.ts`（第 6 节每种事件的 payload schema）、`audience.ts`、`projection.ts`（PlayerProjection、AgentWorldView）、`modules.ts`（ModuleDefinition、ModuleCreateInput、HostServices、AssemblyDescriptor、ResolvedModuleSet、CapabilityBinding）、`api.ts`（API 第 3–5、9 节的请求与响应 DTO）、`model.ts`（ModelRequest、ModelResponse、NormalizedMessage、ModelTransportError）、`schema-profile.ts`（面向模型的 JSON schema 清洗函数与工具名映射）。
- **测试**：每个 schema 至少有一条合法与一条非法样例。`canonicalJson` 对键顺序不同的对象输出相同字符串。清洗函数覆盖 [model-transport.md — 面向模型的 JSON Schema](../agent/model-transport.md#7-面向模型的-json-schemastrict-profile) 的全部规则，工具名映射覆盖往返转换与冲突检测。
- **完成判据**：`pnpm check` 通过；`contracts` 不依赖任何 Node 或 DOM API（两个 tsconfig 都能编译它）。

### S02 kernel

- **先读**：[插件机制](../architecture/plugins.md) 第 2–5 节、[积木组合](../architecture/composition.md) 第 2–4、7、10 节、[配置](../platform/configuration.md) 第 10.1–10.2 节、[模块目录](../architecture/module-catalog.md) 第 7 节、本文 0.2 节最后一段。
- **产出**：`packages/kernel/src/`：`registry.ts`（实例级注册表，`register` 返回 disposer，重复 `id@version` 报错）、`resolve-assembly.ts`（按绑定解析每个 realm：模块存在、realm 一致、能力已提供、`exactly-one` 能力恰好一个绑定、`many` 能力可多个、required 能力闭包（含 `agentSlots` 模块的 requires）、无环，并输出拓扑顺序的实例计划）、`resolve-config.ts`（按 `configSchema` 校验并填默认值）、`resolve-profile.ts`（继承链解析，`slots` 整槽替换，按顺序叠加多个 variant patch，检测环）、`manifest.ts`（计算 configHash、assemblyHash、catalogHash）、`lifecycle.ts`（按顺序 create/start，失败时逆序 dispose）、`slots.ts`（按 `order` 稳定排序贡献，冲突检测）。
- **测试**：缺必需能力、重复绑定、跨 realm、环、未知配置键、profile 环、两个 patch 依次叠加、启动失败回滚、同一输入的 hash 稳定。
- **完成判据**：`pnpm check` 通过。

### S03 module-sdk 与边界检查

- **先读**：[模块边界](../architecture/modules.md) 第 4、9 节、[代码目录](../architecture/code-structure.md) 第 2–4、7 节、[技术栈](tech-stack.md) 第 2、7 节。
- **产出**：`packages/module-sdk`（`defineModule()` 辅助函数，强制填写描述符字段；scoped storage、WorldTx 等端口的类型）；`packages/client-sdk`（`<Slot>` 组件、`usePort()`、`PreferencePort` 接口）；`scripts/check-boundaries.ts`。
- `check-boundaries` 检查源码引用与包 manifest，按文件所在包及模块 realm/kind 判定（夹具目录只作为检查函数的输入，不作为生产源码扫描）：
  1. 禁止 `@ai-npc/*/src/...` 深层导入（各包 `exports` 声明的入口除外，例如模块包的 `/definition`）；import 的每个 workspace 包都必须在本包 `dependencies` 中；
  2. 模块包的依赖白名单见 [技术栈](tech-stack.md) 第 2 节，不能依赖其他 `mod-*` 包；
  3. `modules/client/**`、`modules/console/**`、`apps/client`、`apps/console`、`packages/client-sdk`、`packages/client-protocol` 不能 import `node:*`、`fs`、`path`、`fastify`、`@anthropic-ai/sdk` 或任何 server 专用包；
  4. `packages/kernel`、`packages/contracts` 不能 import 任何 `mod-*`、`apps/*`、`react`、`pixi.js`、`fastify`；
  5. `apps/*` 中只有 `src/host/module-catalog.ts` 可以 import 模块包；tests/scripts 可导入公开模块入口，但不豁免深层导入与循环依赖；
  6. 检查静态 import、re-export、字面量动态 import、相对路径跨包引用及包依赖图；拒绝非字面量动态加载绕过、未许可的第三方库和循环依赖；运行时 requires 的闭包由 S02 解析器检查，远程握手按后续步骤实现；
  7. 按技术栈第 7.1 节检查手写源码 header，保留 shebang 与无注释格式例外，不修改生成产物。
- **测试**：违规样例以 `.ts.txt` 为后缀放在 `tests/catalog/fixtures/`（不会被 tsc 编译、也不在扫描范围内），测试把它们读成字符串交给检查函数，断言每条规则都能报出；覆盖合法 realm/kind 依赖、跨模块相对路径与 re-export、动态导入、未声明包、第三方越界、循环依赖，以及缺失/非法 header、开发文档与阶段引用、shebang、JSON 和生成文件例外。
- **完成判据**：`pnpm check` 通过（已包含 `check:boundaries`），对仓库报告 0 个违规。

## 3. 服务端世界

### S04 存储适配器

- **先读**：[存储](../architecture/storage.md) 全文、[事件与状态](../architecture/events-and-state.md) 第 2、4 节。
- **产出**：`modules/server/platform/storage/sqlite`：`migrations/0001_init.sql`（照抄第 2 节）、迁移执行器、`transact(fn)`（同步；`fn` 返回 Promise 时直接抛错）、`SAVEPOINT` 辅助、带 scope 的读写接口、`forkBranch()`（含第 3 节全部修正与 `branches` 行规则）、`backup()`（`VACUUM INTO`）。
- **测试**：覆盖 [storage.md — 存储验收](../architecture/storage.md#5-存储验收) 全部用例。分支级表清单与迁移文件一致。job 的 `seq` 在分支内连续递增，fork 后保持不变。未完成 turn 消费的 trigger 在新分支中被释放。
- **完成判据**：`pnpm check` 通过。

### S05 内容与配置加载

- **先读**：[内容包](../game/content-pack.md) 全文、[领域模型](../architecture/domain-model.md) 第 10 节、[配置](../platform/configuration.md) 第 3、10 节、[运营](../platform/operations.md) 第 10 节。
- **产出**：把内容包第 1–9、11、12 节的 YAML 照抄到 `content/world-packs/earth-2964-v1/`（`prompts/zh-CN.yaml` 与 `locale/zh-CN.yaml` 按第 12 节的键结构填写，文本来源见该节的表）；内容包第 10 节的两个名册与 `config/runs/online-default.yaml`；在 `packages/experiment` 实现内容加载器与配置加载器（YAML 读取、Zod 校验、`*Ref` 引用解析（仓库文件优先，其次数据库草稿）、`env:` 解析、交叉检查）。其余配置文件在 0.2 节指定的步骤创建。
- **迁移**：见 [IMPLEMENTATION-STATUS.md — 身份配额](../IMPLEMENTATION-STATUS.md#31-身份配额)。
- **测试**：完整内容包与正式名册加载成功。不存在的节点、重复 ID、正式名册超过 15 个身份、缺事件模板或缺词表键时加载失败并给出可定位的错误。四个禁用开局不进入可选列表，公社开局有闻昭入口和三条消息。配置加载测试覆盖引用解析、`env:` 解析与未知键拒绝。
- **完成判据**：`pnpm check` 通过。

### S06 authority：命令网关、job、时钟步骤与消费者

- **先读**：[领域模型](../architecture/domain-model.md) 第 2、4、5 节、[事件与状态](../architecture/events-and-state.md) 第 2 节、[插件机制](../architecture/plugins.md) 第 6 节、[规则](../game/rules.md) 第 1、11 节。
- **产出**：`packages/authority`：`CommandGateway.execute(auth, envelope)`（领域模型第 4 节的固定流程，包括 `campaign.start` 的暂停豁免、`allowDirectAgentCommands` 测试开关、SAVEPOINT 回滚与后续钩子）；`WorldTx` 实现（按模块 `ownsAggregates` 限制写入，`emit` 分配 `worldSeq`，`schedule` 分配 `seq`）；`JobRunner.runDue(branchId, tick)`（按 `(dueTick, seq)`）；时钟步骤注册接口（每日结算、章节评估由 world 模块注册）；事件消费者框架（offset + inbox，与处理结果同事务提交）；`afterCommand(type, hook)` 注册接口。
- **测试**：用测试内定义的两个小模块验证：重复命令返回原 receipt；同 ID 不同 payload 报冲突；处理器返回 rejected 时只写 rejected receipt、其他写入全部回滚；处理器抛出普通异常时不写 receipt；`expectedVersions` 不符报 `version-conflict`；写入他人拥有的聚合类型时抛错；job 按 `(dueTick, seq)` 执行且幂等；暂停时普通命令返回 `paused` 而 `campaign.start` 通过；消费者崩溃重启后不重复处理。
- **完成判据**：`pnpm check` 通过。

### S07 游戏模块（一）：时钟、地图、资源、世界

- **先读**：[规则](../game/rules.md) 第 1–5、8、10、11 节、[领域模型](../architecture/domain-model.md) 第 3–6 节、[模块目录](../architecture/module-catalog.md) 第 4.1 节。
- **产出**：`game.clock.controlled`（模式切换、tick 推进、step 目标）、`game.map.six-nodes`（道路状态、通行许可、Dijkstra 路径与行程）、`game.resources.light`（预留/释放/消耗/转移/调整 ops、等级计算）、`game.world.slg-light`（`campaign.start` 的世界部分：campaign、指标、角色/队伍/群体初态、九条委托、伤员期限 job；`policy.set`（水闸由自己处理，道路调用 map ops）；每日结算与章节评估两个时钟步骤；阈值事件）。
- **迁移**：见 [t168 资源交接](../IMPLEMENTATION-STATUS.md#32-t168-资源交接)与 [t144 程序案](../IMPLEMENTATION-STATUS.md#33-t144-程序案)。
- **测试**：覆盖 [rules.md — 库存、时钟与世界结算](../game/rules.md#库存时钟与世界结算) 的断言。验证 Dijkstra 的平局规则、开局指标、委托与群体初态，以及 t168 评估后时钟暂停、tick 169 被拒绝。
- **完成判据**：`pnpm check` 通过。

### S08 游戏模块（二）：通信、行动、协议、剧情、存档

- **先读**：[规则](../game/rules.md) 第 2、6、7、9 节、[内容包](../game/content-pack.md) 第 7–9 节、[领域模型](../architecture/domain-model.md) 第 4–7 节、[运营](../platform/operations.md) 第 3、4、6 节。
- **产出**：`game.comms.standard`（`dialogue.say`、`speech.commit`、`seat.say`、`information.share`、`probe.ask`、广播权限、送达延迟表、`conversation_lines` 投影；`campaign.start` 的后续钩子：开局消息与知识授权）、`game.actions.standard`（派遣的十步校验、邀请回复、取消、出发与完成 job、风险抽样与 `TaskDelayed`）、`game.agreements.standard`（提出即提出者已接受、回复、还价、过期、生效效果、履约/违约订阅）、`game.scenario.watergate` 与 `game.scenario.watergate-escalating`（`campaign.start` 后续钩子安排卡片 job、效果白名单、草稿/发布/撤回/补偿/覆盖命令；escalating 订阅 `DayPassed` 与 `TaskCompleted`）、`game.save.sqlite`（静默 → 分支复制 → 快照记录；恢复预检 → 复制 → 切换在线别名）。此时还没有 Agent，静默只需暂停时钟并排空 job。
- **迁移**：见 [IMPLEMENTATION-STATUS.md — 玩家公开广播](../IMPLEMENTATION-STATUS.md#34-玩家公开广播)。
- **测试**覆盖 [rules.md — 命令、通信、任务与协议](../game/rules.md#命令通信任务与协议) 的断言。协议八种条款各有一条履约与一条违约用例。验证公社玩家水闸条款生效和改策违约，并检查中继中断时的广播受众。两个剧情模块在同一脚本下的卡片触发 tick 与指标不同。`campaign.start` 之后开局消息、知识授权与剧情卡 job 齐全。快照后恢复，世界状态逐行相等且时钟为 paused。
- **完成判据**：`pnpm check` 通过；`tests/scenarios/world-only.test.ts` 用纯命令脚本跑完 168 tick，得到确定的 `ChapterStageEvaluated`。

### S09 服务端宿主与 API

- **先读**：[API](../architecture/api.md) 第 1–4、7、9 节、[两个端口](../architecture/two-endpoints.md) 第 1、6 节、[领域模型](../architecture/domain-model.md) 第 8.1 节、[技术栈](tech-stack.md) 第 5、6 节、[运营](../platform/operations.md) 第 2–4、10 节、[代码目录](../architecture/code-structure.md) 第 2、3 节、本文 0.2 节。
- **产出**：`apps/server`（`main.ts`：加载环境变量、打开存储、加载内容与配置、首次启动时按运营第 10 节创建在线世界与 live run、解析 server 装配、启动模块与 worker（时钟、job、消费者、投影推送）、监听；端口被占用时退出码非 0；`module-catalog.ts` 显式登记全部 server 模块定义）；`transport.http-ws.fastify`（0.3 节分配给 S09 的路由、Origin 校验、错误格式）；`platform.access-policy.roster`；`platform.secrets.env`；`platform.operations.standard`（暂停、继续、存档、恢复、重新开局的编排）；令牌生成与打印；玩家投影构建与增量推送（200 条重放缓冲）；两份主装配与已提前交付的剧情替换装配；`scripts/check-catalog.ts`（扫描 `config/assemblies/*.yaml`，通过组合根加载 server 模块目录，调用与宿主启动相同的 kernel 解析器校验 realm/kind、能力闭包、作用域、重复绑定、拓扑与模块配置 schema；client/console 尚无模块目录时只有其 bindings 为空才通过，非空即失败；失败时逐项打印文件与原因并以非零码退出）。
- **迁移**：见 [席位契约](../IMPLEMENTATION-STATUS.md#35-席位契约)与 [时钟操作原子性](../IMPLEMENTATION-STATUS.md#36-时钟操作原子性)。
- **测试**：用 `fastify.inject` 覆盖登录、会话、命令、receipt 查询、世界视图（含 `clock.runVersion`）、玩家访问控制台接口 403、错误 Origin 403、开局后继续与暂停；WS 用真实端口测试订阅、增量与断线重连。
- **完成判据**：`pnpm check` 通过（已包含 `check:catalog`）；`pnpm dev:server` 启动后 `GET /api/v1/health` 返回 ready，并打印两条登录地址。

## 4. 浏览器两端

### S10 客户端宿主、模块与启动脚本

- **先读**：[客户端](../architecture/client-and-rendering.md) 全文、[模块目录](../architecture/module-catalog.md) 第 5 节、[API](../architecture/api.md) 第 2–4、9 节、[技术栈](tech-stack.md) 第 4、6、8 节。
- **产出**：`packages/client-protocol`（类型化 HTTP 客户端、WS 客户端、投影 reducer）；`apps/client`（Vite 配置、宿主启动流程、slot 布局、登录、组合不完整页面）；客户端模块 `world-view.standard`、`scene-renderer.pixi`、`scene-renderer.null`、`camera.standard`、`screen-projection.isometric`、`input.standard`、`hud.standard`、`dialogue.standard`、`faction-start.standard`、`characters.standard`、`settings.standard`、`notifications.standard`；`scripts/dev.ts`、`scripts/start.ts`（S10 的 dev 只启动 server/client，build 只构建 client，不引用尚不存在的 console 配置）；`playwright.config.ts`（测试环境见技术栈第 8 节）；两份装配的 client 绑定。
- **测试**：reducer（快照 + 增量 + 缺口时重取）；`worldToScreen` 与 `screenToWorld` 往返误差小于 0.5 像素；`CommandClient` 重试复用同一 `commandId`；e2e `tests/e2e/player-start.spec.ts`：打开 `http://127.0.0.1:5173/#token=e2e-player`，选择开局（客户端随后自动继续时钟），侧栏点击岑雁，发送一句话，对话面板出现这句话。
- **完成判据**：`pnpm check` 通过；`pnpm test:e2e` 中的 `player-start` 通过。

### S11 控制台宿主与首批页面

- **先读**：[两个端口](../architecture/two-endpoints.md) 第 4、10 节、[模块目录](../architecture/module-catalog.md) 第 6 节、[API](../architecture/api.md) 第 5.1、5.5 节、[观测](../platform/observability.md) 第 8 节。
- **产出**：`apps/console`（宿主壳：登录、当前角色切换、导航、组合不完整页面；Vite 输出到 `apps/server/console-static/`）；`dev` 加入 console 的 `vite build --watch`，`build` 加入 console 的 `vite build`；服务端挂载 `/console/*` 静态资源（单页回退）；`platform.observability.sqlite`（span 落库与查询）、`platform.module-admin.standard`；0.3 节分配给 S11 的路由与 WS 频道；页面模块 `console.health.standard`、`console.module-admin.standard`、`console.observability.standard`（先只做时间线）。
- **测试**：e2e `tests/e2e/console-basic.spec.ts`：用 `#token=e2e-console` 登录后能看到运行总览；切换到 evaluator 后模块装配页置灰；用玩家会话请求 `/api/v1/console/health` 返回 403。
- **完成判据**：`pnpm check` 通过；`console-basic` 通过。

### S12 端口检查

- **先读**：[技术栈](tech-stack.md) 第 4、6 节、[两个端口](../architecture/two-endpoints.md) 第 1、7 节。
- **产出**：`scripts/check-ports.ts`：用 `pnpm start` 的方式启动两端，等待就绪后列出本次启动的子进程树的监听端口（Windows 用 `Get-NetTCPConnection`，Linux 用 `ss -ltnp`，macOS 用 `lsof -iTCP -sTCP:LISTEN`），断言恰好是 5173 与 3000，然后结束子进程。
- **测试**：`pnpm check:ports` 在本机通过；先占用 3000 端口再启动，进程以非 0 退出并提示端口被占用。
- **完成判据**：`pnpm check:ports` 通过；`pnpm dev` 与 `pnpm start` 都只产生两个监听。

## 5. Agent 管线

S13–S15 的模块用集成测试直接构造（用 kernel 解析测试内定义的小装配），S16 起才进入两份主装配。

### S13 感知、trigger 与调度

- **先读**：[运行时](../agent/runtime.md) 第 2–4、9、13.1–13.2 节、[感知](../agent/perception.md) 全文、[领域模型](../architecture/domain-model.md) 第 7 节。
- **产出**：`packages/agent-runtime` 的 trigger 存储、调度器宿主、turn 记录与租约、控制权与 epoch、名册激活与 15 个身份的配额（含 `campaign.start` 的激活钩子）；模块 `agent.perception.local`、`agent.scheduling.fair`。
- **测试**：逐行断言 [perception.md — 渠道、获知方式与细度](../agent/perception.md#112-渠道获知方式与细度)。未授权事件只推进扫描游标，带 `deliverAtTick` 的观察在到期 tick 才写入，`AgentsSummoned` 生成 `scenario` trigger。验证 trigger 去重，调度的优先级、老化、合并、冷却与“每个身份一个活动 turn”，以及被取消的 turn 释放 trigger、human 控制的身份不被调度。在线、实验和探针分支共用配额，第 16 个活动身份激活被拒绝，释放名额后可激活。
- **完成判据**：`pnpm check` 通过。

### S14 记忆 M0 与 M1

- **先读**：[记忆](../agent/memory.md) 第 1–7、10、11.1–11.6、11.9 节、[存储](../architecture/storage.md) 第 4 节、[运行时](../agent/runtime.md) 第 13.4–13.5 节。
- **产出**：MemoryPort 宿主（摄入 worker、actor 事务、revision 与水位、按 13.5 节的 CAS 与 rebase、整理任务排队与租约、唤醒建议转 trigger）；模块 `agent.memory.none` 与 `agent.memory.ledger`（显著度、分流、关系账本、承诺、衰减与每日整理、检索、强化、唤醒建议、自报要点裁决）。
- **测试**：覆盖 [memory.md — 验收用例](../agent/memory.md#10-验收用例) 中适用于 M0、M1 的用例。同一观察重投只记一次，按 revision 5 与 9 分别检索的结果不同且可重建。违约后关系 trust 按表下降，`causes` 含 `breach`。`proposeWakeups` 在 `dueTick − 6` 给出提醒且只触发一次。未被引用的记录不强化。无冲突的过期计划被 rebase，有冲突的被重新生成。
- **完成判据**：`pnpm check` 通过。

### S15 上下文、压缩、工具视图、工具网关与对白

- **先读**：[上下文](../agent/context.md) 全文、[压缩与工具视图](../agent/compression-and-tool-view.md) 第 4、6、12 节、[工具](../agent/tools.md) 第 2、3、7–10、13 节、[prompts](../agent/prompts.md) 全文。
- **产出**：模块 `agent.context.ordered-blocks`、`agent.compression.none`、`agent.compression.window`、`agent.tool-view.structured`、`agent.tools.game-tools`；`packages/agent-runtime` 的工具网关（binding 收窄与空集省略、null 字段剔除、operationId 幂等、调用/结果配对、原始与视图 artifact）与对白流程（可披露性判定、请求构建、四项校验、安全模板、`speech.commit`）；`config/toolsets/*.yaml`。
- **测试**：段落顺序与空段省略；压缩在首轮前按阈值触发、裁剪顺序与剔除报告；工具视图保留 envelope 并截断列表；越权参数被 binding 拒绝且不发命令；空的 enum 收窄导致工具被省略；同一 operation 重试不重复派遣；对白中含秘密 `leakTerms` 被拦截；进行中的任务说“已经送到”被拦截；每个 intent 的安全模板都能生成。
- **完成判据**：`pnpm check` 通过。

### S16 确定性决策与 turn 主循环

- **先读**：[运行时](../agent/runtime.md) 第 5–8、13 节、[prompts](../agent/prompts.md) 第 2.3、5 节、[配置](../platform/configuration.md) 第 10.2 节、本文 0.2 节 S16 行。
- **产出**：`packages/agent-runtime` 的 turn 主循环（13.3 节的全部阶段、每个阶段的 span 与 effective 记录）与 readiness 判定（13.4 节）；模块 `agent.decision.deterministic`（13.7 节，对白一律用安全模板）；profiles 与装配的 S16 更新。
- **测试**：在 `tests/integration/turn-deterministic.test.ts` 验证玩家对岑雁说话后触发一个 turn，模板对白出现在会话中。turn 进行中再收到的消息进入下一个 turn。在决策与对白之间接管时，旧 epoch 的对白不提交。暂停后不再创建 turn。按 [runtime.md — 违约后的立场与理由](../agent/runtime.md#违约后的立场与理由) 断言 M0 与 M1 的结果。
- **完成判据**：`pnpm check` 通过；`pnpm dev` 下用测试装配能看到岑雁的模板回话。

### S17 模型池、确定性传输与模型决策

- **先读**：[模型池](../agent/model-pool.md) 全文、[模型传输](../agent/model-transport.md) 第 1、2、5–8 节、[prompts](../agent/prompts.md) 全文、本文 0.2 节 S17 行。
- **产出**：模块 `agent.model-pool.shared`（挂载解析、队列与限流、重试与退避（用 `host.sleep`）、attempt 记录与 artifact）、`platform.budget.standard`（预算账本）、`platform.model-transport.deterministic`、`agent.decision.model`（decision 请求构建、工具循环与轮内顺序、`decision_submit` 校验与一次提醒、speech 调用）、`tests/fixtures/model/default.jsonl`；装配、profile 与配置的 S17 更新。
- **测试**：重复挂载与缺 purpose 在预检失败；可重试错误按 1 秒、4 秒退避（用假的 `sleep`）；`delayMs` 注入的晚到响应在接管后被丢弃；`decision_submit` 引用不存在的 ID 时提醒一次后失败；`providerReplay` 在下一轮原样回传；`length` 结束的 decision 轮使 turn 以 `invalid-decision` 结束；usage 缺失时按预留记账。
- **完成判据**：`pnpm check` 通过；测试装配下玩家与岑雁的对话走完整的模型路径（fixture 驱动）。

### S18 两个真实模型适配器

- **先读**：[模型传输](../agent/model-transport.md) 第 3、4、9 节；Anthropic TypeScript SDK 的官方文档与类型定义（只使用 SDK 导出的类型与方法）；所用 OpenAI 兼容供应商的接口文档（工具调用、JSON 输出、推理内容是否需要回传）。
- **产出**：`platform.model-transport.openai-compatible`（`fetch` 实现）、`platform.model-transport.anthropic`（`@anthropic-ai/sdk`，`maxRetries: 0`）；两份真实模型布局；`tests/live/openai-compatible.live.test.ts` 与 `tests/live/anthropic.live.test.ts`（只在设置了对应 API key 时运行，不进入 `pnpm test`）。
- **测试**：请求体快照测试（不发网络请求）：OpenAI 兼容的三种 `structuredOutput` 能力、两种 `assistantReplay`、工具与 tool 消息映射；Anthropic 的工具、`output_config`、两轮工具循环的回放与并行结果合并、`fallbacks` 开关；两者的错误分类表。
- **完成判据**：`pnpm check` 通过；设置真实 key 后两个 live 测试各自通过（无法获得 key 时在完成报告中如实写明“未运行”）。

## 6. 切片 A 验收

### S19 三核心角色端到端验证

- **先读**：[三核心角色双端验收](roadmap-and-acceptance.md#2-a三核心角色的-ts--灰盒双端贯通验证)、[观测](../platform/observability.md) 第 4、8 节、[两个端口](../architecture/two-endpoints.md) 第 10 节、[接口实现步骤](#03-控制台与玩家接口的实现步骤) 的 S19 行。
- **产出**：0.3 节分配给 S19 的路由；补全 `console.observability.standard`（Agent 检查器、turn 详情、trace）；`console.model-mounts.standard`（只读视图与校验）、`console.faction-ops.standard` 的时钟与存档部分、`console.debug.standard`；`config/profiles/variants/memory-m1-structured-ledger.yaml`（供本步场景测试使用）；`tests/scenarios/slice-a.test.ts`。
- **场景测试**（测试装配、确定性模型布局、core-3、`human-neutral` 开局；行为断言使用 `profilePatchRefs: [memory-m1-structured-ledger, decision-deterministic]`）：双端启动；玩家与岑雁交谈并收到回复；派遣运输并在规则 tick 完成；按 `s-promise` 的 break 分支，协议违约后岑雁对 tick 60 的请求 `stance = decline`、`reasonCode = past-breach`；暂停时 tick 不变且晚到候选不提交；单步推进有界；存档后重启服务端，恢复后位置、预留、任务与记忆一致且不重复结算，Agent 仍会回话；控制台能按 traceId 查到完整因果链；玩家会话访问控制台接口 403。
- **人工验证**：用真实模型布局（`shared-model-layout-v1` 或 `claude-model-layout-v1`）运行 `pnpm start`，按 `s-promise` 的步骤试玩一次，把观察到的行为与 trace 链接写进完成报告。
- **完成判据**：`pnpm check`、`pnpm test:e2e`、`pnpm check:ports` 全部通过。[三核心角色双端验收](roadmap-and-acceptance.md#2-a三核心角色的-ts--灰盒双端贯通验证) 的表格逐项有证据。

## 7. 记忆对比（切片 B）

### S20 M2、M3 与整理任务

- **先读**：[记忆](../agent/memory.md) 第 11.1、11.7–11.8 节、[prompts](../agent/prompts.md) 第 6 节、[运行时](../agent/runtime.md) 第 13.1、13.4、13.5 节。
- **产出**：模块 `agent.memory.stream-reflection`、`agent.memory.layered-hybrid`；整理 worker 的模型调用路径（`runMaintenance`、校验、CAS 提交、`derivedThroughSeq`）；其余四个记忆 variant 文件（`memory-m0-window`、`memory-m0-current`、`memory-m2-stream-reflection`、`memory-m3-layered-hybrid`）；装配的 S20 更新。
- **测试**：M2 达到重要度阈值后排入一次 `due_tick = 当前 tick + 1` 的反思，反思引用不存在的记录时被丢弃；M3 的核心块总是记忆段第一条且不超过 300 token；M3 整理的模型段失败时保留规则段结果、不推进 derived 水位，之后的 strict turn 立即 not-ready；五个记忆 variant 均可解析；四个主组 variant（M0 window、M1、M2、M3）在同一输入下的入模记忆段确实不同（比较 context artifact），另验证 `memory-m0-current` 的 `historyTurns = 0`。
- **完成判据**：`pnpm check` 通过。

### S21 实验、探针与评估页面

- **先读**：[评估](../platform/evaluation.md) 全文、[配置](../platform/configuration.md) 第 3、10.3 节、[内容包](../game/content-pack.md) 第 11 节、[存储](../architecture/storage.md) 第 3 节、本文 0.3 节 S21 行。
- **产出**：`packages/experiment` 与 `platform.evaluation.standard`（RunSpec 预检、manifest 冻结、冷启动与快照两种建分支方式、受控时钟驱动脚本、实验展开与顺序执行、探针沙盒（只激活被提问的 Agent）、计分、报告）；`console.evaluation.standard`；`config/runs/exp-memory-promise-v1.yaml`、`exp-memory-rumor-v1.yaml`、`exp-memory-secret-v1.yaml`（格式见配置第 10.3 节）。
- **测试**：同一 RunSpec 两次预检得到相同 manifest hash；两个 run 的分支互不串读；探针在沙盒中运行且不改变实验分支；四种探针 kind 的计分用例；没有对白的探针记为无效；`exp-memory-promise-v1` 换成测试装配、确定性模型布局与 `commonPatchRefs: [decision-deterministic]` 运行，tick 60 岑雁的立场必须是：

| 记忆组 | break 分支 | keep 分支 |
|---|---|---|
| M0 `memory-m0-window` | accept | accept |
| M1 `memory-m1-structured-ledger` | decline，`past-breach` | accept |
| M2 `memory-m2-stream-reflection` | accept | accept |
| M3 `memory-m3-layered-hybrid` | decline，`past-breach` | accept |

- **完成判据**：`pnpm check` 通过；控制台能创建实验并查看带分子分母的报告；用真实模型跑一次 `exp-memory-promise-v1`（可把 repetitions 改为 1）并把报告附在完成报告里，结果如实记录，允许“差异不显著”。

## 8. 完整首版（切片 C）

### S22 十五个身份与运营功能

- **先读**：[角色册](../game/characters.md)、[玩法](../game/gameplay.md)、[运营](../platform/operations.md) 全文、[两个端口](../architecture/two-endpoints.md) 第 10 节、本文 0.3 节 S22 行。
- **产出**：`standard-15` 名册的完整运行（8 名公社支持者、4 名 AI 党魁、3 名外域，伊诺使用 `character-broadcaster`）；玩家占 `seat.commune`（派系 `human-neutral`），公社同席 AI 党魁不实例化；0.3 节分配给 S22 的路由；`console.faction-ops.standard` 的席位接管、席位视图、席位命令与运行申请审批；`console.scenario-editor.standard`；`console.audit.standard`；客户端设置里的测试 preset 申请；`platform.operations.standard` 的接管 epoch、租约续期与过期处理；`config/presets/*.yaml`。
- **程序案**：实现 [rules.md — t144 程序案](../game/rules.md#101-t144-程序案) 的提案与投票命令、五席授权、玩家投票界面、AI 党魁投票、`MotionDecided` 事件和持久议事录。同步公共契约、感知模板、玩家投影及 t168 评估结果。
- **章节交接**：按 [序章资源边界](../00-scope-and-invariants.md#12-序章资源边界) 接入 t168 六种城市资源的交接数据。
- **测试**：覆盖 [完整首版的验收条件](roadmap-and-acceptance.md#4-c完整首版与可维护扩展) 中的工程断言。接管发生在模型返回前，旧 epoch 的命令被拒绝。租约过期后该席位不再产生自主提案。验证草稿卡不可感知、发布幂等、补偿有来源、覆盖标记污染，以及导出包里没有密钥。
- **表决测试**：每席最多一票，重复提交幂等，外域与越权投票被拒绝。3 票通过，2 票含缺席或弃权时仍失败。结果可由事件与议事录查到，恢复后保留。
- **完成判据**：`pnpm check` 通过。

### S23 切片 C 验收

- **先读**：[完整首版的验收条件](roadmap-and-acceptance.md#4-c完整首版与可维护扩展)、[故障与竞态验收](roadmap-and-acceptance.md#7-必须通过的故障与竞态)。
- **产出**：`tests/scenarios/slice-c.test.ts`（测试装配、`standard-15`）验证公社席进入序章并产生初始委托与消息，15 个身份每人至少一次可接触的交互，第 16 个身份被拒绝，AI 党魁的每日巡检不造成无界推理。逐行覆盖 [故障与竞态验收](roadmap-and-acceptance.md#7-必须通过的故障与竞态) 的故障注入表，模型故障用确定性传输注入。e2e `tests/e2e/console-ops.spec.ts` 覆盖席位接管与交还、发布一张草稿卡、查看一个 turn 详情。
- **序章验收**：玩家在 t144 投下本席一票，四个 AI 席按立场投票。议事录显示结果，t168 评估引用该结果，评估后停止推进。[rules.md — 程序案结果](../game/rules.md#程序案结果) 的两种议程顺序均须验证。
- **完成判据**：`pnpm check`、`pnpm test:e2e` 通过；用真实模型以 `standard-15` 运行至少一个游戏日，把队列积压、延迟、token 与失败率记录进完成报告。

## 9. 可插拔验收（切片 M）

### S24 第二实现与替换证据

- **先读**：[模块目录](../architecture/module-catalog.md) 第 8、9 节、[配置](../platform/configuration.md) 第 10.1 节、[客户端](../architecture/client-and-rendering.md) 第 8.6 节、[两个端口](../architecture/two-endpoints.md) 第 10.2 节。
- **产出**：`client.hud.compact` 与 `console.observability.lite`，分别新增替换装配。已有的 `local-slg-escalating-v1` 随标准装配定稿。`check-catalog` 增加替换装配与标准装配只替换一个 binding 的断言，`tests/scenarios/swap.test.ts` 记录替换证据。
- **测试**：剧情替换后，同一命令脚本下卡片触发 tick 与指标不同，其余模块代码未改；HUD 替换后，同一条玩家命令得到相同 receipt 与事件；观测页替换后，同一个 turn 在新页面可查，玩家会话仍 403；四个记忆组在同一脚本下各有独立的运行证据。
- **完成判据**：`pnpm check` 通过；对每次替换给出 `git diff --stat` 证明只改了模块自身、装配文件与配置。

### S25 交付包

- **先读**：[模块替换验收](roadmap-and-acceptance.md#5-m全模块可插拔与双端验收首版核心)、[交付包与判定](roadmap-and-acceptance.md#9-交付包与判定)。
- **产出**：`docs/delivery/report-v1.md` 按 [交付包与判定](roadmap-and-acceptance.md#9-交付包与判定) 的表格列出源码 revision、启动步骤、四类替换的 diff 与 trace、实验报告、端口检查、已运行/失败/跳过的检查、人工体验记录与已知限制。
- **完成判据**：`pnpm check`、`pnpm test:e2e`、`pnpm check:ports` 全部通过；报告里每一项都有证据链接，未完成与未测试的项目如实列出。
