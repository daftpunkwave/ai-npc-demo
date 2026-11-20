# 运营控制台、保存与三势力席位

> 本文定义 Demo 单人运营。多人席位、托管与权威设计见 [02-authority-economy-fairness.md — 权威与公平](../design/multiplayer/02-authority-economy-fairness.md)。

> 状态：部分实现。服务端已提供玩家暂停、继续、存档、恢复与重新开局。三势力席位、剧情运营接口和控制台页面为目标。本文规定运营与故障处理。参见 [00-scope-and-invariants.md — 序章范围](../00-scope-and-invariants.md)、[api.md — HTTP 与 WebSocket API](../architecture/api.md)、[two-endpoints.md — 双端部署](../architecture/two-endpoints.md)。

## 1. 操作身份

| 身份 | 允许操作 | 不自动获得的能力 |
|---|---|---|
| player | 一个 campaign 内的玩家授权命令、暂停/保存/恢复 | 他人秘密、模型原文、势力战略控制权 |
| operator | 获授权的事件卡发布、势力席位接管、运行维护、模型挂载 | 全局真相、角色私密会话、任意数据库写入 |
| researcher | 按授权查询 trace、真值证据、配置与实验 | 正式世界行动、替 NPC 向外传播秘密 |
| evaluator | 在研究范围读取规定材料并评分 | gameplay 工具、世界写权限、自主角色身份 |

首版始终只有一个玩家身份参与一个正式世界。运营人员可以管理三个非人类势力（巡裔、根庭、泊星者）的战略席位，这是可选后台控制，不是增加三个游戏玩家，也不额外创建 Agent。控制台角色只是最小权限集合，具体 API 仍按会话、scope 与期望 epoch/version 校验。

权限由服务端认证会话、角色和资源 scope 决定；隐藏按钮、单独网页或本机访问都不是授权。研究真值、玩家已知内容、席位已知内容分别返回，不合并为一个全知页面供所有入口复用。

控制台页面由模块贡献：`console.faction-ops.standard` 管理三势力席位，`console.scenario-editor.standard` 管理事件卡，`console.health.standard` 显示运行总览，`console.module-admin.standard` 管理装配。替换某个页面不改变对应服务端能力或审计记录。

## 2. 时钟与运行状态

运行状态从 `running` 经 `pausing` 进入 `paused`；恢复从 `paused` 经 `resuming` 回到 `running`；单步从 `paused` 经 `stepping` 回到 `paused`。保存和分支切换只在受控暂停点进行。每次状态转换记录操作者、原因、前后状态和幂等操作 ID。

