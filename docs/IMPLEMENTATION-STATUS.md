# 实现状态与迁移清单

> 本页只记录**当前代码/内容**与 [00-scope-and-invariants.md](00-scope-and-invariants.md)、[game/rules.md](game/rules.md) 的差距。
> 它不是第二套规则：规格以设计为准，差距按本页逐项迁移。完成一项就把状态改为“已对齐”，不要另开一份“实现口径”文档。
> 核对时间：2026-11-20。核对范围：`modules/`、`packages/contracts/`、`config/`、`content/world-packs/earth-2964-v1/`。

## 1. 总览

| 项 | 规格 | 当前实现 | 状态 |
|---|---|---|---|
| 玩家身份 | 公社党魁，占 `seat.commune`，t144 投一票 | 玩家是 principal，无席位、无投票 | **未开始** |
| Agent 编制 | 15：8 支持者 + 4 AI 党魁 + 3 外域 | `standard-20`：8 战略 + 12 角色 | **进行中** |
| 时钟 | 20 秒/tick | `secondsPerTick` 默认 10 | **待改** |
| 资源 | 6 种；序章结算 3 种 | 契约只定义 `supply`/`energy`/`medical` | **符合序章，缺 t168 扩展** |
| 地图 | 序章 6 节点/9 路；设计 13/16 | 6 节点/9 路 | **已对齐序章** |
| 剧情卡 | 九张，t2–t144 | 九张，t2–t144 | **已对齐** |
| 三项仪表 | 中继 45、果园 50、迁徙 50；日结顺序 | 已实现 | **已对齐** |
| t144 程序案 | 五席各 1 票，3 票通过 | 无表决模块 | **未开始** |
| 序章终点 | t168 评估后切片结束 | t168 评估后进入自由模式 | **待改** |
| 表现 | 3D 目标；2.5D 灰盒 | PixiJS 2.5D 灰盒 | **符合灰盒，缺 3D** |
| 角色档案 | 15 个上场（含 6 名新公社支持者） | 12 个角色 + 8 个战略；缺 6 名公社支持者 | **进行中** |
| 世界初态 | 15 人、单席开局 | 20 人、五席开局 | **待改** |

## 2. 具体迁移项

### 2.1 身份与名册

1. 新增 6 名公社支持者档案（另有 28 名 B 级名册角色由 roster 字段驱动，不逐人落 YAML）：`npc-wenzhao`、`npc-taoan`、`npc-muzhi`、`npc-luchen`、`npc-ahe`、`npc-qilu`；字段按 [game/characters.md](game/characters.md) 第 2 节。
2. 新增 `config/rosters/standard-15.yaml`：4 名 AI 党魁 + 3 名外域 + 8 名公社支持者；把 `config/runs/online-default.yaml` 与服务端默认 `rosterRef` 从 `standard-20` 改为 `standard-15`。见 [content-pack](game/content-pack.md) 第 10 节。
3. 把 `human-neutral` 从“AI 战略 Agent”改为“玩家席位”：玩家占席时不创建该 AI 党魁；闻昭以 `npc-wenzhao` 上场。
4. 把 `npc-cenyan`、`npc-linwu`、`npc-tangzhen`、`npc-qiaoshu` 从运行名册移除；四名党魁只保留 `human-independent`、`human-earth-alliance`、`human-pacifist`、`human-alien-accord` 一套人格。旧档案若保留，只能作为内容库/回归数据，不能与党魁同时激活。
5. 把 `npc-zhuifeng`、`npc-qingzhi`、`npc-luo` 从运行名册移除；外域只保留 `species-*` 一套人格。

### 2.2 时钟与规则

6. `secondsPerTick` 默认从 10 改为 20；所有以“10 秒”写死的测试夹具同步。
7. t168 之后不再进入自由模式：提交 `ChapterStageEvaluated` 后停在切片终点；存档保留，等待后续开放世界接入。
8. 新增 t144 程序案：五席、3 票、`MotionDecided` 事件、议事录；`ChapterStageEvaluated` 增加程序案结果字段；不实现正式法案。

### 2.3 内容与配置

9. `world-init.yaml` 的 `dutyDelegations` 主体从 `npc-*` 改为 `human-independent` 等党魁 ID；见 [content-pack](game/content-pack.md) 第 6 节。
10. `starts.yaml` 只启用 `human-neutral`；其余四席标 `disabled`。
11. `scenarios/watergate-v1.yaml` 的 `speakerId` 允许 43 名册中未上场的署名（沈砾、苏回、谷寻），事件不实例化、不调用模型；若加载器把 `speakerId` 校验成 roster 成员，需放行 signature-only speaker。`wake-agents` 只唤醒 7 名党魁/外域，不唤醒 8 名支持者。同时把 4 张卡的署名从 `npc-qingzhi`、`npc-luo`、`npc-zhuifeng`、`npc-tangzhen` 改为 `species-flora`、`species-extraterrestrial`、`species-fauna`、`human-pacifist`，与 [content-pack](game/content-pack.md) 第 9 节一致。
12. `locale/zh-CN.yaml` 的 `playerName` 改为“党魁”；`resources` 增加 `materials`/`food`/`water` 词条（t168 用）。
13. 世界名与 system 模板已随内容版本 `1.1.0` 对齐；旧 run 恢复会因 `contentVersion` 不匹配被拒绝，需重新开局，不静默改语义。名册与其余内容迁移随下一个内容版本 `1.2.0` 进行。
14. `factions.yaml` 的 `homeNodeId` 拆成 `factionHomeNodeId` + `outpostNodeId`（人类）与 `territoryNodeId`（外域）；见 [content-pack](game/content-pack.md) 第 4 节。

### 2.4 表现与客户端

15. 保留 `client.scene-renderer.pixi` 作为灰盒；新增 3D 渲染器时实现同一个 `SceneRenderer` 端口，不改世界坐标与权限。
16. 灰盒验收只证明交互与可读性；3D 资产按 [design/assets/02-modeling-spec.md](design/assets/02-modeling-spec.md) 单独验收。

## 3. 迁移顺序

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| P0 | 名册 15、单席开局、20 秒/tick | `standard-15` 可启动；缺任一 profile 拒绝启动 |
| P1 | t144 表决、t168 切片终点 | 投票事件、议事录、评估事件各有测试 |
| P2 | 内容包 ID 与剧情卡署名统一 | `check:docs` 与内容校验通过；没有 `npc-` 与党魁双重身份 |
| P3 | 3D 渲染器（可选） | 同一 SceneView 在 3D 下可点选；不改变规则结果 |

**不要做的事：** 不要为了“先跑起来”保留 20 人运行名册再在文档里写 15 人；那会重新制造两套口径。要么用 `standard-15`，要么明确标为开发诊断 roster（`core-3`），不能作为交付证据。
