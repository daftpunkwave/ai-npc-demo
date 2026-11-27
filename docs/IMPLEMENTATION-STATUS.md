# 实现状态与迁移清单

> 本页集中记录已交付能力，以及代码和内容相对 [00-scope-and-invariants.md — 序章范围](00-scope-and-invariants.md) 与 [rules.md — 序章规则](game/rules.md) 的差距。交付范围变化时更新本页。实施顺序与步骤完成判据由 [build-plan.md — 构建计划](delivery/build-plan.md) 规定。
> Demo 版本为 `0.1.0`，运行内容版本为 `0.3.0`。

## 1. 总览

Godot C# 原生玩家端及正式 3D 美术处于规划状态。当前玩家端仍为浏览器宿主。目标边界见 [client-and-rendering.md — Godot 原生玩家端](architecture/client-and-rendering.md#9-godot-原生玩家端)，发布条件见 [roadmap-and-acceptance.md — Godot 玩家端切换验收](delivery/roadmap-and-acceptance.md#godot-玩家端切换验收)。

标准与测试装配已接入 Agent 感知、公平调度、M0–M3 记忆组、上下文、压缩与工具视图。新建标准运行按模型布局使用 OpenAI 兼容或 Anthropic 传输，测试装配使用确定性传输。控制台展示运行总览、模块装配、时间线和 Agent 状态，operator 可以暂停、继续、创建及恢复快照。参见 [apps/server/README.md — 服务端当前范围](../apps/server/README.md)、[apps/client/README.md — 玩家端](../apps/client/README.md)、[apps/console/README.md — 控制台](../apps/console/README.md)。