当前暂停与继续的幂等结果和时钟状态分两次提交。若两次提交之间进程退出，原请求重试可能收到版本冲突。见 [IMPLEMENTATION-STATUS.md — 公共契约迁移](../IMPLEMENTATION-STATUS.md#25-公共契约迁移)。

`worldTick` 是持久逻辑时间。运行时按部署配置推进；暂停和默认离线期间不推进，不计算离线战争或按真实天数衰减记忆。请求耗时和控制租约的服务时间独立记录，不参与剧情时间。

单步推进仅从 `paused` 发起，进入 `stepping` 后只允许本步范围内的规则任务、由实验运行器按脚本注入的当前 tick 命令和有界决策提交（脚本命令仍按其主体校验权限），按设定推进确定数量的 tick、结算到期任务并收集触发。需要模型时异步完成本步工作，再回到 `paused`；不能把一次单步变成无限事件或模型循环。

暂停期间允许查询、编辑草稿、查看运行状态和生成快照；改变世界的玩家或运营 command 返回明确的 `paused` 状态。需要新事件或导演行动时先恢复或受控单步，不能在后台绕过时钟。

## 3. 暂停与一致保存

1. 以期望运行版本申请暂停，关闭新变更命令和新自主 turn 的入口。
2. 停止逻辑时钟，递增必要的 turn fencing；在途模型输出标为取消或过期，不能在暂停后提交新行动。
3. 排空已进入的短事务；已提交 command 保留效果，未提交请求不确认成功。
4. 固定世界 frontier；继续完成该 frontier 必需的即时记忆投影和已到期派生整理，再冻结状态发布。等待有上限。
5. 确认世界、观察、memory revision/水位、jobs、控制记录和 manifest 来自同一逻辑恢复点。
6. 保存一致快照及校验信息，记录 snapshotId、状态版本和保留策略；原 branch 保留。

保存包含未完成行动、资源预留、timer、待处理 trigger、控制 epoch、记忆与索引版本、随机源状态和内容/模型/工具配置引用。只复制世界表不能称为可恢复存档。

保存使用 SQLite 一致性备份能力或等价受控流程，不在写入中复制单个数据库文件。artifact 的内容引用必须可解析；密钥不进入快照，保存 credentialRef 及配置修订即可。

必需水位未完成、状态导出失败或备份校验失败时返回失败并保留原分支。可以让世界保持 paused 等待重试；不能跳过记忆保存后展示“全部保存成功”。

## 4. 恢复与切换在线分支

恢复先做 dry-run：检查快照完整性、内容/规则/模块/状态版本、模型挂载、工具 binding、存储和资源配额。缺少迁移路径则拒绝，不自动清库或替换模型。

从快照建立后继 branch/run，验证状态与水位，重新取得任务租约并生成新 fencing 代次。旧进程、旧 turn 或旧控制者的晚到请求不能对新 branch 生效。

配额 dry-run 按切换后的净激活数计算，不把即将释放的旧在线身份重复计数。准备成功后，在同一事务中释放旧分支的激活配额、预留新分支配额并原子切换正式世界别名；失败全部回滚。保证同一时刻仅一个在线权威世界；随后按逻辑 tick 恢复待办规则任务和有效触发。历史里已完成操作不能再次扣资源或再次强化关系。

恢复不回写旧历史。玩家选择旧存档时创建新的后继分支，保留原分支及差异；如果研究对比使用该存档，每个实验 run 仍需独占 branch。

网络断开不立即等同于退出 campaign：经过配置的会话宽限再自动暂停，重连恢复授权投影与游标。首版无离线持续战争，自动暂停与手动恢复事件都进入审计。

## 5. 三个非人类势力的真人导演席位

席位仅对应 `species-fauna`（巡裔）、`species-flora`（根庭）、`species-extraterrestrial`（泊星者）。每席位独立选择 agent/human；同一操作员可获准持有多个席位，但每席位最多一个有效 controller lease。这是服务端控制台的三势力剧情运营入口，不新增播放器或 Agent。

接管保留原 agentId、所属资源、历史、记忆和合法任务，身份数量不变。human 模式停止该战略主体新增自主决策，其他角色和派系继续各自运行；非人类势力角色不因此被直接操控。

接管请求包含期望 controllerEpoch、目标模式、原因、幂等键和席位权限。服务端在控制事务中递增 epoch、撤销旧 lease、确立新 lease，并通过控制事件通知 runtime。

在途 agent 候选命令、排队工具调用和模型池队列项在执行/提交前再次核对 epoch。已经提交的世界任务继续按规则结算；接管不倒退既有事实。输出取消后仍须 fencing，不能仅依赖 AbortSignal。

席位使用与 Agent 相同的标准 command 和规则校验，不允许直接编辑世界表。操作界面仅提供该席位已知信息和授权工具；席位不能用 researcher 真值接口替自己作战。

归还 agent 时记录交接摘要，摘要仅含该主体合法获知材料；固定当前状态与 controllerEpoch 后重新排队。不能把操作者的全局调试笔记直接写入其记忆。

租约过期先使旧控制者失效，按配置暂停该席位的自主提案并提示重新接管或显式交还 agent；不默认在无人确认时换控制模式。租约服务时间和剧情 worldTick 分开计量。

## 6. 事件卡草稿、发布与补偿

事件卡包含 ID/版本、前置条件、受众、允许效果/命令、延时、次数限制、幂等键和补偿路径，具体游戏约束见 [systems](../game/systems.md)。

| 操作 | 行为 | 验证 |
|---|---|---|
| 编辑草稿 | 只修改未发布内容版本 | 内容 schema、角色/地图引用、受众与命令范围 |
| 预演 | 在隔离分支验证条件与结果 | 记录输入、差异和实验资源配额 |
| 发布 | 冻结内容版本，通过标准入口登记规则任务 | 当前世界版本、发布权限、幂等、触发次数 |
| 撤回待生效卡 | 取消尚未执行的合法任务 | 保留撤回事实，检查已执行部分 |
| 补偿已生效卡 | 发布有来源的新补偿事件/命令 | 按规则处理资源、任务与关系后果 |

已发布历史不能直接覆盖或删除。普通修订产生新内容版本，修正已生效结果需要补偿；无法自然补偿时明确列出限制，不能让模型宣称一切恢复原状。

必要调试覆盖必须产生 ScenarioOverride 与污染标记。正式实验按协议判 invalid 或另组报告，不能把人为强制的好结果当成策略效果。

## 7. 研究真值与扮演隔离

控制台研究视图可授权查看世界真值、完整请求/响应、秘密来源和不同视图差分。player/席位客户端只接收自己的投影，不能共用会携带真值字段的缓存或导出文件。

同一人兼任研究员和导演时切换显式会话/视图，禁止把研究数据自动注入扮演界面。系统无法阻止人类记住已看过的秘密；正式盲测应分离人员或先固定输入脚本，并记录知情暴露与污染判定。

研究导出按授权脱敏，保留引用以定位来源。原文权限不自动附带传播许可，研究员查询不会生成 NPC 获知事件。观测保留与查询规则见 [observability](observability.md)。

## 8. 目标请求 API 与通用规则

接口清单、载荷与角色权限见 [API](../architecture/api.md)：玩家的暂停、继续、存档与恢复在第 3 节，席位、时钟、存档与运行申请在第 5.3 节，剧情卡在第 5.4 节。

玩家入口与控制台入口都在服务端同一端口；路由前缀区分权限域，不能因为控制台与玩家同源就复用玩家 scope。相同幂等键和 payload 返回原 receipt；相同键不同 payload 返回冲突。accepted 只表示已接纳，不等于异步任务 completed。服务端决定 principal/scope，不能信任模型或客户端自报授权身份。

错误至少区分 forbidden、validation、paused、version-conflict、stale-controller、stale-turn、not-ready、budget-exhausted、plugin-failed。失败保留 cause/traceId，客户端不以无限重试掩盖故障。

## 9. 故障与配额操作

| 故障 | 处理与证据 |
|---|---|
| 模型超时/拒绝/协议错误 | 有限重试，保存全部 attempt；严格实验失败，在线仅允许预声明且有标识的 fallback |
| memory/感知必需阶段失败 | 隔离主体队列并显示原因，不切换 memory.none 冒充成功 |
| 世界事务失败 | 不返回成功；相同 commandId 重试，无半次资源扣除 |
| outbox/记忆积压 | 显示 not-ready，限制新任务；水位未达不能进入有效评分 |
| 重启/租约过期 | 恢复持久 jobs，重新认领并 fencing；旧结果不能重复提交 |
| artifact 写入失败 | 保留错误并标记观测完整性；必需证据缺失的实验无效 |

在线与实验活动 gameplay 身份共用 **15** 上限。满员时先暂停正式世界、保存在线实例并释放名额，再逐分支实验；结束后释放实验实例再恢复在线。只暂停画面而不释放实例不产生新配额。

运营页面的模块可替换，但暂停/保存/接管/发布的服务端语义与审计不可替换；替换页面不得绕过过期 checkpoint、引用了过期 epoch 的 handover 或未校验的发布。恢复、接管和发布的并发/故障验收见 [roadmap-and-acceptance](../delivery/roadmap-and-acceptance.md)。

## 10. 在线世界的生命周期（首版）

本节给出首版目标生命周期。当前默认名册、激活配额与席位契约的进度见 [IMPLEMENTATION-STATUS.md — 总览](../IMPLEMENTATION-STATUS.md#1-总览)。

| 时机 | 服务端行为 |
|---|---|
| 第一次启动（数据库里没有 `world_aliases('online')`） | 创建 world（内容包 `earth-2964-v1`）、一个 `kind = online` 的分支（时钟 `paused`、`worldTick = 0`）、一个 `mode = live` 的 run，其 RunSpec 取 `config/runs/online-default.yaml`，并用环境变量 `NPC_ASSEMBLY`、`NPC_MODEL_LAYOUT`、`NPC_ROSTER` 覆盖其中的 `moduleAssemblyRef`、`modelLayoutRef`、`rosterRef`；`seed` 在此时随机生成并写入 RunSpec 与 manifest；`world_aliases('online')` 指向该分支 |
| 之后每次启动 | 沿用在线别名指向的分支与 run；时钟一律置为 `paused`（离线不推进），由玩家或运营手动继续 |
| `campaign.start` 被接受 | 在线分支写入 campaign 与初态；按名册激活 Agent（`agent_activations` 置为 active，计入 15 的配额，配额不足时命令被拒绝，原因码 `budget-exhausted`） |
| 玩家“重新开局” | `POST /api/v1/campaign/reset`：先存一个快照，再创建新的空在线分支与新的 live run，旧分支设为 archived；玩家随后重新选择开局 |
| 从存档恢复 | 见第 4 节；恢复出的后继分支沿用原 live run 的 RunSpec 与 seed，生成新的 run 记录，并按名册重新激活 Agent |

`config/runs/online-default.yaml`：

```yaml
schemaVersion: 1
id: online-default
moduleAssemblyRef: local-slg-standard-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: standard-15
modelLayoutRef: shared-model-layout-v1
player: { principalId: player-1, factionId: null }   # chosen by campaign.start
mode: live
initialState: { kind: cold-start }
variant: null
script: null
clock: { kind: realtime }
budget: { maxTokens: null, maxCost: null }
failurePolicy: online-fallback
```

模板只保存引用，不写 `seed`：首次启动由宿主生成随机 seed，并把实际装配引用、名册、模型布局与 seed 写入 RunSpec；同一时刻冻结 manifest（含模块解析配置、`contentVersion` 与上述摘要）。之后每次启动都读取 `world_aliases('online')` 指向的已冻结 run，不回写当前入参。

在线世界默认使用 `online-fallback`（允许已声明的降级并标记），实验 run 默认使用 `strict`；两者的区别见 [运行时](../agent/runtime.md) 第 13.3 节。

### 10.1 重置开发数据

在线 run 冻结的 `contentVersion` 与当前内容包不一致时，服务端在监听前拒绝启动。正式发布前，可以删除开发数据后重新开局。

1. 停止服务，删除 `NPC_DATA_DIR` 指向的 Demo 开发数据目录（默认 `./data`）。该目录包含开发存档和自动生成的本地令牌。
2. 执行 `pnpm dev:server`。服务端使用当前内容包重新建库并创建在线世界和 run。
