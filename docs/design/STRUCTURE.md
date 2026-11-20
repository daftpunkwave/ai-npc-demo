# 设计目录结构与维护规则

> **一句话：`docs/design/` 是本仓库唯一的设计权威，自包含，不设外部镜像。`docs/game/` 只描述序章《水闸之前》的实现切片，不另立规则。**
> 本仓库文档不引用仓库外的设计稿或资产包：所有设计依据、数值与 ID 都能在仓库内查到。

## 1. 三层结构

| 层 | 位置 | 回答什么 | 冲突时 |
|---|---|---|---|
| 目标设计 | `docs/design/**` | 这个游戏是什么：世界、玩法、数值、派系、角色、多人、资产 | **最高** |
| 切片范围 | `docs/00-scope-and-invariants.md` | Demo 做哪一段、15 个上场身份、6 种资源边界、哪些不做 | 服从设计 |
| 工程实现 | `docs/architecture/**`、`docs/agent/**`、`docs/platform/**`、`docs/delivery/**` | 宿主、模块、Agent 运行时、观测、验收怎么搭 | 服从前两层 |

`docs/game/**` 属于第二层的展开：它只写序章可结算规则与内容契约，不定义城建、正式法案、支持/吞并、袭击、四季与多人联机的简化版。这些系统在序章只保留入口与接口。

## 2. 目录映射

| 序章文档 | 设计依据 | 关系 |
|---|---|---|
| `docs/game/background.md` | `design/world/background.md`、`grayharbor.md`、`frontier.md`、`societies.md`、`story.md` | 摘要；不新增设定 |
| `docs/game/characters.md` | `design/characters/roster.md`、`README.md` | 15 个上场身份；43 具名身份的切片 |
| `docs/game/gameplay.md` | `design/gameplay/01-cycle-and-opening.md`、`05-chapter.md`、`06-player-experience.md` | 党魁视角的序章七日 |
| `docs/game/rules.md` | `design/balance/01-baseline.md`、`gameplay/02`–`09` | 序章可结算规则；设计值以 balance 为准 |
| `docs/game/content-pack.md` | `design/world/canon.md` §13、`balance/01` | 内容契约；ID 以 canon §13 为准 |
| `docs/game/systems.md` | `design/gameplay/11-agent-actions.md`、`14-agent-society.md` | 模块边界；设计意图以 design 为准 |
| `docs/game/art-direction.md` | `design/assets/README.md`、`01`–`03` | 3D 目标 + 2.5D 灰盒 + 2D 宣发三层 |
| `docs/00-scope-and-invariants.md` | `design/multiplayer/README.md`、`game-overview.md` | 切片范围、15 人、6 资源边界 |
| `docs/IMPLEMENTATION-STATUS.md` | 无（工程状态） | 当前代码与规格的差距；迁移清单 |

## 3. 序章不实现的系统

| 系统 | 设计位置 | 序章处理 |
|---|---|---|
| 城建与地块 | `design/gameplay/08-city-building.md` | 不实现；只保留中继附属/热站的维修入口 |
| 正式法案与议程 | `design/gameplay/09-council-and-laws.md` | 只实现 t144 一项程序案（3 票） |
| 世界导演 | [12-world-director.md — 世界导演](gameplay/12-world-director.md) | 序章由剧情卡投放局势压力。战略指令、时代任务与导演面板留给开放世界 |
| 支持态势与吞并 | `design/gameplay/13-support-and-annexation.md` | 不实现；8 人态势只作对话与执行系数 |
| 袭击与损毁修复 | `design/gameplay/15-raids-and-repair.md` | 不实现 |
| 四季与寒潮 | `design/gameplay/16-campaign-arc.md` | 只到 t168 评估；t168 之后不在切片内 |
| 多人联机 | `design/multiplayer/**` | 不实现；命令/投影/存档带 `seatId` |
| 完整资产管线 | `design/assets/**` | P0 灰盒；3D 目标不在切片验收内 |

**“不实现”不是“另一套简化规则”。** 序章文档不能写“城建简化成 XX”“支持简化成 YY”；只能写“未开放 + 接口在哪里”。

## 4. 怎么读

| 目标 | 读法 |
|---|---|
| 理解完整游戏 | [README.md](README.md) → [game-overview.md](game-overview.md) → [canon.md](world/canon.md) → [core loop](gameplay/01-cycle-and-opening.md) |
| 理解序章切片 | [00-scope](../00-scope-and-invariants.md) → [game/README.md](../game/README.md) → [game/gameplay.md](../game/gameplay.md) → [game/rules.md](../game/rules.md) |
| 做实现 | [build-plan](../delivery/build-plan.md) → [rules](../game/rules.md) → [content-pack](../game/content-pack.md) → [domain-model](../architecture/domain-model.md) |
| 做多人 | [multiplayer/README.md](multiplayer/README.md) → [seats](multiplayer/01-seats-and-clock.md) → [authority](multiplayer/02-authority-economy-fairness.md) |
| 排资产 | [assets/README.md](assets/README.md) → [inventory](assets/01-inventory.md) → [modeling spec](assets/02-modeling-spec.md) |
| 查实现差距 | [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md) |

## 5. 维护规则

1. **设计改动只改 `docs/design/`。** 它是仓库内唯一的设计权威，不存在需要同步的外部源目录。
2. **切片范围的改动只改 `00-scope-and-invariants.md`。** 其他文档引用它，不复制范围定义。
3. **序章规则数值（阈值、日耗、门槛、加成）只写在 `docs/game/rules.md`；初始库存、初值与内容数据写在 `docs/game/content-pack.md`。** 设计目标值只写在 `docs/design/balance/`；两边不重复定义同一组数字。
4. **ID 只有一个来源：`design/world/canon.md` §13。** `seatId` / `factionId` / 资产 slug / `characterId` 的映射只维护在那里。
5. **设计与切片冲突时以 `design/` 为准**；实现差距只记在 `IMPLEMENTATION-STATUS.md`，不另开“实现口径”。
6. **每次改完跑 `pnpm check:docs`。** 检查范围见 [README.md — 文档维护约定](../README.md#5-文档维护约定)。