| 项 | 规格 | 当前实现 | 状态 |
|---|---|---|---|
| 工程与服务端基础 | workspace、公共契约、kernel、存储、authority 与服务端宿主 | 已有 SQLite 分支复制与备份、命令网关、事件消费者、装配预检，以及在线 RunSpec 与 manifest 冻结 | **已实现** |
| 玩家身份与开局 | 公社党魁，占 `seat.commune` | 以 `player-1` 登录；`campaign.start` 与 `/campaign` 只开放 `human-neutral`，其余四席 `enabled: false` | **已对齐** |
| 玩家权力 | 直接改水闸、以党魁身份签水闸条款、公开广播 | `policy.set` 与 `water-allocation` 条款已按 campaign 的玩家与派系裁决；`broadcast.say` 对同一玩家开放并按公开广播规则冻结投递 | **已对齐** |
| 席位契约 | 命令、事件、投影、存档可追溯席位与实际动作者 | 以 principal、派系和分支关联数据，公共契约及持久层未记录 `seatId` | **待补契约** |
| Agent 编制 | 15 个，即 8 名支持者、4 名 AI 党魁和 3 名外域 Agent | `standard-15` 绑定 8 名公社支持者、4 名 AI 党魁与 3 名外域；内容包同步为 11 条角色与 8 条派系记录 | **已对齐** |
| 运行配额 | 在线、实验及探针合计 15 个活动身份 | 激活事务统计所有活动或暂停分支的活动身份，开局、在线恢复、实验开局与探针沙盒执行同一配额检查；探针期间实验名册休眠、沙盒只激活被问 Agent。尚无释放在线名额的运营接口 | **已对齐在线与实验流程** |
| 时钟 | 20 秒/tick | 时钟模块默认值与三份装配均为 20 秒/tick | **已对齐** |
| 资源 | 序章结算 3 种库存，t168 交接 6 种城市资源 | 库存契约仍只定义 `supply`/`energy`/`medical`；t168 评估事件与 campaign 写入六种城市资源初值，评估后的玩家投影给出该快照 | **已实现交接** |
| 地图 | 序章 6 节点、9 条路 | 6 节点、9 条路 | **已对齐序章** |
| 剧情卡 | 标准装配九张，t2–t144 | 数量、时点、署名与唤醒身份已对齐；谷寻私信投给 `player-1` | **已对齐** |
| 三项仪表 | 中继 45、果园 50、迁徙 50；日结顺序 | 已实现 | **已对齐** |
| t144 程序案 | 五席各 1 票，3 票通过 | 剧情卡发出议事邀请，目前没有表决状态、事件或议事录 | **目标** |
| 序章终点 | t168 评估后切片结束 | 已提交评估、标记 campaign 为 `evaluated` 并暂停时钟，保留存档 | **已对齐** |
| 表现 | 2.5D 序章灰盒，后续目标为 3D | PixiJS 灰盒已实现基础节点、道路、角色与选择；正式 3D 待后续 | **部分实现** |
| 玩家客户端 | 登录、开局、授权投影、人物/地点、对话、HUD、设置、通知 | 已实现，`player-start` e2e 通过 | **已实现基础流程** |
| 控制台研究与评估页面 | 运行总览、模块装配、模型挂载、时间线、Agent 检查器、turn 证据、评估对比、调试 | 已实现页面模块（含 `console.evaluation.standard` 评估页面）与服务端研究/评估接口；`console-basic`、`console-model-layouts`、`console-operations` e2e、场景测试与角色权限测试通过 | **已实现研究与只读评估页面** |
| 控制台运营 API | 按角色提供时钟、单步、存档与恢复 | operator 可暂停/继续、受控单步、创建快照与恢复，operator 与 researcher 可列快照；单步进入 stepping 后由宿主 worker 逐 tick 推进，入口只作用于在线分支 | **已实现** |
| 控制台运营页面 | 席位接管与交还、剧情卡运营、审计导出、运行申请审批 | `/ops/*`、`/scenarios/*`、`/run-requests` 与对应页面模块尚未实现；服务端目前只有时钟与快照入口 | **目标** |
| Agent 模型调用 | 集中路由、用途隔离、预算与证据 | 标准与测试装配预检并冻结挂载，按尝试计费和归档。常规检查覆盖两种真实传输的请求映射、对白流程以及记忆整理结果校验；真实供应商连通性需用密钥单独验证 | **已接入三种传输** |
| 双端端口 | 网页模式监听 5173 与 3000，原生目标只监听 3000 | 网页开发/生产启动均已验证，占用 3000 时启动失败 | **网页已对齐，原生待实现** |
| 模块替换 | 分别验证剧情规则、HUD、观测页和记忆替换 | 已验证服务端剧情替换，其他替换证据仍需补齐 | **部分实现** |
| 交付验收 | 三核心角色场景、完整序章场景与交付包 | 已有世界规则场景与玩家、控制台基础 e2e；t144 程序案、控制台运营 e2e 与完整交付包仍未完成 | **部分验证** |

### 1.1 构建计划步骤进度

下表按 [build-plan.md — 构建计划](delivery/build-plan.md) 的步骤顺序汇总当前进度。状态以代码、可执行测试与本页第 2 节的能力记录为准；未完成的步骤不因局部实现而标为完成。

