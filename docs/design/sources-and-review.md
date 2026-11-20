# 基线、参考与验证

本稿把原来的七日单章扩展成开放世界经营 SLG。世界、人物、地点、道路与序章数值继续以 Demo 规格为依据；城建、议事、外交、谍报与世界导演是本稿新增的设计。两者冲突时，以本页「与 Demo 的差异」列出的口径为准，并在下一轮同步到 `docs/`。

## 作品名

游戏标题为 **《炉边议会》 / *The Hearth Council***。标题取自灰港的政治场景：五派围着中继炉取暖，也围着同一张桌子分票。旧稿标题「最后的中继」不再作游戏名，保留为对中继网络的旧称与世界观用语；序章仍名《水闸之前》。

英文名不是直译：*Hearth* 同时指炉边与家宅，*Council* 指议事会；两者并置，正好对应「取暖」与「投票」两件事。宣传语为「长冬之下，三票决定谁先暖。」 / “Three votes decide who warms first.”

## 参考作品

以下为公开资料与攻略的机制转述，不是原文引用；具体数值随版本与补丁变化，本稿只借用结构，不照搬数字。

| 作品 | 借用的结构 | 本稿怎么改 |
|---|---|---|
| 《冰汽时代》（Frostpunk, 11 bit studios） | 环形城市围绕核心炉；热区分级；法案册与道德取舍；希望/不满；探险队；寒潮 | 中继炉同时供热、供电与通信；热级改为 0–4 五档；希望/不满拆成「支持（五派）」与「不满」；探险队变成外域使节与队伍 |
| 《冰汽时代 2》 | 议事会、席位、派系、拉票、承诺、执行；区域经济与邻接；紧张与信任 | 100 席改为**五席（每派 1 票）**；普通法案 3/5，宪制法案 4/5；党魁是 Agent，玩家是本派党魁；法案通过后还有执行度 |
| 《城市：天际线》 | 看得见的城市、分区、服务覆盖、交通与人口 | 保留 24 地块、四环、热区、建筑服务覆盖；不做无限大地图与交通微操 |
| 《模拟人生》 | 每个人有自己的日程、关系、情绪与小心思 | 15 个 Agent 有工作、社交、记忆、底线；玩家不能直接操控他们的私生活 |
| 《十字军之王 3》 | 角色驱动；观点/把柄/密谋；议会席位与强力封臣；派系 ultimatum；联姻/宴会；继承 | 不设王朝与婚姻主线；把「封臣」换成「派系」；把「继承」换成政治生命与遗产局；保留把柄、宴请、私下交易 |
| 《绝地潜兵 2》 | 世界导演/Game Master；全局指令；时代目标；玩家行为反馈 | 单人长局版：导演面对一座城与三个外域 Agent；多人共治版仍只有一条压力预算。指令只改意图，不写结局；Agent 可以拒绝或变通 |

### Frostpunk 1

