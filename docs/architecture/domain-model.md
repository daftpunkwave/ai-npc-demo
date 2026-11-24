# 领域模型：命令、事件、状态与投影

> 单机也需保留的席位与动作者字段见 [02-authority-economy-fairness.md — 首版要留的接口](../design/multiplayer/02-authority-economy-fairness.md)。当前迁移缺口见 [IMPLEMENTATION-STATUS.md — 席位契约](../IMPLEMENTATION-STATUS.md#35-席位契约)。

> 本文维护命令与事件目录、状态所有权及投影语义。待交付的命令和事件扩展在对应章节标明，HTTP 可用范围以 [api.md — 通用约定](api.md#1-通用约定) 为准。数值规则见 [规则](../game/rules.md)；信封、receipt 与错误码见 [公共契约](contracts.md)；事务与恢复语义见 [事件与状态](events-and-state.md)；表结构见 [存储](storage.md)。

## 1. ID 前缀

运行中生成的 ID 一律为 `<前缀>-<12 位小写 base32>`（见 [技术栈](../delivery/tech-stack.md) 第 7 节）；内容包里的 ID 是固定字符串，不加随机后缀。随机 ID 只用于标识，**不能参与随机种子或排序**（见 [规则](../game/rules.md) 第 11 节）。

| 前缀 | 对象 | 前缀 | 对象 |
|---|---|---|---|
| `wld` | 世界 | `br` | 分支 |
| `run` | 运行 | `cmp` | campaign |
| `cmd` | 命令（由调用方生成） | `rcp` | receipt |
| `evt` | 领域事件 | `job` | 逻辑任务 |
| `op` | 副作用操作 | `task` | 游戏任务 |
| `inv` | 任务邀请 | `agr` | 协议 |
| `conv` | 会话 | `dlg` | 对话发言 |
| `msg` | 消息 | `shr` | 证据分享 |
| `del` | 委托 | `pg` | 通行许可 |
| `kg` | 知识授权 | `obs` | 观察 |
| `mem` | 记忆记录 | `turn` | Agent turn |
| `att` | 模型 attempt 与 turn 工具执行关联 | `llm` | 逻辑模型调用 |
| `tc` | 工具调用 | `art` | artifact |
| `trc` | trace | `spn` | span |
| `snap` | 快照 | `ses` | 会话令牌 |
| `prb` | 探针结果 | `rr` | 运行申请 |
| `mnt` | 记忆整理任务 | `trg` | trigger |
| `exp` | 实验 | `rum` | 传闻 |
| `fact` | 叙事事实 | | |

内容 ID：节点用节点名（`grayharbor`），道路 `r-*`，库存点 `sp-*`，队伍 `team-*`，群体 `grp-*`，证据 `ev-*`，秘密 `sec-*`，剧情卡 `card-*`，非 Agent 来源 `src-*`。

## 2. 主体与认证上下文

```ts
type PrincipalKind = "player" | "agent" | "operator" | "researcher" | "evaluator" | "system";

interface AuthContext {            // 始终由宿主构建，绝不从 payload 读取
  readonly principalId: string;    // "player-1"、agentId、控制台账号或 "system:world"
  readonly kind: PrincipalKind;
  readonly roles: readonly string[];
  readonly worldId: string;
  readonly branchId: string;
  readonly actingAsAgentId: string | null; // 真人席位代理非人类派系 Agent 时设置
  readonly controllerEpoch: number | null; // kind === "agent" 或 actingAsAgentId != null 时必填
  readonly turnLeaseEpoch: number | null;  // 从 Agent turn 发出的命令必填
  readonly turnId: string | null;
}
```

- 玩家命令：`principalId = player-1`。
- Agent 命令：只能在 turn 内由工具网关或宿主发出，`principalId = agentId`，并带 `controllerEpoch` 与 `turnLeaseEpoch`。
- 真人席位：运营账号经控制台以 `actingAsAgentId` 代某个非人类势力战略 Agent 发命令，按该 Agent 的权限裁决，`principalId` 记为该 agentId，审计里另记运营账号。
- 规则 job、时钟步骤与实验运行器：`principalId = system:world`，不受玩家/Agent 权限约束，但只能执行各自定义的处理逻辑。
- **测试约定**：命令网关的构造参数 `allowDirectAgentCommands`（只在测试代码中为 true）允许 `kind = "agent"`、`turnId = null` 的上下文直接提交命令，此时跳过 controllerEpoch 与 turnLeaseEpoch 检查。生产装配不开启。

## 3. 状态与所有权

每类聚合只有一个所有者模块；其他模块只能经所有者的 queries 读取、经所有者的 ops 修改（第 4 节）。

| 聚合 aggregateType | 键 | 所有者模块 | 主要字段 |
|---|---|---|---|
| `campaign` | campaignId | `game.world.slg-light` | factionId、playerId、chapterId、startTick、status（running/evaluated）、outcome |
| `meters` | `meters` | `game.world.slg-light` | relay.stability、orchard.water、migration.safety、watergate.allocation、已触发阈值集合 |
| `character` | agentId | `game.world.slg-light` | nodeId、injuredUntilTick、currentTaskId |
| `team` | teamId | `game.world.slg-light` | ownerFactionId、nodeId、capabilities、capacity、status、busyUntilTick、currentTaskId |
| `group` | groupId | `game.world.slg-light` | nodeId、injured、deadlineTick、status |
| `delegation` | delegationId | `game.world.slg-light` | grantorFactionId、granteeId、teamIds、stockpileId、remaining、untilTick |
| `evidence-placement` | evidenceId | `game.world.slg-light` | nodeId、discoveredBy |
| `road` | roadId | `game.map.six-nodes` | status（受控道路） |
| `passage-grant` | grantId | `game.map.six-nodes` | roadId、granteeFactionId、untilTick |
| `stockpile` | stockpileId | `game.resources.light` | nodeId、ownerFactionId、amount、reserved、baseline |
| `task` | taskId | `game.actions.standard` | taskType、teamId、dispatcherId、invitees、participants、params、status、departTick、nominalCompletionTick、completionTick、riskOutcome（内部）、delayNoticeSent、reservations |
| `agreement` | agreementId | `game.agreements.standard` | version、proposerId、parties、responses（提出者在提出时即为 accept）、terms（含每条状态与累计进度）、status、expiresAtTick、supersedesId |
| `conversation` | conversationId | `game.comms.standard` | participants、lastSeq、lines（按 seq 固化的对白与冻结投递） |
| `knowledge-grant` | grantId | `game.comms.standard` | principalId、itemId（证据或秘密）、via、grantedAtTick |
| `message` | messageId | `game.comms.standard` | fromId、to、channel（message/broadcast/seat/opening/reported）、text、intentKind、deliveries、committedAtTick、conversationId |
| `share` | shareId | `game.comms.standard` | fromId、evidenceId、audience、sharedAtTick |
| `scenario-card` | cardId | `game.scenario.*` | version、status（draft/published/triggered/withdrawn）、triggerAtTick |

以下状态不在 `aggregate_state` 中，而是有专用表：时钟（`clock` 表，归 `game.clock.controlled`）；Agent 激活、控制权、trigger、观察、记忆（归宿主 `agent-runtime` 与对应 Agent 模块，见 [存储](storage.md) 第 2 节）。静态内容（节点、道路属性、人格、证据正文）由内容加载器读入内存只读索引。

## 4. 规则处理器与事务内写入

所有规则处理器（命令处理器、job 处理器、时钟步骤、事件订阅）都是**同步函数**：在 authority 打开的事务里执行，不 await、不调用模型、不做网络 I/O。处理器不直接持有数据库，而是通过 authority 提供的事务内接口登记变更；事务由 authority 统一提交或回滚，模块不能自行提交。

```ts
interface WorldTx {                        // 每个事务一个实例，作用域限定为调用模块
  readonly worldTick: number;
  get<T>(aggregateType: string, aggregateId: string): { version: number; state: T } | null; // 仅限本模块拥有的类型
  list<T>(aggregateType: string): { id: string; version: number; state: T }[];               // 仅限本模块拥有的类型
  put(aggregateType: string, aggregateId: string, state: Json): void;    // 仅限本模块拥有的类型；version + 1
  remove(aggregateType: string, aggregateId: string): void;              // 仅限本模块拥有的类型
  emit(type: string, payload: Json, audience: AudienceSpec[], causationIds?: string[]): string; // 返回 eventId
  schedule(kind: string, dueTick: number, idempotencyKey: string, payload: Json): void; // 键已存在时不执行
  cancelJobs(idempotencyKeyPrefix: string): void;
  requestClockStop(requestId: string, reason: string): void; // 与业务结果同事务提交的持久停止点
}

interface HandlerContext {
  readonly auth: AuthContext;
  readonly tx: WorldTx;                    // 写入范围仅限本模块拥有的 aggregate 类型
  readonly modules: GameModulePorts;       // 本模块自身能力，加上其 requires 声明的端口
  readonly approvedSpeech: { read(ref: string): ApprovedSpeech | null }; // 宿主注入、同步、只读、限定当前事务
  readonly content: ContentIndex;          // 只读内容包
  readonly rng: (...parts: string[]) => () => number; // rngFor(runSeed, ...parts)，见规则 §11
  readonly ids: (prefix: string) => string;
}

interface ApprovedSpeech {
  readonly text: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly branchId: string;
  readonly audience: readonly string[];
  readonly channel: "dialogue" | "message" | "broadcast";
  readonly approved: boolean;
}

type HandlerResult =
  | { readonly kind: "accepted"; readonly result?: Json }
  | { readonly kind: "rejected"; readonly reasonCode: ReasonCode; readonly safeMessage: string };

type OpResult = { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
```

每个游戏模块在描述符里声明 `ownsAggregates`（它拥有的 aggregateType 列表）；`WorldTx` 对其他类型的读写直接抛错（编程错误）。模块之间只经下表的 queries（只读）与 ops（修改，可能返回拒绝）协作，`GameModulePorts` 按能力 ID 取用，例如 `ctx.modules["game.resources"].ops.reserve(...)`：

| 能力 | queries | ops |
|---|---|---|
| `game.world` | `campaign()`、`meters()`、`character(id)`、`team(id)`、`group(id)`、`delegationsOf(principalId)`、`canDispatchTeam(principalId, teamId)`、`drawAuthority(principalId, stockpileId)`（返回 `owner` / `delegation` / `none` 与余额） | `moveCharacter(id, nodeId)`、`moveTeam(id, nodeId)`、`setTeamStatus(id, status, busyUntilTick, taskId)`、`setCharacterTask(id, taskId)`、`injureCharacter(id, untilTick, cause)`、`drawDelegation(principalId, stockpileId, delta)`、`refundDelegation(principalId, stockpileId, delta)`、`createDelegation(spec)`、`changeMeter(meter, delta, cause)`、`setAllocation(value, byId)`、`setGroupStatus(id, status, taskId)`、`discoverEvidence({ evidenceId, discoveredBy, taskId })`（更新发现者并发 `EvidenceDiscovered`，不授予知识） |
| `game.map` | `road(id)`、`findRoute({ fromNodeId, toNodeId, factionId, atTick, withCargo })`（返回道路列表与行程，或 null）、`hasPassage(roadId, factionId, atTick)` | `setRoadStatus(roadId, status, byId)`、`grantPassage({ roadId, granteeFactionId, untilTick })` |
| `game.resources` | `stockpile(id)`、`available(id)`、`level(id)` | `reserve(stockpileId, delta, taskId)`、`release(stockpileId, delta, taskId)`、`consume(stockpileId, delta, reason, taskId)`、`transfer(fromId, toId, delta, taskId)`、`adjust(stockpileId, delta, reason)` |
| `game.actions` | `task(id)`、`tasksOf(principalId)`、`completedTasks()` | — |
| `game.agreements` | `agreement(id)`、`agreementsOf(principalId)`、`countsAsOf(tick)` | — |
| `game.comms` | `relayState()`、`sameNode(fromId, toId)`、`deliverAt(channel, fromId, toId)`（按 [规则](../game/rules.md) 第 9 节计算送达 tick 或返回 `relay-down`）、`holds(principalId, itemId)`、`hasShare({ fromId, evidenceId, toPrincipalId, sinceTick, byTick })`、`messagesFor(principalId, limit)`、`conversationsOf(principalId)`、`conversationMessages(conversationId, limit)`、`knowledgeOf(principalId)` | `postMessage(spec)`、`postDialogue(spec)`、`grantKnowledge({ principalId, itemId, via })` |
| `game.scenario` | `cards()` | — |

ops 修改所有者自己的聚合并发出对应事件（例如 `resources.reserve` 发出 `ResourcesReserved`）；不满足条件时返回 `{ ok: false, reasonCode }`，调用方应直接以该原因码返回 `rejected`。

模块之间的依赖（`requires`）必须无环，首版固定为：world → map、resources；comms → world；actions → world、map、resources、comms；agreements → world、map、comms、actions；scenario → world、map、comms、resources；map、resources、clock、save 不依赖其他游戏模块。需要“反方向”协作时，用事件订阅或后续钩子，不新增依赖：

| 模块 | 后续钩子（`afterCommand`，与主处理器同一事务） | 事件订阅（各自独立的事务） |
|---|---|---|
| `game.comms` | `campaign.start`：开局消息、开局知识与内容包 `heldBy` 的知识授权 | — |
| `game.scenario` | `campaign.start`：按本模块节奏安排本章剧情卡 job | `game.scenario.watergate-escalating`：`DayPassed`、`TaskCompleted`（见 [内容包](../game/content-pack.md) 第 9 节） |
| `game.agreements` | — | `TaskCompleted`、`InformationShared`、`PolicyChanged`（履约与违约判定） |
| 宿主 `agent-runtime` | `campaign.start`：按名册激活 Agent（配额不足则整个命令以 `budget-exhausted` 拒绝） | — |

同一命令的后续钩子按“游戏模块的拓扑顺序，宿主最后”执行。

authority 执行一条命令的固定流程：

```text
BEGIN IMMEDIATE
  1. idempotency: receipt for (branch, principal, commandId) exists?
       same payloadHash -> COMMIT, return the stored receipt; different -> return idempotency-conflict
  2. auth checks: command allowed for this principal kind; branch-kind restriction (probe.ask only in a sandbox branch) -> rejected "no-authority"; fencing (controllerEpoch, turnLeaseEpoch) unless allowDirectAgentCommands
  3. pause check: clock.mode != running/stepping -> rejected "paused" (campaign.start and system:world probe.ask in an active sandbox are exempt)
  4. payload schema (zod, strict) -> rejected "invalid-params"
  5. expectedVersions: every listed aggregate has that version -> else rejected "version-conflict"
  SAVEPOINT cmd
  6. handler(ctx) -> rejected: ROLLBACK TO cmd
  7. afterCommand hooks registered for this command type (modules in topological order, host last) -> a rejection rolls back to cmd
  8. write the receipt (accepted with acceptedEventIds, or rejected with reasonCode)
COMMIT
```

命令类型本身在进入网关之前判定：HTTP 入口用 `commandTypeSchema` 校验 `type`，未登记的类型直接返回 400 `validation`，不进入网关，因此不写回执、不产生事件、不推进世界状态。这一步与权限裁决分离——已登记但当前角色无权的类型仍返回 403 `forbidden`，让客户端能区分「命令不存在」与「无权使用」。网关内部对未登记类型仍保留 200 + `invalid-params` 拒绝回执，供不经 HTTP 的 `execute` 调用方使用。

处理器抛出非 `DomainError` 的异常时整个事务回滚、不写 receipt，HTTP 返回 `plugin-failed`；调用方可以用同一 `commandId` 重试。规则 job、时钟步骤与事件订阅使用同样的事务与 `HandlerContext`，只是没有 receipt。

## 5. 命令目录

`issuer` 列使用契约主体类型：`player` 为玩家；`agent` 为 Agent（含真人席位代发，按该 Agent 权限裁决）；`operator` 为运营控制台；`researcher` 为研究角色；`system` 为宿主内部与实验运行器。`seat.say` 由运营直接代发席位消息；`probe.ask` 只在 sandbox 分支由 `system` 发行。

| type | issuer | payload | 处理模块 | 成功时的事件 | 常见拒绝原因码 |
|---|---|---|---|---|---|
| `campaign.start` | player、system | `{ factionId }` | world（另有 comms、scenario 和宿主钩子） | `CampaignStarted`、`DelegationCreated`、`MessageSent`、`KnowledgeGranted`，并安排伤员期限与剧情卡 job | `campaign-exists`、`unknown-faction`、`world-tick-not-zero`、`budget-exhausted` |
| `dialogue.say` | player | `{ targetAgentId, text }`（1–300 字） | comms | `DialogueSubmitted` | `paused`、`relay-down`、`unknown-target`、`invalid-params` |
| `broadcast.say` | player | `{ text }`（1–300 字） | comms | `MessageSent`（channel `broadcast`） | `paused`、`no-authority`、`invalid-params` |
| `speech.commit` | agent、system | `{ channel: "dialogue"\|"message"\|"broadcast", conversationId: string\|null, audience: string[], approvedSpeechArtifactRef, intentKind, replyToId: string\|null }` | comms | `DialogueSubmitted` 或 `MessageSent` | `speech-not-approved`、`relay-down`、`paused`、`no-authority`（无广播权） |
| `seat.say` | operator | `{ to: string[], text }`（1–200 字，真人席位直接写的话） | comms | `MessageSent`（channel `seat`，没有 speech artifact） | `paused`、`relay-down`、`no-authority` |
| `information.share` | player、agent、operator | `{ evidenceId, audience: string[] }` | comms | `InformationShared`、`KnowledgeGranted`×n | `evidence-not-held`、`secret-not-shareable`、`relay-down`、`paused` |
| `agreement.propose` | player、agent、operator | `{ parties: string[], terms: Term[], expiresInTicks?: number }`（parties 2–20 人、terms 1–20 条；默认 24，范围 1–168） | agreements | `AgreementProposed` | `invalid-terms`、`unknown-party`、`obligor-not-party`、`no-authority`、`deadline-out-of-range` |
| `agreement.respond` | player、agent、operator | `{ agreementId, response: "accept"\|"reject"\|"counter", counterTerms?: Term[] }`（counterTerms 1–20 条） | agreements | `AgreementResponded`，以及视情况 `AgreementActivated`（+生效效果事件）、`AgreementRejected`、`AgreementSuperseded`+`AgreementProposed` | `not-a-party`、`agreement-not-open`、`already-responded`、`counter-limit-reached` |
| `task.dispatch` | player、agent、operator | `{ taskType, teamId, invitees?: string[], params, departAfterTicks?: number }` | actions（调用 world、map、resources 的 ops） | `TaskDispatched`、`ResourcesReserved`、`TaskInvitationIssued`×n | 按 [规则](../game/rules.md) 第 6 节的校验顺序 |
| `task.respond` | agent | `{ taskId, response: "accept"\|"decline", reasonCode?: ReasonCode }` | actions | `TaskInvitationAnswered` | `not-invited`、`invitation-closed` |
| `task.cancel` | player、agent、operator | `{ taskId }` | actions | `TaskCancelled`、`ResourcesReleased`（如有） | `task-not-cancellable`、`no-authority` |
| `policy.set` | player、agent、operator | `{ key, value }` | world（水闸）/ map（道路） | `PolicyChanged`，可能引起 `AgreementBreached` | `no-authority`、`no-change`、`unknown-policy` |
| `scenario.draft` | operator | `{ cardId, version, triggerAtTick, effects: CardEffect[], note }` | scenario | 无事件；写入 `status` 为 `draft` 的 `scenario-card` | `version-conflict`（同一卡片已登记）、`invalid-effect`（效果引用内容不存在）、`deadline-out-of-range`（不在发布窗口内） |
| `scenario.publish` | operator | `{ cardId, version, triggerAtTick }` | scenario | `ScenarioCardPublished`，并安排 `scenario.card` job | `card-not-draft`、`version-conflict`、`deadline-out-of-range` |
| `scenario.withdraw` | operator | `{ cardId }` | scenario | `ScenarioCardWithdrawn` | `card-already-triggered` |
| `scenario.compensate` | operator | `{ cardId, effects: CardEffect[], note }` | scenario | `ScenarioCompensationApplied` + 效果事件 | `card-not-found`、`card-not-triggered`、`invalid-effect` |
| `scenario.override` | operator、researcher | `{ effects: OverrideEffect[], note }` | scenario | `ScenarioOverrideApplied` + 效果事件；run 标记 `contaminated` | `invalid-effect` |
| `probe.ask` | system | `{ probeId, agentId, askedBy, question }`（只允许在 `sandbox` 分支） | comms | `ProbeAsked` | `invalid-params` |

`Term` 即 [规则](../game/rules.md) 第 7 节的八种条款，统一为 `{ kind, obligorId, ...params }` 的判别联合。`CardEffect` 见 [内容包](../game/content-pack.md) 第 9 节；`OverrideEffect` 在 `CardEffect` 之外额外允许 `meter-set { meter, value }` 与 `road-status-set { roadId, status }`，只供调试，使用即污染。

`policy.set` 已对玩家开放：只有当前 campaign 的公社党魁可以设置 `watergate.allocation`，授权使用服务端认证与开局记录，`PolicyChanged.byId` 记为实际操作的 `player-1`。水闸协议的义务人沿用同一权限规则。

序章待交付的命令与权限：

- t144 程序案需要提案与投票命令以及席位归属校验。提案和投票依 [rules.md — t144 程序案](../game/rules.md#101-t144-程序案) 裁决，经命令网关与事务提交。

`broadcast.say` 对占公社席的玩家开放：处理器按已开局 campaign 的玩家与派系席位确认广播权，发布位置取玩家所在节点，投递按公开广播规则计算并冻结；玩家入口与 Agent 的 `speech.commit` 批准流程各自独立。

`campaign.start` 按 [content-pack.md — 开局内容](../game/content-pack.md#8-五席开局startsyaml本切片只启用公社) 逐条提交开局消息。事件 `MessageSent` 的 `fromId` 为发件人，`to` 为 `["player-1"]`，`channel` 为 `opening`，`intentKind` 为 `scripted`，`speechArtifactRef` 为 null，`deliveries` 为玩家与发件人各自 tick 0 的条目（按 principalId 排序）。剧情卡消息的 `channel` 为 `broadcast` 或 `message`，`intentKind` 为 `scenario`，`speechArtifactRef` 为 null。剧情卡的定向投递与知识授权按显式主体 ID 执行。公社玩家的开局水账来自 `starts.knowledge`，谷寻的定向来信直接投递给 `player-1`。

规则 job：

| job kind | 创建者 | 到期时处理 | 事件 |
|---|---|---|---|
| `task.depart` | `task.dispatch` | [规则](../game/rules.md) 第 6 节出发规则 | `TaskInvitationExpired`、`TaskDeparted` 或 `TaskFailed` |
| `task.work` | `task.depart`（actions 模块；修复任务且工作起点晚于出发 tick） | 到达工作起点时结算任务已预留的能源与供给，任务状态写入“材料已消耗”标记后不再重复扣减；完成与工作中取消复用同一幂等结算 | `ResourcesConsumed` |
| `task.complete` | `task.depart`（到期 tick 为名义完成 tick） | 有延误且 delayNoticeSent 为 false：提交一次 `TaskDelayed`，同事务置 true，并用同一 kind 安排名义完成 tick + 2 × 命中道路数的 job；尚未到真正完成 tick 不结算；否则结算完成效果 | `TaskDelayed`；或 `TaskCompleted`/`TaskFailed`，以及 `ResourcesTransferred`/`ResourcesConsumed`、`MetersChanged`、`CharacterMoved`、`TeamMoved`、`EvidenceDiscovered`、`ScoutReported`、`GroupRescued`、`CharacterInjured` |
| `team.recover` / `character.recover` | 受伤结果 | 恢复可用 | `TeamRecovered` / `CharacterRecovered` |
| `agreement.expire` | `agreement.propose` | 仍为 proposed 则过期 | `AgreementExpired` |
| `agreement.deadline` | 协议生效 | 检查对应条款 | `AgreementBreached` |
| `group.deadline` | `campaign.start` | 伤员恶化规则 | `GroupWorsened`、`MetersChanged` |
| `scenario.card` | scenario 的 `campaign.start` 后续钩子，或 `scenario.publish` | 触发卡片效果 | `ScenarioCardTriggered` + 卡片效果事件 |

时钟步骤（不是 job，见 [规则](../game/rules.md) 第 1 节）：`T % 24 == 0` 时的每日结算（`DayPassed`、`MetersChanged`、阈值事件、`ResourcesConsumed`），`T == 168` 时的章节评估（`ChapterStageEvaluated`）。章节评估的阈值与 campaign 状态由 `game.world` 实现，由 `game.agreements` 在章节终点时钟步骤里调用 `game.world` 的评估操作并把截至当前 tick 的协议计数作为惰性入参传入；只有协议 provider 的章节终点步骤或宿主可以触发评估，其他消费者调用会被拒绝，世界模块因此不需要反向依赖协议模块。

`speech.commit` 的正文只从宿主注入的 `approvedSpeech.read(approvedSpeechArtifactRef)` 取得；此端口只读已持久化且通过安全校验的 speech 结果，不做文件/网络 I/O。批准判定收敛在 `@ai-npc/module-sdk` 的 `isApprovedSpeechUsable`：authority 网关在进入处理器前校验一次；comms 处理器对同一事务内重新读取的结果用同一函数复验，避免只读索引在两次读取间变化后提交未经校验的正文。判定要求 approved、agentId/turnId/branchId 与认证上下文一致（`system` 发行者由宿主代发，不比对 agentId；认证上下文未携带 turn 时不比对 turnId），channel 与去重排序后的 audience 完全匹配，任何不符均 `speech-not-approved`。authority 在同一提交事务以 `(branchId, approvedSpeechArtifactRef)` 唯一消费绑定最终事件，禁止不同 commandId 重放；相同 commandId 只返回已有 receipt。拒绝事务不消费批准结果。probe speech 直接写 probe_results，不能走此命令。

履约判定不是独立 job：`game.agreements` 订阅 `TaskCompleted`、`InformationShared`、`PolicyChanged`，在同一个事件消费事务里提交 `AgreementTermFulfilled`、`AgreementFulfilled` 或 `AgreementBreached`。收到 `TaskCompleted` 时通过 `game.actions.queries.task(taskId)` 读取已完成任务的 dispatcherId、params、participants 与完成状态进行条款匹配；不用扩大发给 gameplay 的事件 payload，也不能跨模块直接读聚合。

## 6. 事件目录

事件信封见 [公共契约](contracts.md) 第 1 节。`audience` 决定谁可能感知（见第 7 节）。

| 事件 | payload 要点 | audience |
|---|---|---|
| `CampaignStarted` | campaignId、factionId、playerId | public |
| `DelegationCreated` | delegationId、grantorFactionId、granteeId、teamIds、stockpileId、maxDraw、untilTick | principals[grantee] + faction[grantor] |
| `KnowledgeGranted` | grantId、principalId、itemId、via（start/share/discovery/setup） | principals[principalId] |
| `MessageSent` | messageId、fromId、to（principal 列表或 `["public"]`）、channel（message/broadcast/seat/opening）、text、deliveries、intentKind、speechArtifactRef | 定向：principals[from, ...to]；广播：public |
| `DialogueSubmitted` | dialogueId、conversationId、speakerId、audience、text、channel（face-to-face/relay）、deliveries、replyToId | principals[audience] |
| `InformationShared` | shareId、fromId、evidenceId、audience、deliveries | principals[from, ...audience] |
| `RumorSpread` | rumorId、sourceId、aboutIds、text | public |
| `WorldFactRecorded` | factId、factType、payload | 卡片声明的 audience |
| `AgentsSummoned` | agentIds、reason、cardId | principals[agentIds] |
| `ProbeAsked` | probeId、agentId、askedBy、question | principals[agentId]（只出现在 sandbox 分支） |
| `AgreementProposed` | agreementId、version、proposerId、parties、terms、expiresAtTick、supersedesId | principals[parties] |
| `AgreementResponded` | agreementId、partyId、response | principals[parties] |
| `AgreementActivated` | agreementId、version、parties、terms | principals[parties] |
| `AgreementRejected` / `AgreementExpired` / `AgreementSuperseded` | agreementId、byId（拒绝或还价的一方，过期时为 null） | principals[parties] |
| `AgreementTermFulfilled` | agreementId、termIndex、obligorId、term、evidenceEventIds | principals[parties] |
| `AgreementFulfilled` | agreementId | principals[parties] |
| `AgreementBreached` | agreementId、termIndex、obligorId、term | principals[parties] |
| `PassageGranted` | grantId、roadId、granteeFactionId、untilTick | public |
| `PolicyChanged` | key、oldValue、newValue、byId | public |
| `TaskDispatched` | taskId、taskType、teamId、dispatcherId、invitees、params、departTick | principals[dispatcher, ...invitees] + faction[team owner] |
| `ResourcesReserved` / `ResourcesReleased` | stockpileId、delta、taskId | principals[dispatcher] + faction[stockpile owner] |
| `TaskInvitationIssued` | invitationId、taskId、inviteeId、taskType、departTick | principals[invitee, dispatcher] |
| `TaskInvitationAnswered` / `TaskInvitationExpired` | invitationId、taskId、inviteeId、response、reasonCode | principals[invitee, dispatcher] |
| `TaskDeparted` | taskId、participants、route、nominalCompletionTick（不含风险延误） | principals[dispatcher, ...participants] + faction[team owner] + node[出发节点] |
| `TaskDelayed` | taskId、newCompletionTick、cause（`road-risk`） | principals[dispatcher, ...participants] + faction[team owner] |
| `TaskCompleted` | taskId、taskType、completedAtTick、effects（公开 `{ kind: "transport" \| "escort" \| "rescue" \| "repair" \| "scout" }[]`，渲染见感知 11.4） | principals[dispatcher, ...participants] + faction[team owner] + node[结束节点] |
| `TaskFailed` / `TaskCancelled` | taskId、reasonCode / byId | principals[dispatcher, ...participants] + faction[team owner] |
| `ResourcesTransferred` | fromStockpileId、toStockpileId、delta、taskId、dispatcherId | faction[两个库存点的所属派系] + principals[dispatcher] |
| `ResourcesConsumed` | stockpileId、delta、reason、taskId（每日结算为 null） | faction[所属派系] + principals[dispatcher] |
| `StockpileAdjusted` | stockpileId、delta、reason | faction[所属派系] + node[库存点所在节点] |
| `CharacterMoved` / `TeamMoved` | id、fromNodeId、toNodeId | public |
| `CharacterInjured` / `CharacterRecovered` | agentId、untilTick、cause | principals[agentId] + faction[其派系] + node[所在节点] |
| `TeamRecovered` | teamId | faction[所属派系] |
| `EvidenceDiscovered` | evidenceId、discoveredBy、taskId | principals[discoveredBy] |
| `ScoutReported` | taskId、nodeId、report | principals[dispatcher, ...participants] + faction[team owner] |
| `GroupRescued` | groupId、taskId、dispatcherId | public |
| `GroupWorsened` | groupId | public |
| `MetersChanged` | changes：`{ meter, from, to, cause }[]` | public |
| `RelayDegraded` / `RelayDown` / `RelayRestored` / `OrchardCrisis` / `OrchardDamaged` / `MigrationCrisis` / `SupplyShortage` | 当时数值 | public |
| `DayPassed` | day、meters、consumption、changes | public |
| `ScenarioCardTriggered` / `ScenarioCardPublished` / `ScenarioCardWithdrawn` / `ScenarioCompensationApplied` / `ScenarioOverrideApplied` | cardId、version、note | system |
| `ChapterStageEvaluated` | outcome、meters、unmet、fulfilledCount、breachedCount、cityResources | public |

程序案交付时，在事件目录与公共 schema 增加 `MotionDecided`，记录逐席票、赞成数、表决结果与下一周议程顺序，供议事录与投影使用。`ChapterStageEvaluated` 同步携带程序案结果。字段命名与兼容读取随该步定稿。参见 [rules.md — 序章议事与评估](../game/rules.md#10-序章议事与评估)。

通信事件的 `deliveries: { principalId: string; deliverAtTick: number }[]` 是提交时冻结、按 principalId 排序去重的实际投递名单（含发送者的立即回显）；单事件不再有标量 deliverAtTick。逐接收者延迟、中断时混合受众的处理见规则第 9 节；投影只读取自己的 delivery。

事件 `type` 一旦发布不得改名；新增字段需有默认语义，破坏性变化提高 `schemaVersion`（见 [公共契约](contracts.md) 第 7 节）。事件 schema 表由公共契约事件与模块显式登记的扩展事件组成：未登记的事件类型不能写入事务，消费者订阅未登记类型会在注册阶段失败。读取旧事件时按登记的支持版本判定是否需要迁移。

## 7. 受众与可见性

```ts
type AudienceSpec =
  | { kind: "public" }                    // 所有人
  | { kind: "node"; nodeId: string }      // 事件提交时位于该节点的所有主体
  | { kind: "principals"; ids: string[] } // 显式列出的 principal
  | { kind: "faction"; factionId: string }// 该派系的战略 Agent 及其角色
  | { kind: "system" };                   // 世界内无受众，仅供研究视图
```

宿主在事件提交后计算每个主体是否“有资格获知”（硬 ACL），结果交给感知模块决定何时、以何种细度形成观察（见 [感知](../agent/perception.md) 第 11 节）。规则：

1. `public`：所有主体都有资格。例外：通信事件还必须在 `deliveries` 中有该主体；公开广播中继中断时只冻结与发布者同节点的接收者（[规则](../game/rules.md) 第 9 节）。
2. `node`：事件提交时位于该节点的主体有资格。玩家位于 `grayharbor`；有角色记录的 Agent 按世界状态中的当前位置判定，内容包没有角色定义的人类 AI 党魁按内容包派系驻地判定；有角色定义但世界状态缺少记录时位置未知。位置口径与序章开局位置见 [rules.md — 队伍、角色与群体](../game/rules.md#5-队伍角色与群体)。
3. `principals` 与 `faction`：名单内主体有资格。
4. `system`：任何 gameplay 主体都没有资格。
5. 送达时间：通信事件按本主体的 `deliveries[].deliverAtTick` 送达，不取全体最大值；无该主体条目则不送达。其余事件在提交的 tick 送达。
6. 未激活的 Agent（名册未包含，或处于 dormant）照常获得观察记录，但不会因此被唤醒。

## 8. 投影

### 8.1 玩家投影 `PlayerProjection`

`GET /api/v1/world/view` 返回、并经 WS 增量更新的玩家可见状态。字段级规则：

| 字段 | 内容 | 来源与限制 |
|---|---|---|
| `campaign` | `CampaignView`（[API](api.md) 第 9 节）：campaignId、factionId、commission、status、outcome；没有 campaign 时为 null | 本 campaign |
| `clock` | worldTick、day、hour、mode、runVersion | 公开 |
| `map` | 节点（名称、坐标、设施）、道路（端点、行程、风险、当前状态） | 公开 |
| `meters` | 三个指标的数值与等级（[规则](../game/rules.md) 第 4 节）、水闸分配 | 公开 |
| `cityResources` | t168 交接后的六种城市资源数量；序章未结束时为 null | 公开 |
| `stockpiles` | 每个库存点的节点、所属、三种已结算资源（供给/能源/医疗）等级；玩家持有委托的库存点给出精确数量与委托余额 | 等级公开；精确值仅限委托；材料/食物/水在序章不出现 |
| `teams` | 位置、所属、状态；玩家委托的队伍标 `delegatedToMe` | 位置与状态公开 |
| `characters` | 名称、派系、职责、所在节点、是否受伤、公开主张（人格 `values` 的第一条） | 公开 |
| `tasks` | 玩家派遣或参与的任务：taskType、队伍、参与者、参数、受理状态、任务状态、出发 tick、名义完成 tick、是否已公布延误；其他任务只给出“某队伍在路上”及其路线 | 不含风险抽样结果 |
| `agreements` | 玩家是当事人的协议 | 当事人 |
| `invitations` | 发给玩家的邀请（首版玩家不会被邀请，保留字段） | — |
| `conversations` | 玩家参与的会话最近 50 条 | 当事人 |
| `inbox` | 发给玩家的消息、公开广播与传闻（标注来源与“传闻”）；保留窗口按送达 tick 取最近 50 条已送达记录，提交早但送达晚的消息在送达当刻仍可读到 | 定向/公开 |
| `notebook` | 玩家持有知识授权的证据（标题、正文、来源）；玩家亲历的事件摘要 | 玩家知识 |
| `awaitingReplyFrom` | 玩家说完最后一句后、尚未回话且 turn 正在排队或进行中的角色 ID | 只暴露“正在处理”状态，不含内容 |
| `notifications` | 由投影规则生成的提醒：`urgent`（受邀/失败/危机）、`deadline`（玩家协议 24 tick 内到期）、`invite`（收到提案）、`public`（广播） | 派生 |

投影绝不包含：任何 Agent 的记忆、观察、prompt、模型请求；其他主体的私密会话与消息；秘密；未发布剧情卡；风险抽样的结果。玩家投影直接按第 7 节的 ACL 构建，不经过感知模块。

### 8.2 Agent 世界视图 `AgentWorldView`

decision 上下文中的“当前局势”段来自该 Agent 的最后已知视图，不是实时全量世界：

| 部分 | 内容 |
|---|---|
| 自身 | 位置（角色）、是否受伤、当前任务、持有的委托及余额、待回复的邀请；自己是当事人且处于 proposed/active 的协议及条款状态，以及最近 12 tick 内状态发生变化的协议（更早结束的协议只能来自记忆，避免给无记忆组提供历史旁路） |
| 静态地图 | 节点与道路属性（人人都知道的地理） |
| 最后已知状态 | 指标、水闸分配、道路状态、库存资源等级（`scarce`/`adequate`/`surplus`）：取自该 Agent 观察到的最近一次 `MetersChanged`/`DayPassed`/`PolicyChanged`/广播，每项带 `asOfTick` |
| 本派系 | 战略 Agent 与本派系角色：本派系库存点的精确数量、本派系队伍状态（经 faction 受众获知的最新值） |
| 已知证据与秘密 | 持有知识授权的证据（标题与正文）与秘密（正文，标注“不可外传”） |

视图只能由该 Agent 的观察与自身状态推导；规则模块不能把世界全量状态直接塞进 Agent 上下文。

## 9. 原因码

receipt 与 `TaskFailed` 的 `reasonCode` 只能取下表的值；同一个码在玩家界面上有固定的中文提示（`locale/zh-CN.yaml` 的 `reasonCodes.<code>`）。

| 分组 | 原因码 |
|---|---|
| 通用 | `invalid-params`、`unknown-target`、`no-authority`、`paused`、`not-ready`、`idempotency-conflict`、`version-conflict`、`stale-controller`、`stale-turn`、`budget-exhausted` |
| 通信 | `relay-down`、`speech-not-approved`、`evidence-not-held`、`secret-not-shareable` |
| 协议 | `invalid-terms`、`obligor-not-party`、`deadline-out-of-range`、`not-a-party`、`unknown-party`、`counter-limit-reached`、`agreement-not-open`、`already-responded` |
| 任务 | `team-busy`、`capability-missing`、`route-unavailable`、`route-closed`、`insufficient-resource`、`draw-limit-exceeded`、`over-capacity`、`participant-unavailable`、`team-not-at-origin`、`task-not-cancellable`、`not-invited`、`invitation-closed` |
| 政策与剧情 | `no-change`、`unknown-policy`、`card-not-draft`、`card-not-triggered`、`card-not-found`、`card-already-triggered`、`invalid-effect`、`campaign-exists`、`unknown-faction`、`world-tick-not-zero` |
| Agent 拒绝理由（`task.respond`、对白意图用） | `danger`、`duty`、`past-breach`、`low-trust`、`lack-resources`、`policy`、`need-guarantee`、`injured`、`busy`、`none` |

## 10. 内容 schema 要点

内容加载器对 [内容包](../game/content-pack.md) 的每个文件做 Zod 校验，另外做以下交叉检查，任何一项失败都拒绝启动：

- 所有 ID 唯一；道路端点、库存点/队伍/群体所在节点、证据位置都指向存在的节点。
- 受控道路的 `controlledBy` 须引用有效派系。AI 党魁与外域 Agent 使用各自的派系 ID。玩家占公社席时由 `player-1` 承担该席的玩家行为。
- 角色 `factionId` 存在；`initialRelations.targetId` 指向存在的主体；`trust ∈ [-2, 2]`。
- 开局与职责委托引用的队伍、库存点都属于委托方派系。
- 剧情卡效果只使用允许的 `kind`。发件署名、传闻引用与实际收件人分别校验。静态署名可以引用未上场名册成员，`to` 只接受有效的收件主体。证据和秘密的 `heldBy` 校验直接获授权的主体。见 [content-pack.md — 序章内容契约](../game/content-pack.md#9-序章剧情卡scenarioswatergate-v1yaml)。
- 名册中的 `agentId` 都是存在的派系或角色，且总数不超过 15。
- 模板与词表覆盖完整（[内容包](../game/content-pack.md) 第 12 节）。