| 步骤 | 范围 | 状态 | 依据与剩余 |
|---|---|---|---|
| S00–S03 | 仓库骨架、contracts、kernel、module-sdk 与边界检查 | 已交付 | `pnpm check` 的 `typecheck`、`test`、`check:boundaries` 持续覆盖 |
| S04–S09 | SQLite 存储、内容加载、authority、游戏模块、服务端宿主与 API | 已交付 | 服务端集成测试与宿主测试覆盖；席位契约与时钟操作原子性另列于第 3 节 |
| S10–S12 | 玩家客户端、控制台宿主、双端端口检查 | 已交付 | `player-start`、`console-basic` 等 e2e 通过 |
| S13–S18 | 感知与调度、M0/M1 记忆、上下文与工具、turn 主循环、模型池与两种真实传输 | 已交付 | 记忆、运行时、模型池与传输契约测试覆盖 |
| S19 | 三核心角色端到端验证 | 已交付 | `tests/scenarios/slice-a.test.ts`、玩家与控制台 e2e |
| S20 | M2/M3 与记忆整理任务 | 已交付 | 五个记忆 variant 与整理模型路径均有测试 |
| S21 | 实验、探针与评估页面 | 部分交付 | 实验展开、创建/启动/停止、闭环冷启动的实验执行器、计分、报告与只读控制台评估页已实现；用真实模型跑 `exp-memory-promise-v1` 尚未执行，`setup` 预置知识与控制台创建/启停表单未接，见 3.1 |
| S22 | 十五个身份、t144 程序案、运营与剧情页面、t168 交接、公开广播 | 部分交付 | 15 身份与配额、t168 六资源交接、玩家公开广播已交付；t144 程序案（3.3）、控制台运营页面、席位契约（3.5）未完成 |
| S23 | 切片 C 验收 | 未完成（受阻） | `slice-c` 场景、故障注入逐行覆盖、`console-ops` e2e、真实模型单游戏日运行均未完成；t144 是直接前置 |
| S24 | 第二实现与替换证据 | 未开始 | `client.hud.compact`、`console.observability.lite`、替换装配与 `swap.test.ts` 尚未创建 |
| S25 | 交付包 | 未开始 | `docs/delivery/report-v1.md` 尚未创建 |

## 2. 已交付能力说明

1. **名册与身份**：新增 `config/rosters/standard-15.yaml`，同步 `core-3`、`.env.example`、`config/runs/online-default.yaml` 与服务端默认 `rosterRef`。单人正式名册的 schema 上限改为 15。
2. **内容包结构**：`factions.yaml` 拆分为 `factionHomeNodeId`、`outpostNodeId`、`territoryNodeId`，并补上党魁、秘密与关系；`characters.yaml` 对齐 8 名公社支持者和 3 名外域 Agent，新增 `characterId` 与 `secret`；`starts.yaml` 只启用公社席，并补上闻昭的第三条开局消息；`world-init.yaml` 的职责委托改用党魁运行身份；`evidence.yaml` 清理旧身份持有者；`locale/zh-CN.yaml` 的玩家称呼改为“党魁”并补齐材料、食物、水词条。
3. **剧情卡署名**：把青枝、洛、追风、唐箴的署名改为 `species-flora`、`species-extraterrestrial`、`species-fauna`、`human-pacifist`；沈砾、苏回、谷寻保留为 signature-only 署名，不实例化。内容加载器、剧情模块与剧情卡校验共用同一份名单。
4. **时钟与章节终点**：20 秒/tick 写入时钟模块默认值与三份装配。章节评估步骤在 t168 把停止请求与评估结果同事务写入持久停止点，tick 收尾后暂停时钟；崩溃后重启或补完会补做幂等暂停并拒绝 t169，存档保留。
5. **公社玩家权限**：玩家会话可以提交 `watergate.allocation` 的 `policy.set`，处理器按 campaign 的 `playerId` 与 `factionId` 裁决；其他派系党魁返回 `no-authority`。`water-allocation` 条款允许玩家 `player-1` 作为义务人，改策违约按 `PolicyChanged.byId` 记到协议。
6. **任务规则身份**：任务加成从旧角色 ID 迁移到 15 人编制，并按队伍所属派系限定本派支持者：穆枝参与本派救援减 2 tick，祁录参与本派侦察每条道路减 1 tick，陶安参与本派修复 +10，陆沉参与本派迁徙道路护送 +4；追风对任何队伍的侦察与迁徙道路护送同效，洛参与非 `team-star` 修复 +15，这两项不按本派判定。救援参与人允许在医疗目的地节点加入。
7. **玩家客户端**：新增类型化 HTTP/WS 客户端、授权投影 reducer、命令幂等重试与 12 个客户端模块；公社开局、岑雁对话、HUD、地点/人物/任务侧栏和本机设置走同一服务端协议。
8. **控制台研究页面**：新增控制台宿主、运行总览、模块装配、模型挂载、时间线、Agent 检查器、turn 证据、artifact、trace 与调试面板；服务端提供健康、模块目录、装配详情、模型布局只读/校验、记忆与观察、研究查询和调试入口，并将 HTTP 请求跨度写入 `trace_spans`。
9. **双端运行与端口检查**：新增 `dev`、`build`、`start`、Playwright e2e 和端口检查。开发与生产启动只监听 `5173`、`3000`，占用 `3000` 时启动明确失败。
10. **Agent 感知与记忆基础**：感知消费者持久化延迟观察与 trigger，公平调度创建租约隔离的 turn；M0 只推进观察与派生水位，M1 将经历、关系、承诺与自报要点写入结构化账本，M2 维护观察流并按重要度触发反思，M3 在 M1 的规则层上增加看法、核心块、公共编年史和每日模型整理。记忆发布保存不可变 revision，维护与引用强化在 actor 事务外生成计划并按 revision CAS；冲突计划可 rebase 或重算，整理租约在重启后恢复，到期承诺按去重键生成 `prospective` trigger。
11. **确定性 Agent turn**。从冻结观察和记忆生成决定，动作经工具网关执行，安全模板通过权威命令提交。新消息在下一轮处理，暂停或控制权变化拦截晚到发布。各阶段保存 span 与生效记录。
12. **受控单步推进**：operator 经 `/api/v1/console/campaign/step` 按 `operationId` 与 `expectedRunVersion` 从 `paused` 进入 `stepping`（`ticks` 1–24），宿主 tick worker 逐 tick 推进并在到达目标、推进失败或章节终点时收尾回 `paused`；单步同样纳入部署级幂等表（迁移 0008 扩展 `step` 种类），单步中的快照先受控暂停，重启把非暂停时钟归位为 `paused`。
13. **模型决策与预算账本**。标准与测试装配按 Agent 和用途绑定模型，限流账号可跨模型 ID 共享。每次发出的尝试分别预留和结算预算，缺失 usage 按预留计入账本。工具历史逐轮追加，独立的对白请求经过披露、引用、泄密和状态检查。前版确定性运行可按原冻结摘要恢复。

