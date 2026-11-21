# 序章结算规则与数值

> **权威链：** 目标规则与数值见 [design/balance/01-baseline.md](../design/balance/01-baseline.md)、[design/gameplay/05-chapter.md](../design/gameplay/05-chapter.md)；本文只定义序章《水闸之前》t0–167 的可结算实现。冲突时以设计为准；本文与 [00-scope-and-invariants.md](../00-scope-and-invariants.md) 冲突时以范围文档为准。
> 序章不实现城建、正式法案、支持/吞并、袭击与四季；本文不写它们的简化规则。

> 本文定义序章目标规则，第 12 节给出行为断言。代码与内容的差距见 [IMPLEMENTATION-STATUS.md — 实现状态与迁移清单](../IMPLEMENTATION-STATUS.md)。数值为序章初始配置，修改数值需要新 run。具体 ID 与初始数据见 [内容包](content-pack.md)，命令与事件的 payload 见 [领域模型](../architecture/domain-model.md)，模块边界见 [游戏职能模块](systems.md)。
>
> **术语：** 下文为兼容既有命令/事件字段，仍用“战略 Agent”指 faction 级主体；它在设计里的显示身份是“党魁”（人类）或“最高决策者”（外域），不是另一类人。
> **身份口径：** 本序章每局 15 个身份——8 名公社支持者（`npc-<拼音>`）、4 名 AI 党魁（`agentId = factionId`）、3 名外域 Agent（`agentId = species-*`）。规则里提到“岑雁”“追风”时，指的是对应 agentId 的显示名，不另建 `npc-cenyan` 之类的第二身份。

## 1. 时间

| 项 | 规则 |
|---|---|
| 单位 | 1 tick = 1 游戏小时；`day = floor(worldTick / 24) + 1`，`hour = worldTick % 24` |
| 起点 | `campaign.start` 被接受时 `worldTick = 0` |
| 序章长度 | 7 天，tick 0–167；tick 168 先结算到期任务与第七笔日结，再做**序章评估**（第 10 节），随后切片结束。设计上 t168 进入第 1 季第 2 周，开放世界不在本切片内 |
| running | 每 `secondsPerTick` 真实秒推进 1 tick（默认 **20 秒**，1 游戏日 = 8 分钟，序章七日约 56 分钟） |
| paused | 不推进；除 `campaign.start` 与 active sandbox 内 `system:world` 的 `probe.ask` 外，改变世界的命令一律返回 `paused`；不豁免其他 sandbox 命令 |
| stepping | 从 paused 发起，推进 N tick（1–24），并等本步触发的规则任务与 Agent turn 全部结算后回到 paused |
| 离线 | live run 中，玩家的全部 WebSocket 连接断开超过 60 秒且时钟为 running 时自动暂停；不补算离线时间 |

时钟从 paused 变为 running 只有两种方式：玩家或运营调用“继续”接口，或在 live run 中开局后由客户端自动调用一次“继续”（见 [客户端](../architecture/client-and-rendering.md) 第 8.5 节）。

推进到 tick T 时的固定处理顺序（每一项各自一个事务，按顺序提交）：

1. 写入时钟行 `worldTick = T`（不产生领域事件）。
2. 按 `(dueTick, seq)` 升序执行所有 `dueTick ≤ T` 的 job，`seq` 是 job 在分支内的创建序号：任务出发/到达/完工、伤员期限、协议期限、剧情卡触发、延迟观察投递。
3. 若 `T > 0` 且 `T % 24 == 0`：由时钟 worker 直接调用 world 模块的每日结算（第 4 节），提交 `DayPassed`。
4. 若 `T == 168`：由时钟 worker 直接调用 world 模块的**序章评估**（第 10 节），提交 `ChapterStageEvaluated`；这是本切片的最后一个时钟步骤，不进入开放世界。

5. stepping 模式中，按脚本声明顺序注入 tick T 的脚本命令；脚本冒充玩家/席位时仍走对应正常认证、权限、版本与命令网关校验，不授予 system 权限或暂停豁免。
6. stepping 在本 tick 等待收敛后才推进下一 tick：所有 dueTick ≤ T 的规则/投递 job 已结算、事件消费者追平最新 worldSeq、观察与记忆消费者追平其输入、无进行中的 turn，且无当前可调度 trigger。消费者或 turn 新产生事件/job/trigger 时重新检查。仅 cooldownUntilTick > T 的未来 trigger 不阻塞；失败或积压必须显式报错，不能视为收敛。N tick 全部完成后才恢复 paused。

