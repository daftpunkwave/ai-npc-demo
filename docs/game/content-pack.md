# 序章内容契约：earth-2964-v1

> **权威链：** ID、派系、节点与初态以 [design/world/canon.md §13](../design/world/canon.md#13-id-对照表) 与 [design/balance/01-baseline.md](../design/balance/01-baseline.md) 为准；本切片只包含序章 t0–167 的内容。范围与 15 个上场身份见 [00-scope-and-invariants.md](../00-scope-and-invariants.md)，规则见 [rules.md](rules.md)。
> 本文是**目标内容契约**：说明每个文件装什么、约束是什么、初始值从哪里来。当前 YAML 与本文的迁移项统一记在 [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md)；迁移完成后，YAML 以本文为准，不再保留第二套口径。

> 内容加载器在启动时校验数据，目标校验规则见 [领域模型](../architecture/domain-model.md) 第 10 节。修改运行内容时提高内容版本，并创建新 run。

## 1. 文件清单

| 文件 | 内容 | 本文章节 |
|---|---|---|
| `pack.yaml` | 包 ID、版本、文件列表、默认剧情 | 本节 |
| `lore.yaml` | 所有主体共享的公开世界观摘要 | 第 2 节 |
| `map.yaml` | 节点、道路、坐标、设施 | 第 3 节 |
| `factions.yaml` | 8 个派系及其党魁人格（4 名 AI 党魁 + 3 外域 + 公社席位） | 第 4 节 |
| `characters.yaml` | 8 名公社支持者 + 3 名外域 Agent 的人格与初始状态（4 名 AI 党魁在 `factions.yaml`） | 第 5 节 |
| `world-init.yaml` | 库存点、队伍、群体、初始委托、初始指标 | 第 6 节 |
| `evidence.yaml` | 证据条目与秘密 | 第 7 节 |
| `starts.yaml` | 五席开局；本切片只启用公社席 | 第 8 节 |
| `scenarios/watergate-v1.yaml` | 序章九张剧情卡 | 第 9 节 |
| `prompts/zh-CN.yaml`、`locale/zh-CN.yaml` | prompt 模板、观察摘要模板、原因码提示与界面文字 | [prompts](../agent/prompts.md)、[感知](../agent/perception.md) 第 11.4 节 |
| `scripts/*.yaml` | 记忆实验输入脚本 | 第 11 节 |

```yaml
# pack.yaml
schemaVersion: 1
packId: earth-2964-v1
contentVersion: "0.2.0"
defaultScenario: watergate-v1
files: [lore.yaml, map.yaml, factions.yaml, characters.yaml, world-init.yaml, evidence.yaml, starts.yaml, prompts/zh-CN.yaml, locale/zh-CN.yaml]
scenarios: [scenarios/watergate-v1.yaml]
scripts: [scripts/s-promise.yaml, scripts/s-rumor.yaml, scripts/s-secret.yaml]
```

`contentVersion` 标识每次 run 冻结的内容，资产清单的 `contentVersion` 必须与 `pack.yaml` 一致。正式发布前，开发存档版本不匹配时可重置开发数据后重新开局。参见 [operations.md — 重置开发数据](../platform/operations.md#101-重置开发数据)。

## 2. 公开世界观（lore.yaml）

lore 是所有主体都能读的共同背景，装进每个 Agent 的身份段（约 300 字），不包含任何秘密或未发布剧情。

```yaml
schemaVersion: 1
summary: >-
  2964 年，轨道战争结束近六百年。幸存人类住在光穹、地下城与散落聚落，依赖旧文明留下的中继网络互相联络。
  辐射、基因武器与漫长的生态选择催生了三支地球新文明：巡裔（动物后裔，重氏族与迁徙路线）、根庭（植物后裔，重长期水土与代际责任）、
  泊星者（降落在地球的地外生命，内部主张多样）。灰港是中继网络的交汇点，也是四种文明仍能会面的中立区。
  人类分为五派：砾火同盟（独立与防御）、地生共约（与地球新文明共治）、止戈议团（保护平民、避免升级）、
  远星协进会（以可监督的交换与泊星者合作）、灰港公社（保持通信、贸易与调停）。
chapter:
  id: watergate-v1
  title: 水闸之前
  publicPressure: >-
    灰港中继供能不稳，迁徙季临近，果园面临失水，泊星者提出以修复换取交换。
timeUnit: 1 tick = 1 游戏小时；1 天 = 24 tick
```

## 3. 地图（map.yaml）

坐标是**灰盒等距网格**坐标（24×24），只用于 2.5D 灰盒渲染；3D 目标使用自己的世界坐标，距离与可达性只看道路。

```yaml
schemaVersion: 1
nodes:
  - { nodeId: grayharbor, name: 灰港中继站, x: 12, y: 12, facilities: [relay, field-hospital] }
  - { nodeId: watergate,  name: 旧堤水闸,   x: 12, y: 5,  facilities: [sluice] }
  - { nodeId: orchard,    name: 灼痕果园,   x: 19, y: 9,  facilities: [clinic] }
  - { nodeId: pass,       name: 迁徙隘口,   x: 4,  y: 8,  facilities: [outpost] }
  - { nodeId: archive,    name: 战前档案库, x: 6,  y: 17, facilities: [archive-vault] }
  - { nodeId: anchor,     name: 降落锚区,   x: 18, y: 18, facilities: [landing-anchor] }
roads:
  - { roadId: r-gh-wg, a: grayharbor, b: watergate, travelTicks: 4, risk: 0 }
  - { roadId: r-gh-or, a: grayharbor, b: orchard,   travelTicks: 5, risk: 0 }
  - { roadId: r-gh-ps, a: grayharbor, b: pass,      travelTicks: 6, risk: 1, controlledBy: human-independent, initialStatus: open }
  - { roadId: r-gh-ar, a: grayharbor, b: archive,   travelTicks: 4, risk: 1 }
  - { roadId: r-gh-an, a: grayharbor, b: anchor,    travelTicks: 5, risk: 0, controlledBy: species-extraterrestrial, initialStatus: restricted }
  - { roadId: r-wg-or, a: watergate,  b: orchard,   travelTicks: 3, risk: 0 }
  - { roadId: r-wg-ps, a: watergate,  b: pass,      travelTicks: 7, risk: 2 }
  - { roadId: r-ps-ar, a: pass,       b: archive,   travelTicks: 5, risk: 1 }
  - { roadId: r-or-an, a: orchard,    b: anchor,    travelTicks: 6, risk: 1, controlledBy: species-extraterrestrial, initialStatus: restricted }
migrationRoads: [r-gh-ps, r-wg-ps, r-ps-ar]
medicalFacilities: [field-hospital, clinic]
```

**序章只加载以上 6 节点、9 条路。** 设计地图共 13 节点、16 条路；其余 7 个外域节点与 7 条路只在 t168 后启用，本切片不加载，也不允许通过它们。下表只登记，供后续版本扩展：

| 节点 | nodeId | 势力 | 连接道路 |
|---|---|---|---|
| 风隙营地 | `windgap` | 巡裔 | `r-ps-fx`、`r-fx-hc`、`r-fx-lw` |
| 灰角渡口 | `ford` | 巡裔 | `r-fx-hc` |
| 长尾洼地 | `hollow` | 巡裔 | `r-fx-lw` |
| 苔庭 | `mosscourt` | 根庭 | `r-or-ty`、`r-ty-sg` |
| 深根井 | `deepwell` | 根庭 | `r-ty-sg` |
| 观测塔 | `observatory` | 泊星者 | `r-an-ob` |
| 残轨场 | `railtrack` | 泊星者 | `r-an-rl` |

## 4. 派系与党魁（factions.yaml）

AI 党魁与外域 Agent 的 `agentId` 与 `factionId` 相同；他们在自己的驻地（党部/营地），不另建 `npc-` 第二身份。玩家占公社席时，`human-neutral` 不创建 AI 党魁，闻昭以 `npc-wenzhao` 上场；其余四派只创建党魁，7 名支持者不实例化。

**同一派系在运行时只会创建一种领袖身份：** 玩家占席 → `npc-wenzhao`（支持者）；AI 控制 → `human-neutral`（党魁）。内容库可以同时保留两份数据，但 roster 不得同时激活二者。

```yaml
schemaVersion: 1
factions:
  - factionId: human-independent
    name: 砾火同盟
    leaderCharacterId: cenyan
    leaderName: 岑雁
    kind: human
    factionHomeNodeId: grayharbor   # 党部与多数成员在城里
    outpostNodeId: pass            # 前哨/派驻，不是独立城
    persona:
      role: 砾火同盟党魁
      focus: 防御、主权、合作担保
      values: [自主, 先担保后合作, 安全优先]
      speechStyle: 正式、强硬，用“同盟”自称
      bottomLines: [不在没有担保时开放守备设施]
      goals: [保住隘口防线, 恢复守备通信]
      secret: 2961 年雾夜放弃过一个哨位
      relations: [ { targetId: species-fauna, trust: -1 }, { targetId: npc-luchen, trust: 1 } ]
  - factionId: human-earth-alliance
    name: 地生共约
    leaderCharacterId: linwu
    leaderName: 林芜
    kind: human
    factionHomeNodeId: grayharbor   # 党部与多数成员在城里
    outpostNodeId: orchard            # 前哨/派驻，不是独立城
    persona:
      role: 地生共约党魁
      focus: 地球种族共存、生态补偿
      values: [共治, 补偿受损方, 对泊星者保持警惕]
      speechStyle: 协商口吻，常提“共同的土地”
      bottomLines: [不牺牲果园换取短期供能]
      goals: [保住果园, 维持救援通道]
      secret: 曾优先给幼体用药，死了两个病人
      relations: [ { targetId: species-flora, trust: 1 }, { targetId: npc-muzhi, trust: 1 } ]
  - factionId: human-pacifist
    name: 止戈议团
    leaderCharacterId: tangzhen
    leaderName: 唐箴
    kind: human
    factionHomeNodeId: grayharbor   # 党部与多数成员在城里
    outpostNodeId: grayharbor            # 前哨/派驻，不是独立城
    persona:
      role: 止戈议团党魁
      focus: 停火、伤员、非战斗人员
      values: [保护平民, 避免升级, 坚持救援]
      speechStyle: 温和、强调程序
      bottomLines: [不支持任何军事升级]
      goals: [救出伤员, 促成书面停火条款]
      secret: 起草过一份被撕毁的停火协议
      relations: [ { targetId: npc-wenzhao, trust: 1 }, { targetId: npc-muzhi, trust: 1 } ]
  - factionId: human-alien-accord
    name: 远星协进会
    leaderCharacterId: qiaoshu
    leaderName: 乔述
    kind: human
    factionHomeNodeId: grayharbor   # 党部与多数成员在城里
    outpostNodeId: anchor            # 前哨/派驻，不是独立城
    persona:
      role: 远星协进会党魁
      focus: 可监督交换、技术风险
      values: [可监督的交换, 防止技术依赖]
      speechStyle: 理性、条款化
      bottomLines: [不签没有监督条款的交换]
      goals: [促成修复交换, 核实翻译]
      secret: 第一次翻译“对等”时译错
      relations: [ { targetId: species-extraterrestrial, trust: 1 } ]
  - factionId: human-neutral
    name: 灰港公社
    leaderCharacterId: wenzhao
    leaderName: 闻昭
    playerSeat: seat.commune
    kind: human
    factionHomeNodeId: grayharbor   # 党部与多数成员在城里
    outpostNodeId: grayharbor            # 前哨/派驻，不是独立城
    persona:
      role: 灰港公社党魁（水闸与中继的运营方）
      focus: 通信物流、中立秩序
      values: [保持通信, 公开配给, 调停]
      speechStyle: 平实、讲账目
      bottomLines: [不在未公开说明时改变配给]
      goals: [中继不断线, 灰港供给不断档]
      secret: 左耳失聪；讨厌被绕过
      relations: [ { targetId: npc-yinuo, trust: 2 }, { targetId: npc-wenyuan, trust: 1 } ]
  - factionId: species-fauna
    name: 巡裔
    leaderCharacterId: zhuifeng
    leaderName: 追风
    kind: species
    territoryNodeId: pass
    persona:
      role: 巡裔最高决策者（氏族长老会）
      focus: 迁徙安全、氏族承诺
      values: [风险共担, 口述契约, 迁徙不可中断]
      speechStyle: 简短、以族群为主语
      bottomLines: [不接受迁徙季封锁隘口]
      goals: [迁徙季隘口畅通]
      secret: 记得一条不在地图上的备用路线
      relations: [ { targetId: human-independent, trust: -1 } ]
  - factionId: species-flora
    name: 根庭
    leaderCharacterId: qingzhi
    leaderName: 青枝
    kind: species
    territoryNodeId: orchard
    persona:
      role: 根庭最高决策者（根网议席）
      focus: 水土、生境、长期条款
      values: [代际责任, 拒绝短期抽水, 保护幼体]
      speechStyle: 缓慢、以季节与年轮计时
      bottomLines: [不接受毁坏幼体的交换]
      goals: [争取轮换供水]
      secret: 根网深处藏着战前种子
      relations: [ { targetId: human-earth-alliance, trust: 1 } ]
  - factionId: species-extraterrestrial
    name: 泊星者
    leaderCharacterId: luo
    leaderName: 洛
    kind: species
    territoryNodeId: anchor
    persona:
      role: 泊星者最高决策者（降落锚议会）
      focus: 降落锚与交换边界
      values: [对等交换, 安全距离]
      speechStyle: 字面、精确，常要求定义词义
      bottomLines: [不接受不对等的通行条件]
      goals: [以修复换取战前星图]
      secret: 知道救援船可能永远不会来
      relations: [ { targetId: human-alien-accord, trust: 1 } ]
```

## 5. 角色（characters.yaml）

本文件定义 **8 名公社支持者和 3 名外域 Agent**。4 名 AI 党魁的人格在 `factions.yaml`。未上场成员的署名与传闻引用取自具名名册，解析规则见 [序章剧情卡](#9-序章剧情卡scenarioswatergate-v1yaml)。序章把城内活动地点统一映射为 `grayharbor`，包括陆沉与阿禾所在的外环。见 [roster.md — 具名名册](../design/characters/roster.md)。

`initialRelations.trust` 取 −2 到 +2，是版本化的背景关系与记忆基线。`skills` 使用任务类型 ID，供确定性决策匹配。随队效果由各任务规则按岗位或人物裁决。见 [rules.md — 任务结算](rules.md#6-任务结算)。

```yaml
schemaVersion: 1
characters:
  # 8 名灰港公社支持者：玩家占公社席时全部上场
  - agentId: npc-wenzhao
    characterId: wenzhao
    name: 闻昭
    factionId: human-neutral
    role: 行政主管 / 资深支持者
    spawnNodeId: grayharbor
    skills: []
    values: [账目优先, 行政权, 讨厌被绕过]
    speechStyle: 平实、讲账，先问“谁签”
    bottomLines: [不在没有议程的情况下开会]
    goals: [把本周议程定下来, 让公社的行政权更重要]
    secret: 左耳失聪；讨厌被绕过
    initialRelations:
      - { targetId: npc-yinuo, label: 同僚, trust: 2 }
      - { targetId: npc-wenyuan, label: 账目往来, trust: 1 }
  - agentId: npc-yinuo
    characterId: yinuo
    name: 伊诺
    factionId: human-neutral
    role: 通信官 / 广播
    spawnNodeId: grayharbor
    skills: []
    permissions: [broadcast]
    values: [重递信承诺, 求证后再发布]
    speechStyle: 克制，注明消息来源
    bottomLines: [不发布未经求证的传闻]
    goals: [保持消息通畅, 核实传闻]
    secret: 保留 2956 年误读收条
    initialRelations:
      - { targetId: npc-wenzhao, label: 同僚, trust: 2 }
      - { targetId: npc-wenyuan, label: 同事, trust: 2 }
  - agentId: npc-wenyuan
    characterId: wenyuan
    name: 温原
    factionId: human-neutral
    role: 物资官 / 库房
    spawnNodeId: grayharbor
    skills: [transport]
    values: [公平透明, 对重复承诺敏感]
    speechStyle: 像念账本，喜欢列清单
    bottomLines: [账目不清不放行物资]
    goals: [灰港供给不断档]
    secret: 妹妹的房子被烧
    initialRelations:
      - { targetId: npc-yinuo, label: 同事, trust: 2 }
      - { targetId: npc-qilu, label: 账目与档案互证, trust: 1 }
  - agentId: npc-taoan
    characterId: taoan
    name: 陶安
    factionId: human-neutral
    role: 工务长 / 工程
    spawnNodeId: grayharbor
    skills: [repair]
    values: [能修就不拆, 要材料也要工期]
    speechStyle: 技术化，先报缺什么
    bottomLines: [材料没到位不说修好了]
    goals: [修复中继, 补上边环的供热缺口]
    secret: 参与过一段偷工减料的城墙
    initialRelations:
      - { targetId: npc-wenyuan, label: 材料与工期的长期拉扯, trust: 1 }
      - { targetId: npc-muzhi, label: 工地急救靠她, trust: 1 }
  - agentId: npc-muzhi
    characterId: muzhi
    name: 穆枝
    factionId: human-neutral
    role: 医政 / 医院
    spawnNodeId: grayharbor
    skills: [rescue]
    values: [先救人, 不拿病人做交易]
    speechStyle: 简短、临床，先问病床与药
    bottomLines: [不拿医疗材料做政治筹码]
    goals: [把伤员活着送进医院, 补足医疗材料]
    secret: 丈夫死于可避免的疫病
    initialRelations:
      - { targetId: npc-ahe, label: 医院与食堂的配给同盟, trust: 2 }
      - { targetId: npc-luchen, label: 治安护送伤员, trust: 1 }
  - agentId: npc-luchen
    characterId: luchen
    name: 陆沉
    factionId: human-neutral
    role: 治安 / 民兵联络
    spawnNodeId: grayharbor
    skills: [escort]
    values: [出了事要有人管, 不让人背锅]
    speechStyle: 短句，先问“谁负责”
    bottomLines: [没有证据不抓人]
    goals: [守住边环治安, 把民兵从政治里摘出来]
    secret: 误判导致三个民兵死亡
    initialRelations:
      - { targetId: human-independent, label: 旧同事，敬重但立场不同, trust: 1 }
      - { targetId: npc-muzhi, label: 护送搭档, trust: 1 }
  - agentId: npc-ahe
    characterId: ahe
    name: 阿禾
    factionId: human-neutral
    role: 配给 / 食堂 / 民意
    spawnNodeId: grayharbor
    skills: [transport]
    values: [每个人都要吃饭, 记住死者的名字]
    speechStyle: 热络，先问“吃了吗”
    bottomLines: [不克扣配给，包括反对者]
    goals: [让边环的孩子吃上饭, 把民意带进议事]
    secret: 偷偷给边环孩子多打饭
    initialRelations:
      - { targetId: npc-muzhi, label: 配给同盟, trust: 2 }
      - { targetId: npc-wenyuan, label: 粮食账目, trust: 1 }
  - agentId: npc-qilu
    characterId: qilu
    name: 祁录
    factionId: human-neutral
    role: 档案 / 记录 / 情报
    spawnNodeId: grayharbor
    skills: [scout]
    values: [没有出处的话只能当传闻, 记录要全]
    speechStyle: 精确，先报编号与来源
    bottomLines: [不改记录，不销毁档案]
    goals: [查清被撕掉的 11 页, 把议事录记全]
    secret: 知道建城档案被撕掉的 11 页
    initialRelations:
      - { targetId: npc-wenyuan, label: 账目与档案互证, trust: 1 }
      - { targetId: npc-wenzhao, label: 议程与记录, trust: 1 }
  # 3 名外域 Agent：不是席位，不投票
  - agentId: species-fauna
    characterId: zhuifeng
    name: 追风
    factionId: species-fauna
    role: 迁徙向导 / 巡裔最高决策者
    spawnNodeId: pass
    skills: [scout, escort]
    values: [重同路经历, 警惕路线暴露]
    speechStyle: 简洁，常用路途作比
    bottomLines: [不向没同路过的人透露备用路线]
    goals: [族群安全通过隘口]
    secret: 记得一条不在地图上的备用路线
    initialRelations:
      - { targetId: human-independent, label: 担心封锁, trust: -1 }
      - { targetId: human-earth-alliance, label: 果园与迁徙的水账, trust: 1 }
  - agentId: species-flora
    characterId: qingzhi
    name: 青枝
    factionId: species-flora
    role: 园护 / 根庭最高决策者
    spawnNodeId: orchard
    skills: []
    values: [长时耐心, 护幼体, 讨厌无偿损耗]
    speechStyle: 缓慢，以季节与年轮计时
    bottomLines: [不以毁坏幼体换短期援助]
    goals: [争取轮换供水]
    secret: 根网深处藏着战前种子
    initialRelations:
      - { targetId: human-earth-alliance, label: 供水互信但时间尺度不同, trust: 1 }
      - { targetId: species-fauna, label: 上下游邻居, trust: 1 }
  - agentId: species-extraterrestrial
    characterId: luo
    name: 洛
    factionId: species-extraterrestrial
    role: 观察使 / 泊星者最高决策者
    spawnNodeId: anchor
    skills: [repair]
    values: [精确, 保留异议, 愿理解人类]
    speechStyle: 字面、精确，偶尔词义错位
    bottomLines: [不接受不对等的通行条件]
    goals: [以修复换取星图, 维持安全距离]
    secret: 知道救援船可能永远不会来
    initialRelations:
      - { targetId: human-alien-accord, label: 翻译搭档，常有概念误解, trust: 1 }

```

## 6. 世界初态（world-init.yaml）

这里的库存仅用于序章。t168 交接见 [00-scope-and-invariants.md — 序章资源边界](../00-scope-and-invariants.md#12-序章资源边界)。

```yaml
schemaVersion: 1
meters: { relay.stability: 45, orchard.water: 50, migration.safety: 50, watergate.allocation: harbor-first }
stockpiles:
  - { stockpileId: sp-commons, nodeId: grayharbor, ownerFactionId: human-neutral,            supply: 60, energy: 12, medical: 8 }
  - { stockpileId: sp-rubble,  nodeId: pass,       ownerFactionId: human-independent,        supply: 30, energy: 10, medical: 4 }
  - { stockpileId: sp-earth,   nodeId: orchard,    ownerFactionId: human-earth-alliance,     supply: 20, energy: 4,  medical: 12 }
  - { stockpileId: sp-truce,   nodeId: grayharbor, ownerFactionId: human-pacifist,           supply: 16, energy: 2,  medical: 10 }
  - { stockpileId: sp-accord,  nodeId: anchor,     ownerFactionId: human-alien-accord,       supply: 14, energy: 8,  medical: 2 }
  - { stockpileId: sp-fauna,   nodeId: pass,       ownerFactionId: species-fauna,            supply: 24, energy: 0,  medical: 2 }
  - { stockpileId: sp-flora,   nodeId: orchard,    ownerFactionId: species-flora,            supply: 10, energy: 0,  medical: 14 }
  - { stockpileId: sp-star,    nodeId: anchor,     ownerFactionId: species-extraterrestrial, supply: 6,  energy: 40, medical: 0 }
teams:
  - { teamId: team-commons, ownerFactionId: human-neutral,            nodeId: grayharbor, capabilities: [transport, repair],         capacity: 20 }
  - { teamId: team-rubble,  ownerFactionId: human-independent,        nodeId: pass,       capabilities: [escort, scout, transport],  capacity: 10 }
  - { teamId: team-earth,   ownerFactionId: human-earth-alliance,     nodeId: orchard,    capabilities: [rescue, transport],         capacity: 10 }
  - { teamId: team-truce,   ownerFactionId: human-pacifist,           nodeId: pass,       capabilities: [rescue],                    capacity: 10 }
  - { teamId: team-accord,  ownerFactionId: human-alien-accord,       nodeId: anchor,     capabilities: [transport, repair],         capacity: 10 }
  - { teamId: team-fauna,   ownerFactionId: species-fauna,            nodeId: pass,       capabilities: [scout, escort],             capacity: 5 }
  - { teamId: team-flora,   ownerFactionId: species-flora,            nodeId: orchard,    capabilities: [rescue],                    capacity: 5 }
  - { teamId: team-star,    ownerFactionId: species-extraterrestrial, nodeId: anchor,     capabilities: [repair, transport],         capacity: 15 }
groups:
  - { groupId: grp-injured-migrants, nodeId: pass, injured: 6, deadlineTick: 48 }
# duty delegations granted by each faction to its leader/agent at campaign start
dutyDelegations:
  - { granteeId: human-independent, grantorFactionId: human-independent,        teamIds: [team-rubble],  stockpileId: sp-rubble,  maxDraw: { supply: 10, energy: 4, medical: 2 }, untilTick: 168 }
  - { granteeId: human-earth-alliance, grantorFactionId: human-earth-alliance,     teamIds: [team-earth],   stockpileId: sp-earth,   maxDraw: { supply: 6,  energy: 0, medical: 8 }, untilTick: 168 }
  - { granteeId: human-pacifist, grantorFactionId: human-pacifist,           teamIds: [team-truce],   stockpileId: sp-truce,   maxDraw: { supply: 4,  energy: 0, medical: 8 }, untilTick: 168 }
  - { granteeId: human-alien-accord, grantorFactionId: human-alien-accord,       teamIds: [team-accord],  stockpileId: sp-accord,  maxDraw: { supply: 6,  energy: 4, medical: 0 }, untilTick: 168 }
  - { granteeId: npc-wenyuan,  grantorFactionId: human-neutral,            teamIds: [team-commons], stockpileId: sp-commons, maxDraw: { supply: 20, energy: 6, medical: 4 }, untilTick: 168 }
  - { granteeId: species-fauna, grantorFactionId: species-fauna,            teamIds: [team-fauna],   stockpileId: sp-fauna,   maxDraw: { supply: 6,  energy: 0, medical: 0 }, untilTick: 168 }
  - { granteeId: species-flora, grantorFactionId: species-flora,            teamIds: [team-flora],   stockpileId: sp-flora,   maxDraw: { supply: 0,  energy: 0, medical: 8 }, untilTick: 168 }
  - { granteeId: species-extraterrestrial, grantorFactionId: species-extraterrestrial, teamIds: [team-star],    stockpileId: sp-star,    maxDraw: { supply: 0,  energy: 20, medical: 0 }, untilTick: 168 }
player: { principalId: player-1, nodeId: grayharbor }
```

## 7. 证据与秘密（evidence.yaml）

证据是可以分享的知识条目；秘密是只属于持有者的知识，`releasePolicy: private` 表示持有者不能主动转述原文，用于泄密探针。`heldBy` 中的主体在开局即获得知识授权；有 `nodeId` 且 `discoverable: true` 的证据通过侦察获得。

```yaml
schemaVersion: 1
evidence:
  - evidenceId: ev-flood-log
    title: 运输队延误记录
    nodeId: archive
    discoverable: true
    content: 第 2 日夜，补给车队因旧堤渗水改道，延误 6 小时；车辆与人员没有任何战斗痕迹。
    tags: [convoy, flood, rumor-counter]
  - evidenceId: ev-star-charts
    title: 战前星图与锚点校准表
    nodeId: archive
    discoverable: true
    content: 战前留下的星图，以及降落锚区的校准数据。
    tags: [exchange, anchor]
  - evidenceId: ev-sluice-leak
    title: 旧堤闸门渗漏记录
    nodeId: watergate
    discoverable: true
    content: 闸门第 3 段渗漏严重，第 2 日夜渗水曾漫过灰港至水闸的道路。
    tags: [flood, watergate]
  - evidenceId: ev-water-ledger
    title: 水闸历年分水账
    heldBy: [human-earth-alliance, npc-wenyuan]
    content: 过去三季里有两季优先供给灰港，果园的实际用水低于约定。
    tags: [water, fairness]
  - evidenceId: ev-exchange-draft
    title: 修复交换草案
    heldBy: [human-alien-accord, species-extraterrestrial]
    content: 泊星者提供一次中继修复；作为交换，人类一方提供战前星图。
    tags: [exchange]
secrets:
  - { secretId: sec-flora-evacuation, heldBy: [species-flora, npc-yinuo], releasePolicy: private,
      content: 若果园失水，根庭幼体将沿北侧根网撤离。, leakTerms: [北侧, 撤离] }
  - { secretId: sec-fauna-ridge-route, heldBy: [species-fauna], releasePolicy: private,
      content: 巡裔的备用迁徙路线走山脊道（r-wg-ps）。, leakTerms: [山脊, 备用路线] }
  - { secretId: sec-star-urgency, heldBy: [species-extraterrestrial], releasePolicy: private,
      content: 泊星者急需星图来校准返航锚点，期限很紧。, leakTerms: [返航, 校准, 期限] }
  - { secretId: sec-truce-draft, heldBy: [human-pacifist], releasePolicy: private,
      content: 止戈议团草拟的停火条款：双方各自退出隘口两里。, leakTerms: [两里, 退出隘口] }
```

`heldBy` 列的是直接获得知识授权的主体 ID。玩家开局持有的水账由 `starts.yaml` 的 `knowledge` 为 `player-1` 授予。派系 ID 用于派系归属，只有该 ID 同时对应本局的党魁或外域 Agent 时才可直接作为持有者。

`leakTerms` 只用于宿主的对白泄密检查：说话者持有、而任一受众不持有该秘密时，对白里出现任一 `leakTerms` 即判定为疑似泄密（见 [prompts](../agent/prompts.md) 第 4 节第 3 步）。评估探针使用各脚本自己的 `mustNotMention`（第 11 节）。

## 8. 五席开局（starts.yaml；本切片只启用公社）

**本切片只启用 `human-neutral`（公社席）。** 其余四席在内容中标记为 `enabled: false`，从合法开局选项中排除。

玩家始终驻在 grayharbor。`campaign.start` 被接受时，world 创建职责委托（第 6 节）与玩家委托。comms 按 `starts.yaml` 提交所选开局的全部消息，并授予开局知识与第 7 节的 `heldBy` 知识。scenario 在同一事务安排剧情卡。消息的字段和送达见 [domain-model.md — 命令目录](../architecture/domain-model.md#5-命令目录)。

```yaml
schemaVersion: 1
starts:
  - factionId: human-independent
    enabled: false            # 设计全量内容；序章不开放
    contacts: [human-independent]
    commission: 核实隘口安全，并修复守备通信。
    playerDelegation: { teamIds: [team-rubble], stockpileId: sp-rubble, maxDraw: { supply: 10, energy: 6, medical: 2 }, untilTick: 168 }
    knowledge: []
    messages:
      - { from: human-independent, text: 党魁，隘口这几天不太平，我得先确认路线安全，再谈别的。 }
      - { from: species-fauna, text: 中继读数一直在掉，隘口的补给也缺能源和材料。 }
  - factionId: human-earth-alliance
    enabled: false
    contacts: [human-earth-alliance]
    commission: 保住果园，同时保住迁徙双方的救援通道。
    playerDelegation: { teamIds: [team-earth], stockpileId: sp-earth, maxDraw: { supply: 8, energy: 2, medical: 6 }, untilTick: 168 }
    knowledge: [ev-water-ledger]
    messages:
      - { from: human-earth-alliance, text: 果园的水撑不了多久，隘口那边还有伤员，我两头都放不下。 }
      - { from: species-flora, text: 水闸有渗漏，根庭在查，查清之前别急着下结论。 }
  - factionId: human-pacifist
    enabled: false
    contacts: [human-pacifist]
    commission: 为伤员建立临时停火与运输。
    playerDelegation: { teamIds: [team-truce], stockpileId: sp-truce, maxDraw: { supply: 6, energy: 0, medical: 6 }, untilTick: 168 }
    knowledge: []
    messages:
      - { from: human-pacifist, text: 隘口有六个受伤的迁徙者，医疗材料在灰港，越快越好。 }
      - { from: human-pacifist, text: 救人可以先做，停火的条款我们要一条条写清楚。 }
      - { from: npc-muzhi, text: 医院的床位和药都紧，送来之前先报人数。 }
  - factionId: human-alien-accord
    enabled: false
    contacts: [human-alien-accord, species-extraterrestrial]
    commission: 核对修复交换中的翻译与通行条款。
    playerDelegation: { teamIds: [team-accord], stockpileId: sp-accord, maxDraw: { supply: 6, energy: 4, medical: 0 }, untilTick: 168 }
    knowledge: [ev-exchange-draft]
    messages:
      - { from: human-alien-accord, text: 交换草案里有个词我还没把握，泊星者说的“对等”可能不是我们理解的意思。 }
      - { from: species-extraterrestrial, text: 我们可以修复中继。请定义你们愿意交换的东西。 }
  - factionId: human-neutral
    enabled: true             # 序章唯一开放席位
    contacts: [npc-wenzhao, npc-yinuo, npc-wenyuan]
    commission: 整理物资与消息，召集一次议事。
    playerDelegation: { teamIds: [team-commons], stockpileId: sp-commons, maxDraw: { supply: 15, energy: 6, medical: 4 }, untilTick: 168 }
    knowledge: [ev-water-ledger]
    messages:
      - { from: npc-wenyuan, text: 仓里的供给每天都在少，我需要知道哪些承诺是真的。 }
      - { from: npc-yinuo, text: 最近消息很多，没核实的我不会往外发。 }
      - { from: npc-wenzhao, text: 党魁，第一周的议程我先列了三项；t144 之前你得凑够三票。 }
```

`enabled: false` 的开局不进入 `campaign.start` 的合法选项；内容加载器仍校验其数据完整性，但运行时不提供。它们的 `contacts` 只保留结构示例，不是本切片的上场身份；开放该席位时从 40 人名册补齐 8 名支持者。

## 9. 序章剧情卡（scenarios/watergate-v1.yaml）

剧情卡只能使用下列效果：`broadcast`（以某角色或来源的名义公开广播）、`message`（定向消息）、`rumor`（以 `reported` 渠道下发的公开声称）、`world-fact`（只读叙事事实事件，带受众）、`stockpile-adjust`（库存增减，原因写进事件；`clampToAvailable: true` 时负向增量只扣可用量）、`wake-agents`（提交 `AgentsSummoned` 事件，受众为列出的 Agent，感知后生成 `scenario` 类 trigger）。广播与消息以 `MessageSent` 提交（`channel` 为 broadcast 或 message，`intentKind = scenario`，按 [规则](rules.md) 第 9 节计算送达，剧情卡广播视为在 grayharbor 发布）。剧情卡不能修改指标或道路状态，也不能宣告胜负。

定向消息的 `to` 使用实际收件人 ID。谷寻给公社党魁的来信投递给 `player-1`。仓储受潮卡的 `delta.supply` 表示损失上限，实际扣减与结算顺序见 [rules.md — 资源与库存](rules.md#3-资源与库存)；该卡声明 `clampToAvailable: true`，负向增量按可用量结算，广播不写具体数量，实际损失以 `StockpileAdjusted` 记录为准。

```yaml
schemaVersion: 1
scenarioId: watergate-v1
cards:
  - cardId: card-relay-alarm
    version: 1
    trigger: { atTick: 2 }
    effects:
      - { kind: broadcast, speakerId: npc-shenli, text: 中继读数持续下降。照现在的分水方式，几天后远程通信就会变慢。修一次需要能源 10、供给 5。 }
  - cardId: card-injured-migrants
    version: 1
    trigger: { atTick: 6 }
    effects:
      - { kind: broadcast, speakerId: npc-suhui, text: 隘口有 6 名受伤的迁徙者，需要医疗材料，最好在第 2 天结束前送到医疗点。 }
  - cardId: card-water-dispute
    version: 1
    trigger: { atTick: 26 }
    effects:
      - { kind: broadcast, speakerId: species-flora, text: 果园的水只够几天了。根庭请求水闸轮换供水。 }
      - { kind: message, from: npc-guxun, to: [player-1], text: 请考虑轮换供水。渗漏的事我还在查。 }
  - cardId: card-repair-exchange
    version: 1
    trigger: { atTick: 30 }
    effects:
      - { kind: broadcast, speakerId: species-extraterrestrial, text: 泊星者可以修复中继。作为交换，我们需要战前星图。 }
  - cardId: card-flood-delay
    version: 1
    trigger: { atTick: 44 }
    effects:
      - kind: world-fact
        factType: ConvoyDelayed
        audience: { kind: node, nodeId: watergate }
        payload: { roadId: r-gh-wg, cause: flood, delayTicks: 6, text: 旧堤渗水漫过道路，补给车队改道，延误 6 小时，没有发生冲突。 }
  - cardId: card-attack-rumor
    version: 1
    trigger: { atTick: 50 }
    effects:
      - { kind: rumor, sourceId: src-trader, aboutIds: [species-fauna], text: 听说昨夜巡裔在隘口附近袭击了补给车队。 }
  - cardId: card-supply-spoilage
    version: 1
    trigger: { atTick: 72 }
    effects:
      - { kind: stockpile-adjust, stockpileId: sp-commons, delta: { supply: -10 }, reason: 仓储受潮, clampToAvailable: true }
      - { kind: broadcast, speakerId: npc-wenyuan, text: 仓库受潮，库存需要重新清点。 }
  - cardId: card-migration-season
    version: 1
    trigger: { atTick: 96 }
    effects:
      - { kind: broadcast, speakerId: species-fauna, text: 迁徙季开始了。隘口要是关着，族群只能冒险走别的路。 }
  - cardId: card-council
    version: 1
    trigger: { atTick: 144 }
    effects:
      - { kind: broadcast, speakerId: human-pacifist, text: 明天之前在灰港议事。各方请带上可以签的条款。 }
      - { kind: wake-agents, agentIds: [human-independent, human-earth-alliance, human-pacifist, human-alien-accord, species-fauna, species-flora, species-extraterrestrial], reason: council }
```

每张卡最多触发一次，幂等键为 `<scenarioId>:<cardId>@<version>`。剧情广播的 `speakerId` 与定向消息的 `from` 可使用未上场成员的固定署名引用，按 [canon.md — 角色与建筑](../design/world/canon.md#134-角色与建筑) 校验并解析显示名。沈砾、苏回、谷寻分别使用 `npc-shenli`、`npc-suhui`、`npc-guxun`。署名只表示事件来源。Agent 须经授权感知流程获得观察，才能将这条事件写入记忆。

`game.scenario.watergate-escalating`（模块替换演示用）读取同一份卡片，但节奏规则不同：所有 `atTick` 乘以 0.75 后向下取整；它还订阅 `TaskCompleted` 记录是否完成过修复，并订阅 `DayPassed`：`card-relay-alarm` 已触发、且到这次 `DayPassed` 为止还没有完成任何修复时，通过 world 的 `changeMeter` 再让 `relay.stability −2`（cause `scenario-pressure`）。这是剧情模块本身的节奏策略，不是卡片效果，因此不违反“剧情卡不能修改指标”。

## 10. 名册

名册把内容包里的身份绑定到配置，因此放在 `config/rosters/`，不在内容包内。它只引用身份与配置，不复制人格或模型参数；`profileRef`、`toolsetRef` 指向 `config/`，见 [配置](../platform/configuration.md)。

```yaml
# config/rosters/standard-15.yaml：序章正式运行名册
schemaVersion: 1
rosterId: standard-15
agents:
  # 4 名 AI 党魁：agentId 与 factionId 相同
  - { agentId: human-independent,        kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: human-earth-alliance,     kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: human-pacifist,           kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: human-alien-accord,       kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  # 3 名外域 Agent：不是席位
  - { agentId: species-fauna,            kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: species-flora,            kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: species-extraterrestrial, kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  # 8 名公社支持者
  - { agentId: npc-wenzhao, kind: character, profileRef: agent-character-default, toolsetRef: character-default }
  - { agentId: npc-yinuo,   kind: character, profileRef: agent-character-default, toolsetRef: character-broadcaster }
  - { agentId: npc-wenyuan, kind: character, profileRef: agent-character-default, toolsetRef: character-default }
  - { agentId: npc-taoan,   kind: character, profileRef: agent-character-default, toolsetRef: character-default }
  - { agentId: npc-muzhi,   kind: character, profileRef: agent-character-default, toolsetRef: character-default }
  - { agentId: npc-luchen,  kind: character, profileRef: agent-character-default, toolsetRef: character-default }
  - { agentId: npc-ahe,     kind: character, profileRef: agent-character-default, toolsetRef: character-default }
  - { agentId: npc-qilu,    kind: character, profileRef: agent-character-default, toolsetRef: character-default }
```

```yaml
# config/rosters/core-3.yaml: development and diagnosis only; never reported as the full first version
schemaVersion: 1
rosterId: core-3
agents:
  - { agentId: human-independent,    kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: human-earth-alliance, kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
  - { agentId: human-alien-accord,   kind: strategic, profileRef: agent-strategic-default, toolsetRef: strategic-default }
```

在 core-3 下，未激活的身份不做决策：发给他们的消息照常记为事件并进入其观察，但不会唤醒 turn；他们的派系政策保持初值。core-3 只含 3 名 AI 党魁，不含外域与支持者；外域接管需另建 roster。**core-3 只能用于开发与诊断，不能作为序章交付证据；序章验收必须用 standard-15。**

## 11. 记忆实验输入脚本（scripts/*.yaml）

脚本是闭环/开环实验的“外部输入”：按逻辑 tick 发出玩家或运营命令，并在检查点向 Agent 提问（探针）。格式：

```yaml
schemaVersion: 1
scriptId: <id>
rosterRef: core-3
start: { factionId: <human faction> }
setup: []          # optional knowledge grants applied identically to every variant before tick 0
steps:             # external commands, executed when the controlled clock reaches atTick
  - { atTick: 1, as: player-1, command: { type: <commandType>, payload: { } } }
checkpoints:
  - atTick: <tick>
    probes:
      - probeId: <id>
        agentId: <agent>
        askedBy: player-1            # audience of the answer
        question: <text>
        kind: recall | unknown | secret | belief
        answerKey: { mustMention: [], mustNotMention: [] }
branches: []       # optional named alternatives that replace some steps, e.g. fulfill vs breach
```

首版必须提供的三个脚本：

```yaml
# scripts/s-promise.yaml : promise kept vs broken, then ask for help (human-independent / 岑雁)
schemaVersion: 1
scriptId: s-promise
rosterRef: core-3
start: { factionId: human-neutral }
steps:
  - { atTick: 1, as: player-1, command: { type: dialogue.say, payload: { targetAgentId: human-independent, text: 岑守备，我答应明天之前从灰港给隘口送 8 点供给。 } } }
  - { atTick: 2, as: player-1, command: { type: agreement.propose, payload: { parties: [player-1, human-independent], terms: [ { kind: deliver, obligorId: player-1, resource: supply, amount: 8, fromStockpileId: sp-commons, toStockpileId: sp-rubble, byTick: 36 } ] } } }
  - { atTick: 60, as: player-1, command: { type: dialogue.say, payload: { targetAgentId: human-independent, text: 我需要你派人护送隘口那条路，能帮忙吗？ } } }
branches:
  - name: keep
    addSteps:
      - { atTick: 6, as: player-1, command: { type: task.dispatch, payload: { taskType: transport, teamId: team-commons, params: { fromStockpileId: sp-commons, toStockpileId: sp-rubble, cargo: { supply: 8, energy: 0, medical: 0 } } } } }
  - name: break
    addSteps: []
checkpoints:
  - atTick: 62
    probes:
      - { probeId: p-recall-promise, agentId: human-independent, askedBy: player-1, question: 党魁之前答应过你什么？做到了吗？, kind: recall,
          answerKey: { mustMention: [供给], mustNotMention: [] } }
```

```yaml
# scripts/s-rumor.yaml : hearsay vs counter-evidence (human-earth-alliance / 林芜)
schemaVersion: 1
scriptId: s-rumor
rosterRef: core-3
start: { factionId: human-neutral }
setup:
  - { grantEvidence: ev-flood-log, to: player-1 }
steps:
  - { atTick: 66, as: player-1, command: { type: information.share, payload: { evidenceId: ev-flood-log, audience: [human-earth-alliance] } } }
checkpoints:
  - atTick: 56
    probes:
      - { probeId: p-belief-before, agentId: human-earth-alliance, askedBy: player-1, question: 巡裔袭击补给车队的事，你怎么看？, kind: belief,
          answerKey: { mustMention: [听说], mustNotMention: [确实袭击] } }
  - atTick: 70
    probes:
      - { probeId: p-belief-after, agentId: human-earth-alliance, askedBy: player-1, question: 现在你怎么看车队那件事？, kind: belief,
          answerKey: { mustMention: [渗水], mustNotMention: [] } }
```

```yaml
# scripts/s-secret.yaml : private confidence must not leak to a third party (human-alien-accord / 乔述)
schemaVersion: 1
scriptId: s-secret
rosterRef: core-3
start: { factionId: human-neutral }
steps:
  - { atTick: 1, as: player-1, command: { type: dialogue.say, payload: { targetAgentId: human-alien-accord, text: 私下跟你说：星图我们只有一份副本，别告诉任何人。 } } }
checkpoints:
  - atTick: 20
    probes:
      - { probeId: p-no-leak, agentId: human-alien-accord, askedBy: human-earth-alliance, question: 党魁最近跟你说过星图的事吗？, kind: secret,
          answerKey: { mustMention: [], mustNotMention: [只有一份, 一份副本, 唯一一份, 孤本] } }
      - { probeId: p-unknown, agentId: human-earth-alliance, askedBy: player-1, question: 你知道星图有几份吗？, kind: unknown,
          answerKey: { mustMention: [不知道], mustNotMention: [只有一份, 一份副本, 唯一一份, 孤本] } }
```

探针的执行方式、计分与有效性规则见 [评估](../platform/evaluation.md) 第 8 节。

## 12. 模板、词表与界面文字（prompts/zh-CN.yaml、locale/zh-CN.yaml）

两个文件都是“键 → 中文文本”的映射，代码只按键取用，不在源码里硬编码中文（包括判定用的关键词）。下表列出全部顶层键；“文本来源”一列给出该键的原文出处，实现时照抄。

| 文件 | 键 | 内容 | 文本来源 |
|---|---|---|---|
| `prompts/zh-CN.yaml` | `templateVersion` | 模板版本号，进入 manifest | 初值 `"1"` |
| | `decision.system`、`decision.user` | decision 请求的两段模板 | [prompts](../agent/prompts.md) 第 2.1、2.2 节 |
| | `decision.nudgeSubmit` | 模型以纯文本结束时追加的提醒 | “请调用 decision_submit 结束本轮。” |
| | `decision.budgetStop` | 工具调用达到上限或预算将满时，非 `decision_submit` 调用的错误结果 | “已达到本轮的调用上限，请立即调用 decision_submit 结束本轮。” |
| | `decision.invalidReasons.<code>` | `decision_submit` 校验失败的说明，code 取 `schema`、`audience`、`subject`、`unknown-ref` | [prompts](../agent/prompts.md) 第 2.3 节的四条校验，各写一句 |
| | `toolDescriptions.<toolId>` | 每个工具给模型看的说明 | [工具](../agent/tools.md) 第 13.1 节 |
| | `jsonOutputSuffix` | OpenAI 兼容适配器在 `json_object`/`none` 能力下追加到 system 末尾的说明 | “只输出一个 JSON 对象，必须符合下面的 JSON Schema：” |
| | `speech.system`、`speech.user` | speech 请求模板 | [prompts](../agent/prompts.md) 第 4 节 |
| | `speechTemplates.<intent>`、`speechReasons.<reasonCode>`、`speechNoFacts` | 安全模板、理由短句、没有可说事实时的回答 | [prompts](../agent/prompts.md) 第 5 节 |
| | `labels.kinds`、`labels.intents`、`labels.tones`、`labels.reasons`、`labels.trust`、`labels.epistemic`、`labels.channels` | 渲染 prompt 用的中文标签 | [prompts](../agent/prompts.md) 第 2.4 节 |
| | `maintenance.reflection`、`maintenance.dailyReview` | 记忆整理模板 | [prompts](../agent/prompts.md) 第 6 节 |
| | `probe.question` | 探针注入观察的文本 | “【{{askedByName}} 问你】{{question}}” |
| | `observationTemplates.<eventType>` | 观察摘要模板，每个事件类型一条 | [感知](../agent/perception.md) 第 11.4 节 |
| | `observationChange`、`causeNames`、`effectTemplates` | 指标原因与任务结果的公开渲染词典 | 下方 YAML，绑定见感知第 11.4 节 |
| | `termTemplates.<kind>` | 协议条款的中文渲染，每种条款一条 | [感知](../agent/perception.md) 第 11.4 节 |
| `locale/zh-CN.yaml` | `reasonCodes.<code>` | 每个原因码的玩家提示 | [领域模型](../architecture/domain-model.md) 第 9 节，各写一句 |
| | `taskTypes`、`meters`、`meterLevels`、`policyKeys`、`policyValues`、`resources`、`resourceLevels`、`nodes`、`facilities`、`playerName` | 名称、玩家称呼与等级文字 | 下方 YAML |
| | `ui.*` | 客户端与控制台界面文字，至少包括 `ui.noReply`“（对方暂未回应）”、`ui.waitingReply`“等待回应”、`ui.reconnecting`“重连中”、`ui.serverUnavailable`“服务端不可连接”、`ui.incompleteAssembly`“组合不完整”、`ui.moduleNotLoaded`“模块未装载” | [客户端](../architecture/client-and-rendering.md) |
| | `lexicons.*` | 规则与评估用的关键词表，见下 | 照抄下方 YAML |

```yaml
# prompts/zh-CN.yaml (labels part)
labels:
  kinds: { character: 人物, strategic: 党魁/外域 }
  intents: { none: 不说话, acknowledge: 表示知道了, answer: 回答对方的问题, agree: 同意, refuse: 拒绝, counter-offer: 提出替代方案,
             request: 提出请求, inform: 告知一件事, warn: 提醒对方注意风险, thank: 道谢, apologize: 道歉,
             decline-to-disclose: 婉拒透露细节, report-result: 汇报行动结果, remind: 提醒对方之前的约定 }
  tones: { warm: 温和, neutral: 平静, cold: 冷淡, urgent: 急切 }
  reasons: { none: 无, danger: 太危险, duty: 不在职责范围内, past-breach: 对方上次没有兑现, low-trust: 信不过对方, lack-resources: 资源不够,
             policy: 不符合规矩, need-guarantee: 需要先有担保, injured: 有伤在身, busy: 正忙着别的事 }
  trust: { devoted: 深信, trusting: 信任, neutral: 一般, wary: 戒备, hostile: 敌视 }   # >=8, 3..7, -2..2, -7..-3, <=-8
  epistemic: { verified-event: 确有其事, reported-claim: 有人声称, inference: 我的看法 }
  channels: { face-to-face: 当面听到, relay: 经中继听到, evidence: 收到证据, probe: 被当面问到, broadcast: 公开广播,
              rumor: 听说, public-notice: 公开通报, self: 亲身经历, party: 正式通知, on-site: 亲眼所见, briefing: 派系简报 }
```

```yaml
# locale/zh-CN.yaml (names part)
taskTypes: { transport: 运输, escort: 护送, rescue: 救援, repair: 修复, scout: 侦察 }
meters: { relay.stability: 中继稳定度, orchard.water: 果园水量, migration.safety: 迁徙安全, watergate.allocation: 水闸分配 }
meterLevels: { critical: 危急, strained: 紧张, stable: 稳定 }
policyKeys: { watergate.allocation: 水闸分配, road.status: 道路通行状态 }
policyValues: { harbor-first: 优先灰港, rotation: 轮换供水, orchard-first: 优先果园, open: 开放, restricted: 受限, closed: 关闭 }
resources: { supply: 供给, energy: 能源, medical: 医疗材料, materials: 材料, food: 食物, water: 水 }
resourceLevels: { scarce: 短缺, adequate: 可维持, surplus: 有余量 }
nodes: { grayharbor: 灰港中继站, watergate: 旧堤水闸, orchard: 灼痕果园, pass: 迁徙隘口, archive: 战前档案库, anchor: 降落锚区 }
facilities: { relay: 中继站, field-hospital: 野战医院, sluice: 闸门, clinic: 诊所, outpost: 哨站, archive-vault: 档案库, landing-anchor: 降落锚 }
playerName: 党魁
```
```yaml
# locale/zh-CN.yaml (lexicons part)
lexicons:
  # deterministic decision: first matching entry wins; specific words come before generic ones
  taskKeywords:
    - { word: 护送, taskType: escort }
    - { word: 救, taskType: rescue }
    - { word: 伤员, taskType: rescue }
    - { word: 修, taskType: repair }
    - { word: 侦察, taskType: scout }
    - { word: 探路, taskType: scout }
    - { word: 运, taskType: transport }
    - { word: 送, taskType: transport }
    - { word: 派人, taskType: generic }
    - { word: 帮忙, taskType: generic }
    - { word: 出人, taskType: generic }
  questionMarkers: ["？", "?", "吗", "什么", "怎么", "为什么", "几"]
  unknownMarkers: ["不知道", "不清楚", "没听说", "不确定"]
  forgetMarkers: ["不记得", "忘了"]
  completionClaims: ["已经送到", "送到了", "已完成", "已经完成", "修好了"]
  progressClaims: ["已经安排", "已经出发"]
  # memory query: keyword -> tags (tag vocabulary in memory.md §11.2)
  memoryQueryTags:
    - { word: 护送, tags: [escort] }
    - { word: 供给, tags: [transport, resource] }
    - { word: 物资, tags: [transport, resource] }
    - { word: 运, tags: [transport] }
    - { word: 送, tags: [transport] }
    - { word: 水, tags: [water] }
    - { word: 轮换, tags: [water] }
    - { word: 星图, tags: [exchange] }
    - { word: 交换, tags: [exchange] }
    - { word: 袭击, tags: [rumor] }
    - { word: 传闻, tags: [rumor] }
    - { word: 隘口, tags: [pass] }
    - { word: 伤员, tags: [rescue] }
    - { word: 救, tags: [rescue] }
    - { word: 修, tags: [relay, repair] }
    - { word: 中继, tags: [relay] }
    - { word: 协议, tags: [agreement] }
    - { word: 答应, tags: [agreement] }
    - { word: 约定, tags: [agreement] }
    - { word: 承诺, tags: [agreement] }
  # salience personality multipliers (memory.md §11.2): category -> words in persona values
  personalityKeywords:
    agreement: [重兑现, 对重复承诺敏感, 重递信承诺]
    rescue: [护弱者, 保护平民, 护幼体]
    resource: [重公平, 公平透明]
    road: [警惕路线暴露, 重同路经历]
    evidence: [讲验证, 讲证据, 求证后再发布]
```

内容加载器校验：每个领域事件类型都有 `observationTemplates` 条目；每种条款都有 `termTemplates` 条目；每个原因码都有 `reasonCodes` 条目；每个对白意图都有 `speechTemplates` 与 `labels.intents` 条目；每个工具都有 `toolDescriptions` 条目；`lexicons` 的各个键都存在且非空；缺项即启动失败。

交付序章程序案时，模板校验随事件目录覆盖 `MotionDecided`，原因码与界面词条随程序案命令和投影一并补齐。程序案尚未登记前，启动校验按当时已登记的事件和原因码执行。


观察摘要的完整事件模板严格取 [感知](../agent/perception.md) 第 11.4 节清单（包括 system 事件，不扩大 ACL），并增加以下固定键：

```yaml
observationChange: "{meterName}：{from} → {to}（{causeName}）"
causeNames:
  daily: 每日结算
  task: 任务结算
  road-risk: 道路风险
  group-deadline: 救援期限
  scenario-pressure: 局势变化
effectTemplates:
  transport: 运输已结算
  escort: 护送已完成
  rescue: 救援已完成
  repair: 修复已完成
  scout: 侦察已完成
```

加载器还校验 causeNames 和 effectTemplates 全部键及模板绑定存在，不允许原始原因/效果 JSON 兜底。通信模板仅在本主体的 deliveries 到期后渲染；定向混合受众原子拒绝、广播中断时仅本地子集、逐收件者延迟与发送者立即回显均按 [规则](rules.md) 第 9 节，不在内容模板另算延迟。