14. **记忆对比变体**：`config/profiles/variants` 提供 M0 window、M0 current、M1、M2 与 M3 的可解析补丁；M2 的反思和 M3 的每日整理均经 `memory-maintenance` 模型用途调用。模型失败时 M3 保留规则段变更、记录 `partial` 结果且不推进 派生水位（`derivedThroughSeq`、`derivedThroughTick`），后续 严格模式轮次 按未就绪处理。
15. **探针命令**：`probe.ask` 由通信模块注册，只接受 `system:world` 在活跃沙盒分支发行。分支种类限制在命令网关独立裁决，不依赖时钟暂停状态，因此运行中的在线分支与实验分支同样拒绝；沙盒上的暂停豁免只解决「沙盒不推进逻辑时间」这一点。处理器写入面向被问主体的 `ProbeAsked` 事件，并按 `probeId` 聚合去重，同一探针重复提交（含换命令 ID）只留一条观察。未知主体、非系统发行者与非沙盒分支都被拒绝且不留事件。
16. **实验规格与 run 展开**：`config/experiments/exp-*.yaml` 声明 RunSpec 模板、脚本章节、变体、重复次数与 run 顺序；`expandExperimentRuns` 按「变体 × 脚本分支 × 重复次数」确定展开，同一次重复的各变体共享 `seed:rep<n>`（便于配对比较），`runOrder: rotate` 让每次重复的变体起点后移。加载时交叉校验脚本分支、变体补丁可叠加性、名册与内容引用，任一不可解析都在创建分支之前失败。没有命名分支的脚本按每个变体每重复一次展开。
17. **探针计分与报告组装**：`platform.evaluation.standard` 提供四种探针 kind 的词面计分（匹配前去空白与标点）、六种无效样本判定、带分子分母的指标聚合与「变体 × 脚本分支」实验汇总。指标无法计算时写 `null` 并标注 `n/a`；无效探针不进正确率分母但按原因单列计数；确定性决策的模板对白不算降级。该模块无状态、部署级单例，输入端由宿主注入，自身不读存储。
18. **评估读取接口与控制台页面**：`/api/v1/console/runs`（列表、详情、报告）与 `/api/v1/console/experiments`（列表、详情）按角色鉴权，研究员与评估员可读，玩家与操作员返回 403；`console.evaluation.standard` 页面为只读评估视图，可选实验与 run、展示分组汇总与逐格样本数，不可计算指标显示 `n/a`，样本少于 3 例标注「样本不足」（实验与 run 的控制台创建、启停表单仍在界面层待接）。实验标识按配置引用格式校验（如 `exp-memory-promise-v1`），与运行期生成的 12 位 base32 ID 区分开。读取一律以归档结论为准：探针有效性沿用 `probe_results` 执行时写入的判定，延迟由 turn 的 `started_at`/`ended_at` 计算，缺脚本声明的探针标记为证据不完整；不按 `seed` 文本推断实验归属。当前计分模块输出 5 项探针指标（`recall-accuracy`、`omission-rate`、`belief-accuracy`、`fabrication-rate`、`leak-rate`）；规则拒绝率与可定位率指标尚未接入。
19. **评估写入接口（创建 run 与导出）**：研究者可 `POST /api/v1/console/runs` 创建 run，预检覆盖规格交叉校验、装配可加载性、Agent profile、工具集与模型挂载解析以及 manifest 冻结（manifest 含 `agentProfiles` 与 `models`），失败返回 `preflight-failed` 与逐条原因且不落库；`POST /api/v1/console/exports` 导出 run 的 manifest、事件、turn 的 artifact 索引、探针结果与实验汇总，`redacted` 清空正文（含探针回答与决策的 `decisionNote`）、`raw` 保留正文，两者都不输出凭据解析值。评估员对这两个接口返回 403。`POST /experiments` 已实现：按实验规格展开「变体 × 脚本分支 × 重复次数」并逐个创建 run，实验标识写入每个 RunSpec，评估读取据此归组而不依赖 `seed` 文本。`POST /runs/{runId}/start|stop` 已实现：启动把 run 置为 `running`、初始化该分支时钟并唤醒实验执行器，停止置为 `paused` 并同步时钟，状态不符返回 409。
22. **实验执行器**：宿主进程内的执行器按启动先后逐个驱动 `closed-loop`、带脚本的实验 run：以玩家身份冷启动开局并在开局事务内预留名册配额，按规则第 1 节以 `stepping` 逐 tick 推进、按声明顺序注入脚本命令并等待规则、感知、记忆摄入、到期整理与 turn 收敛；到检查点时暂停时钟、休眠实验名册，为每个探针复制沙盒分支并只激活被问 Agent，以 `system:world` 提交 `probe.ask`，探针 turn 结束后补齐 `probe_results` 的无效原因并归档沙盒，再重新预留配额；走完脚本后按报告口径写入 `experiment_results`。每个 run 使用自己的 seed、命令网关、调度与工具模块和 Agent 运行时，不读写在线分支；冻结配置在执行前按同一实现复算核对，run 装配须与宿主一致。停止、宿主关闭、配额不足与重启遗留都归位为 `paused` 并释放配额，其余失败按原因码记为 `failed`。`GET /api/v1/console/runs/{runId}/progress` 与实验分支的生命周期审计给出执行进度。集成测试 `tests/integration/experiment-runner.test.ts` 与 `experiment-runner-failures.test.ts` 用确定性模型覆盖检查点推进、沙盒隔离、探针结果、汇总、配额、turn 失败、停止恢复、超时与重启。尚未接入：脚本 `setup` 预置知识、非玩家身份的脚本步骤、`audit`/`open-loop` 模式与快照起步。
20. **t168 城市资源交接**：`world-init.yaml` 新增 `cityResources`，按数值基线写入能源 140、材料 160、食物 120、供给 60、医疗 40、水 72。t168 章节评估在同一事务把该快照写入 `ChapterStageEvaluated` 与 campaign 聚合；评估后的玩家投影给出 `cityResources`，序章库存与已发生的消耗保持不变。该字段在内容 schema 中为可选：旧内容包缺少它时仍可加载，评估写入 `null` 交接；旧事件、旧 campaign 状态与旧投影缺少该字段时同样按 `null` 读取。内容版本提升到 `0.3.0`，资产清单版本随之更新。
21. **玩家公开广播**：`broadcast.say` 只允许已开局 campaign 的玩家主体发行。通信模块按 campaign 的玩家与派系公社席裁决权限，发布位置取玩家所在节点，按公开广播规则冻结投递并提交 `MessageSent`；中继中断时只保留同节点收件者。角色与传闻路径不变。