第 3、4 步是固定的时钟步骤，不是 job，因此不会因排序而乱序，也不会执行两次。

## 2. 地图与通行

- **序章加载近城 6 节点、9 条路**（灰港、水闸、果园、隘口、档案库、锚区）；设计中的外域 7 节点、7 条路只在 t168 后启用，本切片不加载，也不允许通过它们。完整 13 节点/16 路见 [design/world/grayharbor.md](../design/world/grayharbor.md)。
- 节点、道路、坐标与控制方见 [内容包](content-pack.md) 第 3 节。道路是无向的。
- 道路状态：`open`、`restricted`、`closed`。不受控道路恒为 `open`。受控道路状态由第 8 节规定的控制方用 `policy.set` 修改。
- 一项任务能否使用某条道路：
  - `open`：可以通行。
  - `restricted`：只有在任务所属派系（队伍拥有方）就是控制方，或该派系持有该道路的有效通行许可（`PassageGrant`，`untilTick ≥` 出发 tick）时才能通行。
  - `closed`：一律不能通行，有通行许可也不行。
- 路径：在可用道路上用 Dijkstra 按 `travelTicks` 求最短路；同长时选道路数少者，再按道路 ID 序列的字典序。找不到路径就拒绝命令，原因码 `route-unavailable`。
- 行程按路径累加各道路的 `travelTicks`。运输任务携带非空 `cargo` 时每条道路再加 1。救援的医疗预留和修复的材料预留均按基础行程计算。道路状态只在出发时检查，途中的变化不影响已出发的任务。
- 风险：道路 `risk ∈ {0,1,2}`。出发时对路径上每条 `risk > 0` 且未被护送（第 6 节 escort）的道路依次抽样（随机源见第 11 节）：
  - 延误：概率 `0.15 × risk`，每条命中道路贡献 2 tick，累计延误 = `2 × 命中延误的道路数量`；
  - 受伤：概率 `0.05 × risk`；有参与角色时，从按 agentId 排序的参与者中用同一随机源取一人，受伤 48 tick；没有参与角色时，队伍在任务结束后休整 24 tick。
- 抽样结果只写进任务的内部状态。`TaskDeparted` 与玩家投影只给出不含延误的**名义**到达/完成 tick；到了名义完成 tick 如果存在延误，仅在 `delayNoticeSent = false` 时提交一次 `TaskDelayed`（新的完成 tick = 名义完成 tick + 累计延误），同事务设置 `delayNoticeSent = true`，到真正完成时才结算；受伤在任务完成时以 `CharacterInjured` 公布。

## 3. 资源与库存

- 设计共 **6 种资源**；序章只结算其中 3 种库存：`supply`（供给）、`energy`（能源）、`medical`（医疗材料）。情报不是资源。

