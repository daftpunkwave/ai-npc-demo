# 序章切片规格：世界、玩法与规则

> **定位：** 本目录是《炉边议会》序章《水闸之前》的 **Demo 实现规格**，不是第二套游戏设计。设计支持五个人类席位；本切片只开放公社席，其余四席由 AI 党魁运行。
> 游戏是什么、数值目标是多少，以 [design/README.md](../design/README.md) 为唯一权威；本目录只回答“这七天的切片怎么结算、内容怎么装”。
> 范围、15 个上场身份与资源边界见 [00-scope-and-invariants.md](../00-scope-and-invariants.md)；实现进度见 [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md)。

[返回文档入口](../README.md) · [项目概览](../../README.md)

## 文档索引

| 文档 | 负责内容 |
|---|---|
| [background.md — 世界背景（序章摘要）](background.md) | 灰港、五派与三外域；完整版见 [design/world/](../design/world/background.md) |
| [gameplay.md — 玩家循环（党魁视角）](gameplay.md) | 序章七日、九张卡、三条路线、t144 表决；设计依据 [design/gameplay/05-chapter.md](../design/gameplay/05-chapter.md) |
| [characters.md — 15 个上场身份](characters.md) | 8 支持者 + 4 AI 党魁 + 3 外域；完整 43 人名册见 [design/characters/roster.md](../design/characters/roster.md) |
| [systems.md — 职能边界](systems.md) | 游戏模块的职责划分与可替换边界 |
| [rules.md — 序章结算规则](rules.md) | 时间、地图、资源、任务、协议、通信、证据、t144 表决、t168 评估 |
| [content-pack.md — 序章内容契约](content-pack.md) | 初态、地图、15 人、九张卡、开局、roster 与脚本；ID 以 [design/world/canon.md §13](../design/world/canon.md#13-id-对照表) 为准 |

## 阅读顺序

**先读设计（理解为什么）：** [design/game-overview.md](../design/game-overview.md) → [design/world/canon.md](../design/world/canon.md) → [design/gameplay/01-cycle-and-opening.md](../design/gameplay/01-cycle-and-opening.md) → [design/gameplay/05-chapter.md](../design/gameplay/05-chapter.md)。

**再读切片（理解怎么做）：** [background.md](background.md) → [gameplay.md](gameplay.md) → [characters.md](characters.md) → [systems.md](systems.md) → [rules.md](rules.md) → [content-pack.md](content-pack.md)。规则以 [rules.md](rules.md) 为准，初始数据以 [content-pack.md](content-pack.md) 为准。

## 与其他目录的边界

| 问题 | 去哪 |
|---|---|
| 城建、法案、支持/吞并、袭击、四季、多人怎么设计 | [design/gameplay/](../design/gameplay/01-cycle-and-opening.md)、[design/multiplayer/](../design/multiplayer/README.md) |
| 命令和事件字段 | [architecture/domain-model.md](../architecture/domain-model.md) |
| NPC 如何理解经历 | [agent/README.md](../agent/README.md) |
| 当前代码还差什么 | [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md) |

**一条硬规则：** 本目录不定义城建、正式法案、支持态势、袭击、四季与多人联机的简化规则。序章不实现的系统只写“入口与接口”，完整规则回到 `design/`。
