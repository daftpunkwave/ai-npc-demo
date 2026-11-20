# 实现状态与迁移清单

> 本页记录代码与内容相对 [00-scope-and-invariants.md — 序章范围](00-scope-and-invariants.md)、[rules.md — 序章规则](game/rules.md) 的差距。完成迁移后更新这里的状态。实施顺序见 [build-plan.md — 步骤总览](delivery/build-plan.md#1-步骤总览)。
> 2026-11-20 核对基线为 `0654f50`（#35）；Demo 版本为 `0.1.0`，运行内容版本为 `0.1.1`。

## 1. 总览

服务端已能启动，并通过 HTTP/WS 跑世界规则、开局、授权读取与存档恢复。目录登记 15 个服务端模块，标准装配绑定其中 14 个。世界规则测试覆盖 t168 评估和剧情 provider 替换。控制台有鉴权后的精简健康接口。客户端、控制台页面与 Agent 认知管线仍待交付。参见 [apps/server/README.md — 服务端当前范围](../apps/server/README.md)、[world-only.test.ts — 序章规则场景](../tests/scenarios/world-only.test.ts)。

| 项 | 规格 | 当前实现 | 状态 |
|---|---|---|---|
| 玩家身份与开局 | 公社党魁，占 `seat.commune` | 以 `player-1` 登录，开局记录有玩家和派系，列表仍开放五席 | **待改** |
| 玩家权力 | 直接改水闸、以党魁身份签水闸条款、公开广播 | 玩家 `policy.set` 返回 403，水闸条款只接受 `human-neutral` 为义务人，玩家没有广播命令 | **待接入** |
| 席位契约 | 命令、事件、投影、存档可追溯席位与实际动作者 | 以 principal、派系和分支关联数据，公共契约及持久层未记录 `seatId` | **待补契约** |
| Agent 编制 | 15 个，即 8 名支持者、4 名 AI 党魁和 3 名外域 Agent | `standard-20` 有 8 个战略条目和 12 个角色条目，缺 6 名公社支持者 | **待迁移** |
| 运行配额 | 在线、实验及探针合计 15 个活动身份 | 名册 schema 每份最多 20 个。数据库有激活状态表，部署级配额尚未接入 | **待接入** |
| 时钟 | 20 秒/tick | 三份现有装配与时钟模块默认值均为 10 秒/tick | **待改** |
| 资源 | 序章结算 3 种库存，t168 交接 6 种城市资源 | 库存契约只定义 `supply`/`energy`/`medical` | **缺 t168 交接** |
| 地图 | 序章 6 节点、9 条路 | 6 节点、9 条路 | **已对齐序章** |
| 剧情卡 | 标准装配九张，t2–t144 | 数量与时点已对齐。部分署名与唤醒身份仍用旧编制，谷寻的私信目标仍为公社 AI 主体 | **部分实现** |
| 三项仪表 | 中继 45、果园 50、迁徙 50；日结顺序 | 已实现 | **已对齐** |
| t144 程序案 | 五席各 1 票，3 票通过 | 剧情卡发出议事邀请，目前没有表决状态、事件或议事录 | **目标** |
| 序章终点 | t168 评估后切片结束 | 已提交评估并标记 campaign 为 `evaluated`，时钟仍可推进 | **待改** |
| 表现 | 2.5D 序章灰盒，后续目标为 3D | 客户端和 PixiJS 灰盒待实现 | **目标** |

## 2. 具体迁移项

### 2.1 身份与名册

1. 新增 6 名公社支持者档案（另有 28 名 B 级名册角色由 roster 字段驱动，不逐人落 YAML）：`npc-wenzhao`、`npc-taoan`、`npc-muzhi`、`npc-luchen`、`npc-ahe`、`npc-qilu`；字段按 [game/characters.md](game/characters.md) 第 2 节。
2. 按 [content-pack.md — 名册](game/content-pack.md#10-名册) 新增 `config/rosters/standard-15.yaml`。同步 `.env.example`、`config/runs/online-default.yaml` 与服务端默认 `rosterRef`，把单份正式名册校验上限改为 15。S13 在激活事务中落实部署级共享配额，并验证分支切换、释放名额与第 16 个身份被拒绝。当前 `standard-20` 里的 `strategic-broadcaster` 是旧引用，首版名册只使用 [tools.md — 工具集](agent/tools.md#132-binding-模板与工具集) 的三个工具集。
3. 玩家以 `player-1` 占公社的 `seat.commune`，派系 ID 为 `human-neutral`。该席的 AI 党魁不实例化，闻昭以 `npc-wenzhao` 上场。
4. 把 `npc-cenyan`、`npc-linwu`、`npc-tangzhen`、`npc-qiaoshu` 从运行名册移除；四名党魁只保留 `human-independent`、`human-earth-alliance`、`human-pacifist`、`human-alien-accord` 一套人格。旧档案若保留，只能作为内容库/回归数据，不能与党魁同时激活。
5. 把 `npc-zhuifeng`、`npc-qingzhi`、`npc-luo` 从运行名册移除；外域只保留 `species-*` 一套人格。

### 2.2 时钟与规则

6. 时钟模块默认值与三份装配的 `secondsPerTick` 从 10 迁到 20，并同步依赖该值的测试。已冻结 run 的配置按恢复兼容规则处理。
7. t168 提交 `ChapterStageEvaluated` 后结束序章，停止时钟推进并保留存档。按 [00-scope-and-invariants.md — 序章资源边界](00-scope-and-invariants.md#12-序章资源边界) 验证资源交接。
8. 交付序章程序案需补齐提案与投票命令、`MotionDecided` 公共事件和感知模板、议事录、玩家投影及其词条。`ChapterStageEvaluated` 携带程序案结果。表决截止和缺席结案时点待定稿。验收覆盖表决门槛、授权投影与完整章节交接。参见 [domain-model.md — 命令目录](architecture/domain-model.md#5-命令目录)、[perception.md — 观察内容](agent/perception.md#114-观察内容)。

### 2.3 内容与配置

9. `world-init.yaml` 的 `dutyDelegations` 主体从 `npc-*` 改为 `human-independent` 等党魁 ID；见 [content-pack](game/content-pack.md) 第 6 节。
10. `starts.yaml` 只启用 `human-neutral`，其余四席用 `enabled: false`。加载器和开局命令须共同执行该限制。补上闻昭的 `npc-wenzhao` 接触入口及第三条开局消息。参见 [content-pack.md — 开局内容](game/content-pack.md#8-五席开局startsyaml本切片只启用公社)。
11. `scenarios/watergate-v1.yaml` 的 `speakerId` 允许 43 名册中未上场的署名（沈砾、苏回、谷寻），事件不实例化、不调用模型；若加载器把 `speakerId` 校验成 roster 成员，需放行 signature-only speaker。`wake-agents` 只唤醒 7 名党魁/外域，不唤醒 8 名支持者。同时把 4 张卡的署名从 `npc-qingzhi`、`npc-luo`、`npc-zhuifeng`、`npc-tangzhen` 改为 `species-flora`、`species-extraterrestrial`、`species-fauna`、`human-pacifist`，与 [content-pack](game/content-pack.md) 第 9 节一致。
12. `locale/zh-CN.yaml` 的 `playerName` 改为“党魁”；`resources` 增加 `materials`/`food`/`water` 词条（t168 用）。
13. 世界名与 system 模板已对齐。玩家的水账已由 `starts.knowledge` 授予，待移除 `evidence.yaml` 中指向公社 AI 主体的旧授权。谷寻定向来信改投 `player-1`。温原和阿禾的运输技能迁到 `transport`，评估脚本同步角色 ID 与探针词表。内容变更按包版本推进。参见 [content-pack.md — 序章内容契约](game/content-pack.md)。
14. `factions.yaml` 的 `homeNodeId` 拆成 `factionHomeNodeId` + `outpostNodeId`（人类）与 `territoryNodeId`（外域）；见 [content-pack](game/content-pack.md) 第 4 节。

**通信和受潮结算待对齐。** 当前通信代码给战略 Agent 按无位置处理，需要接入党魁的灰港开局位置与外域实际位置。受潮卡直接提交库存增减，扣减若会触及预留则拒绝该效果。目标为在事务内按可用量扣减，保留预留，并继续完成当天结算。参见 [rules.md — 序章结算规则](game/rules.md)。

### 2.4 表现与客户端

15. 实现 `client.scene-renderer.pixi` 作为灰盒，后续 3D 渲染器复用同一个 `SceneRenderer` 端口、世界坐标与权限契约。
16. 灰盒验收只证明交互与可读性；3D 资产按 [design/assets/02-modeling-spec.md](design/assets/02-modeling-spec.md) 单独验收。

### 2.5 公共契约迁移

17. 将公社党魁的水闸 `policy.set` 和条款义务人接入统一授权，按已开局的玩家和派系记录校验。玩家公开广播复用现有送达机制，命令名与正文限制待定稿。参见 [rules.md — 政策](game/rules.md#8-政策)、[api.md — 玩家命令权限](architecture/api.md#31-玩家命令权限)。
18. 补齐 `seatId` 与 `actorId` 的持久记录、会话授权、命令、事件、投影和存档回放。先定稿存储与接口字段，验证人类席位归属、外域与系统来源、多席表决和既有记录兼容读取。参见 [contracts.md — 契约演进](architecture/contracts.md#7-契约演进)。
19. 暂停与继续当前在时钟状态提交后单独写入 `operationId` 结果，进程在两次提交之间退出时重试可能出现版本冲突。需要补齐原子性并验证崩溃后的同键重试。参见 [operations.md — 时钟与运行状态](platform/operations.md#2-时钟与运行状态)。

## 3. 迁移顺序

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| S05 | `standard-15`、公社单席、开局消息、内容 ID 与剧情卡署名 | 正式名册可装载，同一人物只有一个运行身份 |
| S07–S09 | 20 秒/tick、t168 终点、公社玩家命令、席位契约与时钟操作幂等 | 评估后停止推进，玩家权限按当前席位裁决，恢复和回放保留席位归属 |
| S13 | 部署级 15 个活动身份的配额 | 达到配额后第 16 个身份激活被拒，释放后可重新激活 |
| S22–S23 | t144 表决、议事录与 t168 评估关联 | 表决、投影、章节结果及存档恢复均有验证 |
| 后续 | 3D 渲染器 | 同一 SceneView 在 3D 下可点选，规则结果一致 |

**不要做的事：** 不要为了“先跑起来”保留 20 人运行名册再在文档里写 15 人；那会重新制造两套口径。要么用 `standard-15`，要么明确标为开发诊断 roster（`core-3`），不能作为交付证据。