- 三种库存的用途及其余三种资源的处理见 [00-scope-and-invariants.md — 序章资源边界](../00-scope-and-invariants.md#12-序章资源边界)。
- 库存点 `Stockpile` 归属一个派系、位于一个节点，保存 `amount` 与 `reserved`，均为非负整数，且 `reserved ≤ amount`；可用量 = `amount − reserved`。
- 接受任务时原子预留，到达或完工时从 `amount` 与 `reserved` 中一起扣减；预留不足就拒绝命令，原因码 `insufficient-resource`。
- 动用某个库存点的资源需要权限：库存点所属派系的战略 Agent（不受数量限制），或持有覆盖该库存点的委托（`Delegation`）、且有效委托余额合计覆盖本次用量的主体（否则原因码 `draw-limit-exceeded`）。同一主体对同一库存点持有多份有效委托时，按 `delegationId` 字典序逐份扣减：每份先贡献当前剩余的资源，累计覆盖后才接受任务。供给、能源或医疗中任一资源总量不足时整笔拒绝，不留下部分扣减。任务记录每份实际扣减的委托与数量，在任务被接受时扣减，任务在出发前取消时按这些记录分别退回。
- 展示等级：比值 `amount / max(1, baseline)`，其中 `baseline` 为初始数量。`< 0.3` 为“短缺”（`scarce`），`0.3–1.2` 为“可维持”（`adequate`），`> 1.2` 为“有余量”（`surplus`）。玩家只看到自己有委托的库存点的精确数量，其余只看到等级。
- 每日消耗：`sp-commons` 每天消耗 6 点供给。这是序章的日耗，城市账按 [01-baseline.md — 数值基线](../design/balance/01-baseline.md#3-资源与仪表) 另行结算。可用量不足时只扣可用量，并提交公开事件 `SupplyShortage`。
- 仓储受潮：t72 的剧情卡先于当日结算执行。在同一事务中按 `min(10, amount.supply − reserved.supply)` 扣减 `sp-commons` 供给，`StockpileAdjusted` 记录实扣量。可用量为 0 时直接完成该效果，日结照常执行。

## 4. 局势指标与每日结算

| 指标 | 范围/初值 | 每日变化（在 `DayPassed` 中结算） | 其他变化 | 阈值事件 |
|---|---|---|---|---|
| `relay.stability` 中继稳定度 | 0–100，初值 45 | 水闸分配为 harbor-first 时 −3，rotation 时 −5，orchard-first 时 −8 | 修复任务完成 +25（`team-star` 为 +40；本派工务支持者参与 +10，本切片为陶安；洛参与非 `team-star` 任务 +15），上限 100 | 首次低于 30 时提交 `RelayDegraded`；降到 0 时提交 `RelayDown`；从 30 以下回升到 30 及以上时提交 `RelayRestored` |
| `orchard.water` 果园水量 | 0–100，初值 50 | harbor-first −9，rotation −2，orchard-first +5 | — | 首次 ≤ 20 时提交 `OrchardCrisis`；首次降到 0 时提交 `OrchardDamaged`，同时 `sp-flora` 医疗材料 −5（不低于 0） |
| `migration.safety` 迁徙安全 | 0–100，初值 50 | tick < 96 时不变；迁徙季（tick ≥ 96）：`r-gh-ps` 关闭时 −10，受限且 `species-fauna` 没有通行许可时 −6，其余情况 −2 | 迁徙道路（`r-gh-ps`、`r-wg-ps`、`r-ps-ar`）上的护送完成 +12（本派治安/向导支持者参与再 +4，本切片为陆沉；追风参与同效）；伤员救援完成 +10；伤员恶化 −10 | 首次 ≤ 20 时提交 `MigrationCrisis` |
| `watergate.allocation` 水闸分配 | `harbor-first`（初值）\| `rotation` \| `orchard-first` | — | 公社党魁按第 8 节直接设置，或由协议条款 `water-allocation` 生效时设置 | 修改时提交公开事件 `PolicyChanged` |

每日结算的顺序：先算 `relay.stability`，再算 `orchard.water`，接着算 `migration.safety`，最后按库存规则扣减 `sp-commons` 每日供给。三项仪表截断在 [0,100]。然后在同一个事务里提交一个 `DayPassed`，其中带各指标的变化前后值与原因。剧情模块可以订阅 `DayPassed`，在随后的独立事务里通过 world 的 `changeMeter` 追加调整（`game.scenario.watergate` 不做调整；`game.scenario.watergate-escalating` 见 [内容包](content-pack.md) 第 9 节），追加调整以单独的 `MetersChanged` 公布。

修复完成时先取队伍基础值，再加符合条件的随队加成，每类加成最多计一次。普通队伍同时带本派工务支持者和洛时增加 `25 + 10 + 15 = 50`。`team-star` 属于泊星者，标准名册没有泊星者派系的工务支持者，只能取得基础值 `40`。实际稳定度上限为 100。

指标的展示等级（玩家投影与 HUD 使用）：`≤ 20` 为危急（`critical`），`21–39` 为紧张（`strained`），`≥ 40` 为稳定（`stable`）。

中继状态：稳定度 ≥ 30 为正常，1–29 为降级，0 为中断；对通信的影响见第 9 节。

## 5. 队伍、角色与群体

| 实体 | 世界状态 | 规则 |
|---|---|---|
| 队伍 Team | 所属派系、所在节点、能力标签、运力 `capacity`、`status`（idle/assigned/traveling/working/recovering）、`busyUntilTick` | 同一时刻只执行一个任务；只有 idle 才能接新任务 |
| 角色 Character | 所在节点、`injuredUntilTick`、当前任务 | 受伤期间不能参与任务，但可以交谈；位置只随参与的任务改变 |
| 群体 Group | `grp-injured-migrants`：位于 pass，6 名伤员，`deadlineTick = 48`，状态 waiting/rescued/worsened | tick 48 时，若既未救出也没有进行中的救援任务，状态变为 worsened：提交 `GroupWorsened`，`migration.safety −10`；之后仍可救援 |

**位置口径：** 位置按“世界状态优先，内容包没有角色定义者取内容包驻地”判定。玩家驻在 `grayharbor`。有角色记录的 Agent 取世界状态中的当前位置，参加任务移动后随之更新；世界状态缺少其记录时位置未知，不用内容包驻地代替。八名公社支持者从灰港开局，外域 Agent 从各自领地开局（追风在隘口、青枝在果园、洛在锚区）。内容包没有角色定义、以派系 ID 行动的人类 AI 党魁取内容包派系驻地链（`factionHomeNodeId`，缺省依次退回 `outpostNodeId`、`territoryNodeId`）；本序章五个人类派系的驻地都是灰港，因此四名 AI 党魁也在灰港。AI 党魁不参加任务、没有移动路径；若后续允许其移动，必须把位置写入世界状态，不能只改内容包。通信的同节点判定与事件的节点受众都使用这一口径。

## 6. 任务结算

`task.dispatch` 按以下顺序校验，遇到第一个不满足的条件就以对应原因码拒绝：

1. `invalid-params`：任务类型、队伍、库存点、道路、群体或节点不存在；该类型的必需参数缺失；`cargo` 全为 0；`departAfterTicks` 不在 1–6。
2. `no-authority`：派遣者既不是队伍所属派系的战略 Agent，也没有覆盖该队伍的有效委托；或者对要用到的库存点没有动用权（第 3 节）。
3. `team-busy`：队伍不是 idle。
4. `capability-missing`：队伍没有该任务类型的能力标签。
5. `team-not-at-origin`：运输时队伍不在起点库存点所在节点。
6. `over-capacity`：运输时 `cargo` 总量超过运力（本派物资支持者随队时按运力 +5 计算；本切片为温原）。
7. `participant-unavailable`：受邀角色不在队伍所在节点或该任务的工作节点（运输的起点、护送道路的端点、救援群体所在节点、修复的 grayharbor、侦察的目标节点），或正在受伤、正在其他任务中。
8. `route-unavailable`：按第 2 节找不到路径。
9. `draw-limit-exceeded`：派遣者以委托身份动用资源，且用量超过委托余额。
10. `insufficient-resource`：库存可用量不足。

接受后的流程：

1. 任务进入 `pending`，完成资源预留与委托余额扣减，并为每位受邀者提交 `TaskInvitationIssued`。出发 tick = 当前 tick + `departAfterTicks`（默认：无受邀者为 1，有受邀者为 2）。
2. 出发时：在出发前用 `task.respond` 回复 accept 的受邀者才会参与，未回复的视为拒绝并提交 `TaskInvitationExpired`。重新检查路径与运力（本派物资支持者没有参加时按原运力）；不满足时任务失败（原因码 `route-closed` 或 `over-capacity`），并释放预留、退回委托余额。都满足则提交 `TaskDeparted`（任务进入 `running`，带名义完成 tick），同时按第 2 节做风险抽样。
3. 到了名义完成 tick：有延误且尚未通知则提交一次 `TaskDelayed`，设置 `delayNoticeSent` 并安排累计延误后的真正完成 job；没有延误或延误已过，就按下表结算并提交 `TaskCompleted`；结算条件不满足时提交 `TaskFailed`，并附原因码。

| 类型 | 参数 | 所需能力 | 用时 | 资源 | 完成效果 |
|---|---|---|---|---|---|
| transport 运输 | `fromStockpileId`、`toStockpileId`、`cargo` | transport | 从起点到终点的行程（含货物 +1/路） | 接受时在起点预留 `cargo` | 货物从起点转入终点；队伍与参与者移到终点 |
| escort 护送 | `roadId`、`durationTicks`（6–24，默认 12） | escort | 若不在道路端点，先赶到最近端点，再巡护 `durationTicks` | 无 | 巡护期（从到达端点起 `durationTicks` 个 tick）内出发、经过该道路的任务，对该道路跳过风险抽样；完成时若为迁徙道路，`migration.safety +12`（本派治安/向导支持者参与再 +4，本切片为陆沉；追风参与同效） |
| rescue 救援 | `groupId`、`toNodeId`（须有医疗设施）、`medicalStockpileId`（须在 `toNodeId`） | rescue | 队伍 → 群体所在节点 → `toNodeId` 的行程；本派医政/救援支持者参与时总用时 −2（至少 1；本切片为穆枝） | 预留医疗材料，数量等于伤员数 | 消耗预留；群体状态变为 rescued，伤员数归 0；`migration.safety +10` |
| repair 修复 | `target: relay`、`energyStockpileId`、`supplyStockpileId` | repair | 先赶到 grayharbor，再工作 6 tick | 能源 10、供给 5（`team-star` 只需能源 10，`supplyStockpileId` 可为 null）；库存点必须在 grayharbor 或队伍出发节点 | `relay.stability` 按第 4 节增加 |
| scout 侦察 | `nodeId` | scout | 赶到目标节点，再观察 2 tick；本派情报/侦察支持者（本切片为祁录）或追风参与时每条道路 −1（每条至少 1） | 无 | 提交 `ScoutReported`（受众：派遣者、参与者、队伍所属派系），内容为节点相邻道路状态、在场角色、群体状态；该节点上 `discoverable: true` 的证据经 world 的 `discoverEvidence` op 提交 `EvidenceDiscovered`，再经 comms 的 `grantKnowledge` op 授予受众知识（同一事务）；知识的受众与 `ScoutReported` 相同，即派遣者、参与者与队伍所属派系（战略 Agent 及其角色） |

取消（`task.cancel`，由派遣者或队伍所属派系的战略 Agent 发起）：

| 当时状态 | 结果 |
|---|---|
| pending | 变为 cancelled；释放预留，退回委托余额，未回复的邀请作废 |
| running：transport | 变为 cancelled；货物退回起点（释放预留）；队伍保持忙碌直到名义完成 tick，之后回到起点 |
| running：rescue / escort / scout | 变为 cancelled；释放预留，不产生完成效果；队伍停在当前所在节点 |
| running：repair，尚未到达 | 变为 cancelled；释放预留 |
| running：repair，已在工作 | 变为 cancelled；已经消耗的资源不退还，也不产生效果 |
| completed / failed / cancelled | 拒绝：`task-not-cancellable` |

队伍受伤休整：风险抽样的受伤结果落到队伍时，任务完成后 `status = recovering`，`busyUntilTick = 完成 tick + 24`。

## 7. 协议与授权

协议是当事人之间的结构化条款，世界规则只追踪条款的真实履约情况，不替任何角色“记住”承诺。

协议主体按派系统一归属：派系主体归属自身；当前 campaign 的玩家归属 `campaign.factionId`；普通角色与未知主体不映射派系，保持自身主体语义。判定履约与违约时，主体相同或归属同一非空派系的双方可互相代表：任务类条款的“义务人派遣或其派系队伍完成”按该归属判断，通行与水闸条款的实际行为人也按同一归属与义务人比较。

条款类型（`obligorId` 是承担义务的当事人）：

| kind | 参数 | 有效性检查 | 生效时效果 | 履约判定 | 违约判定 |
|---|---|---|---|---|---|
| `deliver` | `resource`、`amount`、`fromStockpileId`、`toStockpileId`、`byTick` | 义务人对起点库存点有动用权 | 无 | `byTick` 前，由义务人派遣或其派系队伍完成的、从起点到终点的运输累计达到 `amount` | 到 `byTick + 1` 仍未履约 |
| `escort` | `roadId`、`byTick` | 道路存在 | 无 | `byTick` 前，义务人派遣或其派系队伍完成该道路的护送 | 同上 |
| `rescue` | `groupId`、`byTick` | 群体存在且未被救出 | 无 | `byTick` 前，义务人派遣或其派系队伍完成该群体的救援 | 同上 |
| `repair-relay` | `byTick` | — | 无 | `byTick` 前，义务人派遣或其派系队伍完成中继修复 | 同上 |
| `share-evidence` | `evidenceId`、`toPrincipalId`、`byTick` | 义务人持有该证据的知识授权 | 无 | `byTick` 前提交了 `InformationShared`，分享者为义务人，受众包含 `toPrincipalId` | 同上 |
| `grant-passage` | `roadId`、`granteeFactionId`、`untilTick` | 义务人是该道路控制方的战略 Agent | 创建 `PassageGrant` | 生效即履约 | `untilTick` 前，义务人把该道路设为 closed |
| `water-allocation` | `policy`、`untilTick` | 义务人须拥有水闸设置权，见第 8 节。序章的 `obligorId` 是占公社席的玩家 `player-1` | 立即设置水闸分配 | 生效即履约 | `untilTick` 前，义务人把分配改成其他值 |
| `delegate` | `granteeId`、`teamIds`、`stockpileId`（可为 null）、`maxDraw`、`untilTick` | 义务人是被委托队伍/库存点所属派系的战略 Agent | 创建 `Delegation` | 生效即履约 | 首版没有撤销命令，不会违约 |

生命周期：

```text
proposed --其余当事人都 accept--> active --全部条款履约--> fulfilled
proposed --任一当事人 reject--> rejected
proposed --任一当事人 counter--> superseded（同时生成 version+1 的新提案，提出者为还价方，保留原 expiresAtTick）
proposed --到 expiresAtTick 仍未生效--> expired（默认在提出后 24 tick；显式 expiresInTicks 允许 1–168，超过 168 返回 deadline-out-of-range，不静默钳制）
active   --任一条款违约--> breached（其余条款继续追踪，只记录，不改变状态）
```

- **提出者在提出时即视为已接受**（`responses[proposerId] = "accept"`）；还价同理，还价方视为已接受新版本。因此两方协议只需另一方 accept 一次即生效；提出者再对自己的提案回复时返回 `already-responded`。
- 当事人至少两个且互不相同，必须包含提出者；每个当事人都必须是当前世界的已知主体（内容角色、派系战略 Agent 或当前 campaign 的玩家），未知主体返回 `unknown-party`。每个条款的义务人都必须是当事人；`byTick`/`untilTick` 必须晚于当前 tick，且不超过当前 tick + 168。
- 一次提案与一次还价的条款数都不超过 20 条，避免一份协议一次性安排大量违约检查 job。
- 还价只替换条款与提出者，保留原提案的绝对到期 tick，不重置为当前 tick + 24，因此反复还价不会延长协商窗口。版本号从 1 起，每次还价加一，达到 5 个版本后拒绝继续还价，原因码 `counter-limit-reached`。
- 玩家可以成为当事人；玩家承担的资源类义务不能超过其委托余额。
- 违约检查由每个待履约条款在 `byTick + 1` 的 job 触发，产生 `AgreementBreached`（带 `termIndex` 与 `obligorId`）。

授权实体：

- `Delegation`：委托方派系、受托主体、可派遣的队伍、可动用的库存点及其各资源余额 `maxDraw`、到期 tick。开局时，玩家与每个派系的“职责角色”都会获得初始委托（见 [内容包](content-pack.md) 第 6、8 节）。
- `PassageGrant`：道路、获准派系、到期 tick。

## 8. 政策

`policy.set { key, value }` 按本分支的控制权裁决。公社席由玩家占据时，以认证的 `principalId` 和已开局 campaign 的 `playerId`、`factionId` 确认其公社党魁权限。

| key | 有权设置者 | value |
|---|---|---|
| `watergate.allocation` | 占公社席（`seat.commune`，派系 `human-neutral`）的玩家 `player-1` | `harbor-first` / `rotation` / `orchard-first` |
| `road.status:<roadId>` | 该道路控制方的战略 Agent，或该 Agent 的获授权真人控制者 | `open` / `restricted` / `closed` |

设置值与当前值相同时拒绝，原因码 `no-change`。政策变化是公开事实，所有主体立即获知。Agent binding 的预检见 [tools.md — 工具集与权限检查](../agent/tools.md#132-binding-模板与工具集)。

## 9. 通信、证据与传闻

送达延迟以命令接受时的 tick 为基准。按 [队伍、角色与群体](#5-队伍角色与群体) 查说话者和接收者的位置。双方在同一节点才走“同节点”列，其余按中继状态列处理。

| 渠道 | 同节点 | 中继正常 | 中继降级 | 中继中断 |
|---|---|---|---|---|
| 玩家对话 `dialogue.say`、角色回话 | 立即 | 立即 | +2 tick | 拒绝，`relay-down` |
| 定向消息（`message.send`；多人预留 `seat.say`） | 立即 | +1 tick | +3 tick | 拒绝，`relay-down` |
| 证据分享 `information.share` | 立即 | +1 tick | +3 tick | 拒绝，`relay-down` |
| 公开广播 | 立即 | +1 tick | +3 tick | 只送达与发布者同节点的主体（剧情卡广播视为在 grayharbor 发布） |
| 开局消息 | tick 0 立即送达，不受中继影响 | | | |
| 其他所有事件（协议、邀请、任务、委托、政策、指标、通行许可等正式通知） | 立即送达，不受中继影响 | | | |

只有 `DialogueSubmitted`、`MessageSent`、`InformationShared` 带 `deliveries: { principalId, deliverAtTick }[]`。提交时逐个计算送达时点，按 `principalId` 排序去重并冻结。实际发送者和同节点收件者立即收到，其余收件者按各自的送达时点收到。

定向消息、对话或证据分享中任一收件者因中继中断不可达时，整条命令以 `relay-down` 拒绝。广播中断时只投递给发布地的收件者。发布位置未知时没有同节点收件者。冻结的时点在中继状态变化后保持有效，只有权限撤回会取消待投递项。开局消息固定在 tick 0 送达玩家。其余事件在提交的 tick 送达。

| 行为 | 规则 |
|---|---|
| 玩家对话 `dialogue.say` | 只有玩家能用。目标角色与玩家同在 grayharbor 时为当面交谈（channel `face-to-face`），否则为中继通话（channel `relay`）。文本 1–300 字。受众只有双方，旁人感知不到内容 |
| 角色回话 | 由宿主的安全对白流程生成，以 `speech.commit` 提交为 `DialogueSubmitted`，受众与渠道规则同上 |
| 消息 `message.send` | Agent 之间或 Agent 对玩家的定向消息，经安全对白流程生成正文后提交 |
| 公开广播 | 公社党魁以玩家身份提交正文，伊诺（`npc-yinuo`）走 Agent 安全对白流程，剧情卡按自身配置发布。送达适用同一张延迟表 |
| 分享证据 `information.share` | 分享者必须持有该证据的知识授权（秘密不能分享）；受众获得知识授权，提交 `InformationShared` |
| 传闻 | 剧情卡用 `reported` 渠道下发的声称，来源是非 Agent 来源 ID（如 `src-trader`）；规则不判断传闻真假，NPC 只能依靠反证或求证来更新认识 |

## 10. 序章议事与评估

### 10.1 t144 程序案

序章只表决一项**程序案**：决定序章结束后第一周议程的第一项——《供热优先配给法》还是《轮换供水法》；其余两项由轮值议长按五派顺序排入。它不改变城建规则，也不产生正式法案。

| 项 | 规则 |
|---|---|
| 席位 | 5：`seat.commune`（玩家）、`seat.ember`、`seat.earth`、`seat.truce`、`seat.farstar`，各 1 票 |
| 门槛 | 普通程序案 **3 票赞成**通过；2 票及以下失败；弃权与缺席不降低门槛 |
| 提案 | 轮值议长按五派循环产生；序章内容包把初始轮值设为公社（配置项，不改五派循环规则），由玩家提出 |
| 投票 | 玩家投本派一票；四名 AI 党魁按各自立场与已发生事实投 |
| 结果 | 提交 `MotionDecided`（含每席票、赞成数、结果、下一周议程顺序）；写入议事录 |
| 失败 | 议程按轮值议长的默认顺序；玩家失去一次议程设置权，不影响评估三项读数 |

AI 党魁的初始投票倾向：岑雁（砾火）看“是否有担保”，林芜（地生）看“水与果园”，唐箴（止戈）看“伤员与程序”，乔述（远星）看“交换是否可验收”。玩家要在 t144 前用兑现的承诺、证据或交换改变至少一票，否则默认只有公社与止戈赞成。

### 10.2 t168 评估

tick 168 时提交 `ChapterStageEvaluated`，内容包括三个指标的当前值、已履约与已违约协议数、t144 程序案结果，以及评估结果：

- 同时满足 `relay.stability ≥ 40`、`orchard.water ≥ 30`、`migration.safety ≥ 40` 时，结果为 `equilibrium`（暂时均衡）；
- 否则结果为 `strained`，并列出未达标的指标。

**评估不删除存档，也不进入自由模式。** 本切片到此结束；设计上 t168 进入第 1 季第 2 周，城建、法案与四季从那里开始，不在本切片实现。存档保留三项读数、协议与议事记录，供后续开放世界接入。

## 11. 随机源与种子

规则模块不得使用 `Math.random()`。所有随机抽样都通过宿主注入的确定性随机源：

```ts
// seed string -> uint32 via the first 8 hex digits of sha256
function rngFor(runSeed: string, ...parts: string[]): () => number {
  let a = parseInt(sha256Hex([runSeed, ...parts].join(":")).slice(0, 8), 16) >>> 0;
  return () => { // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// risk rolls for one road of one departing task:
//   const r = rngFor(runSeed, "risk", teamId, String(departTick), roadId);
//   delayed = r() < 0.15 * risk; injured = r() < 0.05 * risk; victimIndex = Math.floor(r() * participantsSortedById.length)
```

- 种子只能由 `runSeed` 与语义字段（tick、agentId、teamId、roadId 等）组成，**不得包含随机生成的 ID**（taskId、turnId 等），这样同一 seed 下的不同变体分支在相同局面里会得到相同的抽样结果。
- `runSeed` = RunSpec 的 `seed`：在线世界在首次启动时随机生成并写入 RunSpec；实验 run 取实验规格的 `seed` 加上 `:rep<n>` 后缀（同一次重复的各变体相同）；从存档恢复出的后继 run 沿用原 run 的 seed。它记录在 manifest 中。
- 同一时刻的处理顺序只依赖持久化的创建序号（job 的 `seq`、事件的 `worldSeq`），不依赖 ID 的字典序。同一 seed 与同一命令序列必须得到相同结果。

## 12. 规则验收用例

单元测试至少覆盖下列断言，数值以 [内容包](content-pack.md) 的初始数据为准。测试可以直接以任意主体身份调用命令网关（见 [领域模型](../architecture/domain-model.md) 第 2 节的测试约定）。

1. 同一 `commandId` 与 payload 重复提交，返回同一 receipt，`sp-commons` 只预留一次；同一 `commandId` 换了 payload，返回 `idempotency-conflict`。
2. 资源模块：`sp-commons` 供给 60，先预留 40 成功，再预留 30 被拒，原因码 `insufficient-resource`。派遣层面：`team-commons`（运力 20）运 25 点供给，原因码 `over-capacity`。
3. 已开局并暂停时，占公社席的玩家提交水闸 `policy.set`，被拒绝，原因码 `paused`，`worldTick` 不变。未开局且暂停时，合法的 `campaign.start` 照常被接受。
4. 玩家（公社党魁）派 `team-commons` 从 `sp-commons` 运 10 点供给到 `sp-earth`：路径为 `r-gh-or`，用时 5 + 1 = 6；tick 0 派遣，出发 tick 为 1，到达 tick 为 7，到达时两边库存分别为 50 与 30，玩家委托的供给余额从 15 变为 5。
5. `human-alien-accord` 派 `team-accord` 从 `sp-accord`（anchor）运 5 点能源到 `sp-commons`：`r-gh-an` 与 `r-or-an` 都是 restricted，且没有通行许可，命令被拒绝，原因码 `route-unavailable`；`species-extraterrestrial` 提出 `grant-passage` 协议（道路 `r-gh-an`，获准派系 `human-alien-accord`，`untilTick` 100），`human-alien-accord` 接受后，同一派遣被接受，路径为 `r-gh-an`，用时 5 + 1 = 6。
6. 一份 `deliver` 条款要求 tick 48 前送达 10 点供给，到 tick 49 仍未完成，提交 `AgreementBreached`，协议状态变为 breached。
7. 占公社席的玩家在 tick 1 把水闸分配设为 rotation。到 tick 168（共 7 次每日结算），`orchard.water = 50 − 2×7 = 36`，`relay.stability = 45 − 5×7 = 10`（期间没有修复）。
8. 救援：止戈的 `team-truce` 在 pass，从 `sp-truce` 预留 6 点医疗材料，把伤员送到 grayharbor；无受邀角色时用时 6，再加上 `r-gh-ps`（risk 1）风险抽样得到的延误（测试固定 `runSeed`，断言时把抽样结果算进去）；完成后伤员归 0，`migration.safety +10`。
9. 风险抽样：固定 `runSeed`、`teamId`、出发 tick、`roadId` 时结果恒定，与 taskId 无关；对 risk 0 的道路不抽样；在巡护期内经过被护送道路时不抽样；有延误时先在名义完成 tick 提交 `TaskDelayed`，累计延误 `2 × 命中道路数` tick 后才提交 `TaskCompleted`，多道路命中仍只通知一次。
10. tick 48 时伤员既未救出也没有进行中的救援，提交 `GroupWorsened`，`migration.safety −10`。
11. pending 状态取消运输，预留与委托余额全部退回；已在工作中的修复被取消时不退还资源。
12. 序章评估：给定三个指标的值，结果分别为 `equilibrium` 或 `strained`，并带未达标列表；t144 程序案结果为 3 票赞成时议程按玩家提案，否则按轮值议长默认顺序。
13. 两方协议：提出者提出后，另一方 accept 一次即变为 active；提出者再回复自己的提案，返回 `already-responded`。
14. 中继降级（稳定度 25）时，玩家对隘口的追风说话，`DialogueSubmitted.deliveries` 中追风的送达时点为当前 tick + 2，玩家为当前 tick。中继中断时，该对话以 `relay-down` 拒绝。玩家分别向同在灰港的温原、岑雁说话时仍即时送达。
15. t72 受潮卡触发时，若供给总量为 9、其中 5 已预留，仓储受潮只扣 4，保留 5 点预留。随后的日结报告供给短缺。