## 3. 剩余迁移项

### 3.1 身份配额

状态：配额已交付。部署级共享配额在开局和恢复事务内执行，活动或暂停分支上的活动身份共用 15 个名额，归档分支退出计数。实验执行器在实验开局与每个探针沙盒激活时执行同一配额检查，探针期间实验名册休眠、沙盒只激活被问 Agent，run 完成、失败或停止后名册休眠释放配额（第 2 节第 22 项）。**剩余缺口**：服务端没有“保存并释放在线名额”的运营接口，暂停在线时钟不释放名额；标准 15 人在线世界已开局时，实验在开局前暂停（`quota-unavailable`），需要在在线世界未开局或使用较小名册的独立数据目录上执行，或在名额腾出后再次启动。该接口的形态（释放与恢复的命令、与快照的关系、恢复时的原子预留）尚未定稿。用真实模型跑 `exp-memory-promise-v1` 并产出报告尚未执行，由维护者用真实凭据完成；`exp-memory-rumor-v1` 依赖的 `s-rumor` 含 `setup` 预置知识，执行器尚无经命令网关的预置入口，会以 `script-setup-unsupported` 失败。

### 3.2 t168 资源交接

状态：已交付。`world-init.yaml` 的 `cityResources` 提供六种城市资源初值；t168 评估把交接快照写入 `ChapterStageEvaluated` 与 campaign 聚合并随玩家投影下发。序章只结算 `supply`、`energy`、`medical` 三种库存的规则不变，材料、食物、水不追溯序章消耗。该字段在内容 schema 中为可选项：旧内容包缺少它时仍可加载，评估写入 `null` 交接；旧事件与旧存档缺少该字段时按 `null` 兼容读取。