- 城市沿核心炉的环形网格建造；热量按环带衰减，建筑需要保温与热站；煤是核心燃料。参考：[Frostpunk Wiki: A New Home](http://frostpunk.wikia.com/wiki/A_New_Home)、[Handwiki: Frostpunk](https://handwiki.org/wiki/Software:Frostpunk)。
- 法案册（Book of Laws）用生存/目的两条线换取效率与道德代价；希望与不满是两个不同的失败轨道。本稿把它拆成「民意（五派支持率）」与「不满（城市压力）」，因为本作的政治主体是派系，不是统一的市民。
- 探险队（Beacon/Scout）负责发现幸存者、资源与蒸汽核心。本稿把它变成外域使节、商队、侦察与联合工程；外域不是资源点，是有议价的阵营。

### Frostpunk 2

- 议事会 100 席，普通法案 51 票，Rule 类法案约 67 票（2/3）；议员分 For / Against / Hesitant；派系是「真信徒」，社区可谈判；拉票靠承诺研究、建筑、法案、议程。参考：[Frostpunk 2 Wiki: Council](https://frostpunk-2.game-vault.net/wiki/Book_of_Laws)、[TheGamer: Council Guide](https://www.thegamer.com/frostpunk-2-council-laws-negotiate-complete-guide/)、[Frostpunk 2 Factions Guide](https://rappy-world.com/guide/frostpunk_2_factions_guide_managing_the_council_and_winning_votes)。
- 区域（Housing / Food / Extraction / Industrial / Logistics）与邻接加成/惩罚；热量按区域分配；劳动力是核心约束。参考：[Frostpunk 2 Wiki: District](https://frostpunk-2.game-vault.net/w/index.php?title=District&oldid=1419)、[Frostpunk 2 District Types](https://frostpunk2.wiki/districts/types)。
- 本稿把 100 席缩到 **5 席**：每派 1 票，普通法案 3 票、宪制法案 4 票。5 席让玩家一眼算清联盟，也让 15 个 Agent 的 roster 撑得住；3 票门槛强迫至少三派合作，4 票门槛保护少数派。派系的「基石」对应 Frostpunk 2 的不可谈判信条；「承诺」对应它的 negotiation terms。

### Crusader Kings 3

- 议会五席（外交、军事、财政、密谋、宗教），强力封臣期望席位；封臣观点低会加入派系、发 ultimatum；把柄（hook）可以强迫合作；密谋包括谋杀、伪造把柄、绑架。参考：[CK3 Vassal Management and Council](https://guildorder.com/games/ck3/wiki/vassal-management-and-council)、[CK3 Beginner's Guide](https://earlyguides.com/crusader-kings-iii/beginners-guide)。
- 本稿借用「角色有自己的利益与把柄」「议会席位是政治工具」「失败不是立刻结束」三件事；不借用王朝、婚姻、继承法、战争微操。继承改为「政治生命」：被吞并/支持崩解后换一个位置继续，而不是换一个王朝。
- CK3 的派系 ultimatum 对应本稿的外域最后通牒与吞并/支持崩解；「恐怖值」不借用，避免把政治简化成恐惧条。

### Helldivers 2

- 世界导演（Joel）监控全局战争，调整敌方压力、发布 Major Order、制造戏剧性；玩家行为会被回应，但不是每个任务都被手工编排。参考：[Position Is Everything: Joel the Game Master](https://www.positioniseverything.net/helldivers-2-celebrates-its-first-anniversary-by-revealing-joel-the-game-master)。
- 本稿的导演只对外域下指令，不直接命令人类派系；指令有预算、冷却、红线与日志；Agent 可以执行、变通、拖延或拒绝。这是单人长局版的「全局战役」，也是研究装置：可对比开/关导演、温和/高压指令的差异。多人共治时，导演由服务端运营持有，人类玩家不能接管导演席位——否则等于给一名玩家上帝视角。

## 与 Demo 规格的映射

原始规格位于本仓库。下表路径从仓库根目录起算。

| 主题 | Demo 规格 | 本稿入口 | 关系 |
|---|---|---|---|
| 范围、20 身份、五派开局 | `docs/00-scope-and-invariants.md` | [游戏概览](game-overview.md) | **改为 15 个上场 Agent**；五派从「五个开局」变为「同一城的五派」 |
| 世界、地点、文明 | `docs/game/background.md` | [背景](world/background.md)、[地图](world/grayharbor.md) | 扩写长冬、四阵营、外域、五印、白障 |
| 角色、关系、派系倾向 | `docs/game/characters.md`、`docs/game/content-pack.md` | [人物](characters/README.md)、[名册](characters/roster.md) | 40 人名册，每局实例化 15 人；新增支持者代表、态势、秘密 |
| 任务、路况、库存、政策、协议、序章结算 | `docs/game/rules.md` | [任务](gameplay/02-logistics-and-actions.md)、[协议](gameplay/03-agreements-and-policy.md)、[数值](balance/01-baseline.md) | 任务/路况/库存/政策/协议保留；时间、编制与资源边界按设计对齐 |
| 知情、判断、记忆、表达 | `docs/agent/perception.md`、`memory.md`、`runtime.md`、`tools.md` | [情报](gameplay/04-clues-and-npc.md)、[Agent 行动](gameplay/11-agent-actions.md)、[Agent 社会](gameplay/14-agent-society.md) | 新增会面痕迹、隐私、驱逐、支持态势 |
| 客户端、投影、可见字段 | `docs/architecture/client-and-rendering.md`、`domain-model.md` | [界面](gameplay/06-player-experience.md) | 由 2.5D 等距改为 3D 斜俯视；新增议事/支持/会面/损毁面板 |
| 剧情卡与验收 | `docs/game/content-pack.md`、`docs/delivery/roadmap-and-acceptance.md` | [序章](gameplay/05-chapter.md)、[长局](gameplay/07-progression-and-replay.md)、[战役弧](gameplay/16-campaign-arc.md) | 序章保留；t168 后进入开放世界；新增白障与结局 |
| 多人、资产 | 无对应（`00-scope` 不含联机；资产只有 2.5D 包） | [多人总纲](multiplayer/README.md)、[资产总纲](assets/README.md) | 两套新规格；多人 Demo 只留接口，资产 P0 只做 12 类建筑 / 15 人 |

## 与 Demo 的差异

| 项 | Demo 写法 | 本稿写法 | 影响 |
|---|---|---|---|
| 表现 | 2.5D 俯视等距 | 3D 斜俯视，Frostpunk 式镜头，可旋转/缩放 | 需要更新 `docs/00-scope-and-invariants.md`、客户端与渲染文档；资产从 2D 精灵改为 3D 模型/低模 |
| 章节 | 七日章节，t168 评估后自由模式 | 七日序章，t168 进入开放世界第一周 | 已在 Demo 文档改为“序章长度”；t168 评估后切片结束，设计上进入第 1 季第 2 周 |
| 城建 | 无 | 24 地块、建筑、供热、人力、疾病、损毁、修复 | 新增规则模块、内容包、API、UI；构建计划需加步骤 |
| 议事 | 无 | 五席、3 票普通/4 票宪制、法案、承诺、执行度 | 新增 `game.council` 能力；Agent 工具新增提案/表决/游说 |
| 支持/吞并 | 无 | 8 人五档态势、反对/博弈、挖角、驱逐、庇护、四阶段吞并 | 新增 `game.support` 能力；Agent 工具新增会面/询问/监视/搜查/驱逐；不做内部信任表决 |
| 袭击/修复 | 只有道路风险与中继维修 | 建筑三态、工人死亡、Agent 永久死亡、补位 | 新增 `game.damage` 能力与建筑状态 schema |
| 外交 | 协议与通行许可 | 四阵营关系、声誉、紧张、使节、条约、战争、谍报 | 新增 `game.diplomacy`；外域不再只是战略 Agent |
| 世界导演 | 无 | 战略指令、时代任务、压力预算、日志 | 控制台新增导演面板；研究评估新增对比轴；多人时导演仍只属服务端 |
| 玩家身份 | 派系特派员 | **本派党魁**（派系领导者，不是全人类领导者） | 新增党魁权限、8 人支持/博弈；不做内部争党魁；不再有“议员”身份 |
| 节点与道路 | 6 节点、9 条路（`grayharbor`/`watergate`/`orchard`/`pass`/`archive`/`anchor`） | 13 节点、16 条路；新增 7 个外域 `nodeId` | 扩 `map.yaml`；节点/道路 ID 以[速查表 §13](world/canon.md#13-id-对照表)为准 |
| 席位与派系 ID | 只有 `factionId`（`human-neutral` 等） | `seatId`（`seat.commune` 等）+ `factionId` + 资产 slug 三层 | 新命令带 `seatId`；`factionId` 不改，避免迁移存档；映射只维护在 canon §13 |
| Agent 编制 | 20（5 党魁 + 3 外域 + 12 角色） | **15**（本派 8 支持者 + 4 他派党魁 + 3 外域） | 需要新 roster preset 与内容包；不能直接复用 `standard-20.yaml` |
| 时间 | 10 秒/tick | **20 秒/tick**；对话自动暂停 | 客户端时钟、自动保存、Agent 调度需同步 |
| 人类派系驻地 | 五派各有 `homeNodeId`（隘口/果园/锚区/灰港） | 五派党部与多数成员都在灰港；隘口、果园、锚区是前哨与派驻 | Demo 内容契约已拆成 `factionHomeNodeId` + `outpostNodeId`（人类）与 `territoryNodeId`（外域）；实现迁移见 `IMPLEMENTATION-STATUS.md` |
| 多人 | 不做（单玩家，单世界） | 1–5 名人类席位 + AI 补齐；服务端权威；同步/异步会话 | Demo 不实现，但 `seatId`、投影、存档与命令网关需预留；`离线暂停` 只在单人成立 |
| 资产 | 2.5D 等距 + 场景卡/立绘 | 3D 斜俯视 + 模块化建筑套件 | 新建 `docs/design/assets/` 设计规格；根目录 `assets/` 现有 2.5D 资产的场景图与预览降级为 2D 关键帧/宣发素材 |
| 目标 | 三项指标过线 | 城市存续 + 派系民意支持 + 党魁政治生命 | 评估从“章末”变为“季末/白障/吞并” |

这些差异不是实现细节，而是范围变更。按项目规则，规范修订要同步相关契约；本稿先给出设计口径，下一轮再改 `docs/` 与构建计划。 [Q&A](Q&A.md)

## 边界情形

以下为设计处理口径，供后续规格对齐。序章部分沿用原稿口径；新增系统给出第一版规则。

| 边界 | 写法或缺口 | 本稿口径 |
|---|---|---|
| 修复何时计费 | 受理锁定、开工消耗、完成收益 | 受理时预留；开工时记消耗；未开工取消释放；开工取消不退 |
| 完成与失约时点 | 截止前 vs 截止 tick | 截止 tick 当时仍算有效；下一 tick 查违约 |
| 通行与连续政策 | 生效即履约，提前关路可能违约 | 即时效果计一次履约；到期前保持义务单独记录 |
| 库存损失与预留 | 日需/受潮/灾害 | 只扣未预留部分；显示实际损失与原因 |
| 往返同一路段 | 风险抽样 | 同一任务重复经过同一路共享一次抽样；延误按次加，伤情只记一次 |
| 同一运单多条款 | 累计交付 | 同一批货不能重复计入多笔独立义务；界面显示共享回执 |
| 任务结束位置 | 运输/救援/修复/侦察/护送 | 运输终点、救援医疗点、修复灰港、侦察目标、护送端点、施工地块、巡逻路段 |
| 表决平票 | 5 票，3 票普通/4 票宪制 | 3 票通过普通法案；4 票通过宪制；赞成票不足即为失败；弃权不降低门槛 |
| 支持崩解 | 8 名支持者 | 8 席中 ≥5 席离心/敌对/空缺，且无庇护 → 本派失去合法性，对手可吞并/政变；不做内部信任表决 |
| Agent 死亡 | 永久死亡 | 接任者使用自己的身份、记忆与关系，空缺期执行度 −30%。候选见 [roster.md — 开局名册与替补](characters/roster.md) |
| 执行度 | 法案通过即生效 | 执行度 30–90；实际效果按比例；低于 60 触发拖延事件 |
| 支持态势 | 五档 | 坚定/观望/动摇/离心/敌对；带理由与前兆；不显示精确分数 |
| 热级取整 | 中继 + 环带 + 热站 + 保温 − 寒潮 | 结果截断 0–4；小数向下取整；界面显示来源拆解 |
| 战争占领 | 不能灭国 | 每场战争最多占 1 个边境据点；首都不可占；停战可换俘/赔款/划界 |
| 导演拒绝 | 指令不是命令 | Agent 可执行/变通/拖延/拒绝；拒绝写入日志并可被研究对比 |

## 策划验收问题

| 从文档检查 | 应能得到的回答 |
|---|---|
| 玩家是否能感到「我是党魁，但不是全城的主人」 | 玩家决定本派 1 票；其他四派要谈；8 个支持者可以反对；政策不能直接改 |
| 3 票门槛是否真的制造联盟 | 任何一派都不够；必须再找两派；默认票数表能算出 2 票失败 |
| 4 票宪制门槛是否保护少数派 | 三派不能合法吞并第四派；吞并要说服非盟友 |
| 8 个人的支持是否真的影响游戏 | 同一法案由不同人执行结果不同；支持崩会触发吞并；8 人可反对/博弈但不争党魁 |
| 会面痕迹是否制造有趣的信息不对称 | 玩家知道谁见谁，但不知道内容；可以问/监视/搜查/驱逐 |
| 袭击是否有重量 | 建筑三态、具名死亡、Agent 永久死亡、修复取舍、政治追责 |
| 城建是否与政治连在一起 | 地块归属、公地许可、预算、劳力分配、执行度都能改变建造 |
| 外域是否像有主见的阵营 | 三方各有诉求/红线/战争方式；指令可被拒绝；关系/声誉/紧张三条账 |
| 世界导演是否在写剧本 | 只改意图与压力；结果由规则与 Agent 决定；日志可回放 |
| 序章是否还能玩 | 九张局势卡、六节点、九条路、五派开局、t168 评估都保留 |
| 3D 斜俯视是否影响可读性 | 热区、道路、人群、议事厅在同一镜头；拉远看全局，拉近看街区；UI 不遮关键读数 |
| 数值是否经过实测 | 本版为条文对照与纸面演算；平衡留给试玩与压测 |

## 参考清单

- Frostpunk Wiki, “A New Home”, http://frostpunk.wikia.com/wiki/A_New_Home
- Handwiki, “Software:Frostpunk”, https://handwiki.org/wiki/Software:Frostpunk
- Frostpunk 2 Wiki, “Council”, https://frostpunk-2.game-vault.net/wiki/Book_of_Laws
- Frostpunk 2 Wiki, “District”, https://frostpunk-2.game-vault.net/w/index.php?title=District&oldid=1419
- TheGamer, “How Do You Use The Council In Frostpunk 2?”, https://www.thegamer.com/frostpunk-2-council-laws-negotiate-complete-guide/
- Rappy World, “Frostpunk 2 Factions Guide”, https://rappy-world.com/guide/frostpunk_2_factions_guide_managing_the_council_and_winning_votes
- Frostpunk 2 District Types, https://frostpunk2.wiki/districts/types
- Guild Order, “CK3 Vassal Management and Council”, https://guildorder.com/games/ck3/wiki/vassal-management-and-council
- Early Guides, “Crusader Kings III Beginner's Guide”, https://earlyguides.com/crusader-kings-iii/beginners-guide
- Position Is Everything, “Helldivers 2 Celebrates Its First Anniversary By Revealing Joel The Game Master”, https://www.positioniseverything.net/helldivers-2-celebrates-its-first-anniversary-by-revealing-joel-the-game-master

以上为机制参考，不构成对原作数值的复制。所有具体数值以[数值基线](balance/01-baseline.md)为准。