### 3.3 t144 程序案

**状态：受阻，未实现。** 需要补齐提案与投票命令、五席授权、`MotionDecided` 公共事件与感知模板、议事录、玩家投影及其词条，并把结果写进 t168 评估。以下规则细节在仓库文档中仍明确标注为待定稿，按项目规范不得靠猜测补齐：

- 表决截止时点与缺席结案的时点；
- 四名 AI 党魁“按立场与已发生事实投票”的判定规则、触发路径（工具调用、调度 job 还是世界规则）以及事实来源；
- 提案与投票命令的最终名称、载荷字段与议事录持久化形状。

构建计划允许对未覆盖选择采取最保守且可回退的实现，但本项缺的是会直接决定投票结果与 S23 验收断言的规则语义，不是实现细节；先实现会把未定稿的猜测固化成世界事实。参见 [rules.md — t144 程序案](game/rules.md#101-t144-程序案)、[domain-model.md — 命令目录](architecture/domain-model.md#5-命令目录)、[perception.md — 观察内容](agent/perception.md#114-观察内容)。S23 的序章验收依赖本项。

### 3.4 玩家公开广播

状态：已交付。`broadcast.say` 由通信模块注册，只接受已开局 campaign 的玩家主体；处理器确认其派系持有公社席后，按公开广播规则计算并冻结投递，提交 `MessageSent`（channel `broadcast`）。发布位置取玩家所在节点，中继中断时只保留同节点收件者。Agent 的广播仍走 `speech.commit` 的批准流程，两条路径互不复用。

### 3.5 席位契约

**状态：未实现，字段设计待定稿。** 需要补齐 `seatId` 与 `actorId` 的持久记录、会话授权、命令、事件、投影和存档回放。公共契约目前只有 `seatHandoverRequest` 等控制台运营 DTO，命令信封、事件信封、回执与分支回放字段尚未定稿；按文档要求“先定稿存储与接口字段”，本项未凭猜测落库。参见 [contracts.md — 契约演进](architecture/contracts.md#7-契约演进)。

### 3.6 时钟操作原子性

**状态：未实现。** 暂停与继续当前在时钟状态提交后单独写入 `operationId` 结果，两次提交之间进程退出会留下“时钟已变、结果未记”的窗口；原请求按旧版本重试会得到 `version-conflict`，需要改用当前版本和新的 operationId。修复需要把时钟状态变更与幂等记录并入同一存储事务，并把生命周期的启动前恢复（会自行开启事务）拆到事务之外；未在本分支实施。可重试失败与不可重试失败的幂等重试规则见 [operations.md — 时钟与运行状态](platform/operations.md#2-时钟与运行状态)。

### 3.7 冻结装配能力升级

状态：已交付。代码已实现显式迁移：能力闭包差异经 `WORLD_PRISM_MIGRATE_ONLINE_RUN=1` 在单个存储事务内派生后继在线分支、沿用源 RunSpec 与 seed、按当前能力闭包重新冻结 manifest、归档源分支并原子切换在线别名；非能力差异与校验失败保持拒绝启动，源 run 与 manifest 不改写。验收由 `tests/integration/online-run-migration.test.ts` 覆盖，操作语义见 [operations.md — 能力闭包升级迁移](platform/operations.md#102-能力闭包升级迁移)。

### 3.8 剩余表现与 Agent 管线

artifact 正文超过 `inlineArtifactMaxBytes` 时写入数据目录下的独立文件，不超过时内联存储。完整证据与提案及派遣交互、完整分支对比、席位接管与剧情运营页面、正式 3D 资产仍有交付缺口。3D 资产按 [02-modeling-spec.md — 建模规格](design/assets/02-modeling-spec.md) 单独验收。

## 4. 迁移验收要点

下表按主题列出迁移验收要点。实施顺序见 [build-plan.md — 构建计划](delivery/build-plan.md)。

| 交付内容 | 范围 | 验收要点 |
|---|---|---|
| 身份配额 | 部署级 15 个活动身份的配额 | 达到配额后第 16 个身份激活被拒，释放后可重新激活 |
| 章节交接 | 六种资源在 t168 的初值与投影 | 评估事件带交接数据，冻结分支可复算 |
| 程序案与章节评估 | t144 表决、议事录与 t168 评估关联 | 表决、投影、章节结果及存档恢复均有验证 |
| 玩家公开广播 | 公社党魁经命令网关提交广播 | 提交产生 `MessageSent`，投递遵循 [rules.md — 通信、证据与传闻](game/rules.md#9-通信证据与传闻) 的广播规则。中继中断时只向发布地的收件者投递 |
| 席位契约 | 命令、事件、投影、存档的席位归属 | 恢复和回放保留席位与实际动作者 |
| 时钟操作原子性 | 暂停、继续的状态变更与幂等结果 | 两者在同一事务提交。故障注入验证提交前退出不留下部分结果，提交后用原请求重试返回首次成功结果 |
| 冻结装配升级 | 旧 manifest 与新增必需能力之间建立显式迁移 | 后继 run/分支保留旧证据，并能从新 manifest 再次恢复 |
| 剩余控制台运营 | 席位接管、剧情编辑、模型布局草稿与连通性探测、评估与导出页面 | 运营操作受角色、scope 与版本约束 |
| 认知管线 | Agent 运行时、记忆与模型路径 | 三核心角色端到端验证通过 |

**不要做的事：** 不要为了“先跑起来”恢复 20 人运行名册，或让五席开局重新对玩家开放；也不要用配置默认值掩盖缺失的配额与席位契约。
