# 共享 Tool：一次实现，多主体受限注册

> 设计层的工具目录见 [11-agent-actions.md — Agent 职能](../design/gameplay/11-agent-actions.md)。

> 状态：目标。ToolDefinition 维护共享工具，ToolBinding 为各 Agent 配置授权。

## 1. 定义、绑定与执行

工具能力分为定义、注册绑定、执行三个层次。新增角色通常只加数据化 binding，新增能力才增加 definition/executor。岑雁（`human-independent`）与其他角色共用运输工具实现。

| 层 | 拥有什么 | 不承担什么 |
|---|---|---|
| ToolDefinition | 稳定 ID、version、输入/输出 schema、effect、executor 引用 | 某个 Agent 的长期授权与提示词 |
| ToolBinding | agentId、definition 引用、权限收窄、参数约束、预算、viewConstraints | 复制 executor、另选视图实现或扩大身份权限 |
| ToolExecution | 服务端 scope、turn、调用、版本读集、operation 与 receipt | 信任模型传来的 actorId/branchId |

definition registry 由唯一组合根创建；同 toolId/version 只注册一次。binding 可以对多个 Agent 引用同一定义，但各自持有隔离的调用记录与预算。

executor 共享代码与无主体状态的服务；可变执行记录通过 scoped repository 存储，不把“当前 Agent”、最近结果或当前 binding 保存在共享可写单例中。

普通工具无需做成独立 npm package；按职责分文件，executor 复用 query/command ports。模块划分见 [模块责任](../architecture/modules.md) 与 [代码结构](../architecture/code-structure.md)。

## 2. 最小定义契约

~~~ts
interface ToolDefinition {
  readonly toolId: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaRef;
  readonly outputSchema: JsonSchemaRef;
  readonly effect: "query" | "command";
  readonly requiredCapabilities: readonly string[];
  readonly executorId: string;
  readonly commandType?: string;
}

interface ToolBinding {
  readonly bindingId: string;
  readonly agentId: string;
  readonly toolId: string;
  readonly version: string;
  readonly permissionProfile: string;
  readonly constraints: ConstraintSet;
  readonly budgetProfile: string;
  readonly viewConstraints: ViewConstraintSet;
}
~~~

JsonSchemaRef、ConstraintSet 与 ViewConstraintSet 是目标共享契约，不是现有库符号。配置解析时验证 schema 引用、executor、commandType、约束类型与可支持视图；缺任一必需能力则启动失败。

query 表示读取，不得修改世界状态；必要的审计或使用计数由宿主记录。command 必须指向权威 handler，不允许 executor 自己写 aggregate_state。

schema 只描述 Agent 可选参数；agentId、principalId、worldId、branchId、controllerEpoch 与 turnLeaseEpoch 由宿主提供。参数中出现冒充 scope 的字段应被严格 schema 拒绝。

## 3. Binding 与有效权限

有效权限取身份能力、binding 收窄与当前动态授权的交集，再经世界规则裁决。注册了工具，只代表可以尝试调用，不保证任意参数都可执行。

binding 可以限制地点、目标类型、自己受委托的资产、最大数量、可分享受众、调用频率与单次结果预算；不能在 profile 中把角色升级为势力控制器。

执行上下文从已认证任务取得身份，再查该身份有效 binding 与当前 grants。模型的“我是指挥官”文本、另一 NPC 的工具结果或模型选择的 toolId 都不能替代授权。

限制既参与工具 schema 投影和描述，也在调用时强制校验。为模型隐藏选项只是减少误用，最终动态权限仍在服务端检查。

角色权限变化时，旧 schema 不必立即重发也能拒绝越权请求；下一次模型请求使用新工具集，并归档实际生效版本。不可用工具明确返回 forbidden 或 not-ready，不改名伪装成功。

## 4. 首批共用工具

| toolId | effect | 输入与输出重点 |
|---|---|---|
| world.inspect | query | 已知区域/实体引用，返回授权当前投影、版本与证据 |
| route.inspect | query | 起终点，返回已知路径、可达条件与风险来源 |
| task.inspect | query | 有权查看的任务/receipt 引用，分别返回 commandStatus 与适用的 taskStatus |
| conversation.inspect | query | 当前合法会话与窗口，返回受众过滤后的消息，不提供全历史外挂 |
| operation.inspect | query | 当前身份 operationId，返回既有 receipt 与未知结果的核对状态 |
| message.send | command | 目标主体、受约束发送意图/披露引用，由宿主安全生成并裁决后得到消息 receipt |
| information.share | command | 可披露证据引用与受众，产出 InformationShared 或明确拒绝 |
| agreement.propose | command | 条款、对象、期限，产出提案 receipt，不代表双方已签约 |
| agreement.respond | command | 提案引用、接受/拒绝/修改，按权限与条款裁决 |
| asset.dispatch | command | 受委托资产、路线、任务，产出派遣 receipt 与异步任务引用 |
| task.respond | command | 对收到的任务邀请回复参加或拒绝，附拒绝理由 |
| task.cancel | command | 本身份有权取消的任务引用，返回撤销裁决，不保证已完成任务可回滚 |
| policy.set | command | 仅战略 Agent：修改本派系拥有的政策（水闸分配、受控道路状态） |
| decision.submit | —（宿主处理） | 结束本轮决策，提交立场与对白意图；不是世界命令，见 [prompts](prompts.md) 第 2.3 节 |

各工具的输入 schema、对应命令、入模字段与默认工具集见第 13 节。

记忆检索（memory 的 retrieve 操作）由固定检索阶段驱动，不默认提供可任意深挖历史的工具；如未来增加主动回忆工具，所有组必须明确启用并纳入同一记忆/预算实验协议。

decision 只能提发送意图、受约束模板参数与可披露 sourceRefs；message.send 不接受自由文本直发。宿主接续 safe speech/template 管线生成批准 artifact，最终发送 handler 校验 approvedSpeechArtifactRef、目标受众与当前权限后才写入消息；生成/裁决前不能返回“已发送”。information.share 只接受经验证可披露的来源引用，也不能夹带自由文本绕过该流程。

世界 lore 是统一版本的只读内容，按 context 配置注入或通过受限内容 port 获取；不能通过 world.inspect 绕回未被选中记忆策略提供的完整个人关系史。

## 5. 角色授权矩阵

下表是角色类的权限上限模板，实际每次仍取交集。8 名支持者与 4 名 AI 党魁、3 名外域 Agent 不因同属一个名册就获得相同资产或私聊权限。

| 工具组 | 4 名 AI 党魁 | 3 名外域 Agent | 8 名公社支持者 |
|---|---|---|---|
| world/route.inspect | 本派已知区域 | 本种族已知区域 | 个人已知与被授予区域 |
| task/operation.inspect | 自己及受委托任务 | 自己及受委托任务 | 自己参与或可观察任务 |
| conversation.inspect | 当前参与的会话 | 当前参与的会话 | 当前参与的会话 |
| message.send | 可联系主体，仍校验受众 | 可联系主体，仍校验受众 | 可联系主体，禁止冒充派系 |
| information.share | 自己持有且可披露的证据 | 自己持有且可披露的证据 | 自己持有且可披露的证据 |
| agreement.propose/respond | 本派授权条款 | 本种族授权条款 | 个人承诺；组织条款需委托 |
| asset.dispatch | 本派可用资产 | 本种族可用资产 | 无默认权；按角色职责委托 |
| task.respond | 不适用（战略 Agent 不会被邀请） | 不适用 | 收到的邀请 |
| task.cancel | 自己有撤销权的任务 | 自己有撤销权的任务 | 自己有撤销权的任务 |
| policy.set | 本派系拥有的政策 | 本种族拥有的政策 | 无 |

矩阵适用于 Agent。公社玩家的水闸与广播权限由玩家命令网关和规则处理器裁决。三个外域真人运营席位也走同一命令管线。参见 [rules.md — 政策](../game/rules.md#8-政策)、[api.md — 玩家命令权限](../architecture/api.md#31-玩家命令权限)、[operations.md — 运营控制](../platform/operations.md)。

研究评估器没有 gameplay binding；读取评估证据走独立研究权限。全平台 15 个活跃 gameplay 身份上限与工具并发/调用限额分别管理。

## 6. 数据化模板与组件复用

permissionProfile、budgetProfile 和 constraint preset 是复用数据。角色装配将 selector 解析为固定 agentIds 后冻结。禁止在 executor 写 `if (agentId === "human-independent")` 决定功能分支。

例如“可派遣自己的护送队”由 delegated-assets 约束读取当前 grants；岑雁与其他角色引用同一个 asset.dispatch，只是被委托资产集合不同。

新增角色时，先定义身份/职责，再选择 binding 模板并收窄具体限制，然后校验能力，最后生成 effective tool manifest。无需新增同义工具名称或复制实现。

新增工具时，先定义输入/输出及 effect，再实现通用 executor 并注册一次，然后新增契约验证，最后按需要引用 binding；世界命令先有规则 handler，才可绑定 command 工具。

约束组件应先复用简单的 schema/谓词，如 owned-or-delegated、known-location、audience-subset、quantity-cap；不设计可执行配置语言或任意脚本表达式。

## 7. 唯一执行管线

1. 从已认证 turn 恢复 scope、controllerEpoch、turnLeaseEpoch 和 profileHash。
2. 按当前 binding 查 definition/executor；执行输入 schema、约束与有效权限校验。
3. 检查剩余调用/费用/时间预算，持久化 toolCallId、参数 hash 与 admitted 状态。
4. query 读取冻结输入允许的授权投影，并记录实际版本读集；command 先固定 operationId/commandId。
5. executor 通过 query port 或标准 command handler 执行；最终 guard 位于 handler 内，插件 hook 无权取消。
6. 保存完整原始结果、错误、receipt 和执行状态，再执行受限 toolView 转换。
7. 校验输出 schema、保密标签、引用与预算，记录实际入模视图；配对写入 tool result。

query executor 的世界数据源固定为 inputFrontier=F 的授权 read view，首版不允许在途推进 F。主动侦察作为 command 执行，完成后产生的新世界观察进入下一 turn；write 则按提交当下的 authority 和版本 gate 裁决，允许产生冲突。

本 turn 已执行操作的 receipt 可通过调用结果及 operation.inspect 作为 F 后的有界因果追加，保存 toolCallId、operationId 与 acceptedEventIds。它只报告该操作的确认/状态，不携带新的周边情报，不回填冻结 memory revision，不变成刷新全世界的旁路。

## 8. 幂等、副作用与未知结果

稳定关联由 `(worldId, branchId, agentId, operationId)` 确定 `commandId + payloadHash`。operationId 由宿主在首次接受操作时生成并持久化；模型重试、worker 恢复沿用该映射。

世界 handler 以主体和 commandId 去重：相同请求返回原 receipt，相同键不同 payload 报 idempotency-conflict。receipt、事件、状态、outbox 与确定性 jobs 在一个 SQLite 事务提交。

结果使用三组字段，禁止复用一个 status：ToolResult.executionStatus=ok/error/unknown；receipt.commandStatus=accepted/rejected 且提交后不可变；可选 taskStatus=pending/running/completed/failed/cancelled 来自独立任务投影。ok 只表示网关取得确定合法响应，可以包含命令 rejected；unknown 表示执行结果待核验，不是业务拒绝。

网络超时或取消信号不证明命令未发生。先 operation.inspect；确认不存在 receipt 时，也只能以同 commandId/payload 重送。首版副作用只落权威世界服务，不直接调用外部有副作用 API。

receipt 仍未知时不允许重新派遣另一份资产；返回 executionStatus=unknown，等待可核验状态。任务已接受但未完成则为 executionStatus=ok、commandStatus=accepted、taskStatus=pending，不能混为未知。新业务意图生成新 operationId，并检查旧任务的资源占用与撤销规则。

同 turn 的最终 actionProposals 引用工具已提交的 receipt；Runtime 不再执行同一个动作。重复 toolCallId 重放返回原结果，不重复记账或强化记忆。

## 9. Tool call/result 配对与恢复

每个模型工具调用具有稳定 toolCallId、模型 attempt 引用、definition/binding 版本与 operation 引用。调用结算后只有一个有效 result，重试 attempt 可以保留但不形成多个模型历史节点。

供应商原始 callId 作为协议字段保存，宿主另建 scoped toolCallId；只有 runtime 选定的有效模型 attempt 可以进入 admitted，晚到替代响应不生成第二组操作。

错误与取消也产生合法 result；结果未知显式写 executionStatus=unknown 并带查询引用。再次发起模型请求前补齐所有已记录调用，不允许孤立 tool call 或错配另一调用的结果。

进程崩溃恢复先核对 admitted/dispatched/settled 状态，再查 receipt。已提交工具结果可直接复用；query 如需重新执行，必须使用原冻结投影或记录新检查点，不能冒充原响应。

同一模型批次不意味着所有命令原子成功；涉及同一资源的 command 仍由世界单写者裁决，顺序与冲突必须留痕。

## 10. 原始结果与模型视图

完整合法 executor 输出进入受限 artifact；toolView=full/structured/brief 生成单独不可变 artifact。保存二者 hash、来源映射、删减原因与实际 token，不能覆盖原件。

tool-view 实现仅由 Agent profile 的槽选择；binding 的 viewConstraints 只给出字段、条数与 token 硬上限，不另选 full/structured/brief。槽策略在这些上限内工作，冲突返回明确错误，不以更宽的配置覆盖限制。

三种视图均保留状态、错误原因、必要 receipt 与证据引用；brief 按引用展开也要再次鉴权、计费、记录输入 frontier。toolView 只能减少/重排已获准信息，不能新增未经授权内容。

共享 executor 不代表共享结果缓存。缓存必须包含 scope、授权版本、输入 frontier、definition 版本和参数 hash；读取前仍检查当前访问权，禁止用另一 Agent 的私密结果命中缓存。

工具文本作为数据块进入模型，不获得系统指令权。对白 context 只取可对目标受众披露的工具视图，详见 [压缩与工具视图](compression-and-tool-view.md)。

## 11. 观测、扩展与验收

每次调用记录：definition/binding、effective 权限与约束、原始参数、模型可见 schema、实际读集、各 guard 结果、排队/执行耗时、原始/视图 artifact、receipt 与预算。

控制台可以比较相同工具在不同主体下的 effective 约束；比较算法时固定 bindings，避免把“更多工具或更宽权限”当成记忆优势。配置归属见 [配置体系](../platform/configuration.md)。

- 同一 definition 同时绑定两个 Agent，验证实现只一份，结果和可写状态互相隔离。
- 伪造 scope、跨角色 receipt、过期 grant、超额参数和隐藏选项调用均被拒绝。
- 在提交后 ack 前中断，再重试，验证只出现一次资源变更与同一 receipt。
- 模型批次含成功、失败、取消工具时，验证每个 callId 的结果配对完整。
- 将 full 切为 brief，只改变入模视图，不改变执行事实、错误或 receipt。
- 卸载 binding 后不可继续调用；definition 的 disposer 不移除仍被其他有效 binding 使用的实现。

实现与运行验证按 [可观测性](../platform/observability.md)、[事件事务](../architecture/events-and-state.md) 和 [实验评估](../platform/evaluation.md) 留存证据。

## 12. 参考边界

借鉴 deepseek-harness 的 [scoped registry 与最终 guard](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/index.ts) 和 [工具生命周期事件](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tools/src/events.ts)。definition/binding 分层、游戏资产约束、operation receipt 和未知结果协议是本平台的目标设计。

可信内置插件仍运行于同一 Node 进程；scope 和 manifest 是工程约束，不是恶意代码沙箱。插件装载、能力声明与释放统一见 [插件规范](../architecture/plugins.md)。

## 13. 首版实现规格

### 13.1 工具定义

模型看到的工具名是 `toolId` 把点换成下划线（`world.inspect` → `world_inspect`），规则见 [模型传输](model-transport.md) 第 6 节。输入 schema 用 Zod 定义，生成后按 [模型传输](model-transport.md) 第 7 节清洗：所有字段都必须出现，可选字段用 `null` 表示，**不使用判别联合与 record**，而是用“所有可能字段都列出、用不到的填 null”的平铺对象。工具网关把调用转成命令前做两件事：删除值为 null 的字段；按 `taskType` 或 `kind` 只保留该类型需要的字段，再用命令自己的严格 schema（[领域模型](../architecture/domain-model.md) 第 5 节）校验。校验失败返回错误结果 `invalid-params`，不发命令。

```ts
const Cargo = z.object({ supply: z.number().int(), energy: z.number().int(), medical: z.number().int() });

const DispatchParams = z.object({            // flat: fields that the chosen taskType does not use must be null
  fromStockpileId: z.string().nullable(), toStockpileId: z.string().nullable(), cargo: Cargo.nullable(),   // transport
  roadId: z.string().nullable(), durationTicks: z.number().int().nullable(),                              // escort
  groupId: z.string().nullable(), toNodeId: z.string().nullable(), medicalStockpileId: z.string().nullable(), // rescue
  energyStockpileId: z.string().nullable(), supplyStockpileId: z.string().nullable(),                     // repair
  nodeId: z.string().nullable(),                                                                          // scout
});

const ToolTerm = z.object({                   // flat version of the Term union; unused fields are null
  kind: z.enum(["deliver", "escort", "rescue", "repair-relay", "share-evidence", "grant-passage", "water-allocation", "delegate"]),
  obligorId: z.string(),
  resource: z.enum(["supply", "energy", "medical"]).nullable(), amount: z.number().int().nullable(),
  fromStockpileId: z.string().nullable(), toStockpileId: z.string().nullable(),
  byTick: z.number().int().nullable(), untilTick: z.number().int().nullable(),
  roadId: z.string().nullable(), groupId: z.string().nullable(),
  evidenceId: z.string().nullable(), toPrincipalId: z.string().nullable(),
  granteeFactionId: z.string().nullable(), policy: z.enum(["harbor-first", "rotation", "orchard-first"]).nullable(),
  granteeId: z.string().nullable(), teamIds: z.array(z.string()).nullable(), stockpileId: z.string().nullable(), maxDraw: Cargo.nullable(),
});
```

| toolId | 输入 | 执行 | 入模字段 `viewFields` | 给模型的说明（`toolDescriptions`） |
|---|---|---|---|---|
| `world.inspect` | `{ nodeId: string \| null }` | 读取冻结 frontier 时的 `AgentWorldView`：`nodeId` 为 null 时返回概况，否则返回该节点的已知情况 | `asOfTick`、`meters`、`allocation`、`roads`（列表）、`characters`（列表）、`stockpileLevels` | 查看你所知道的局势；可指定一个地点。只返回你已知的信息，可能已经过时。 |
| `route.inspect` | `{ fromNodeId, toNodeId, teamId: string \| null }` | 用该 Agent **已知**的道路状态与本派系通行许可求路径，不读实时真值 | `path`、`travelTicks`、`risks`、`blockedRoads` | 按你所知的道路情况查询两地之间的路线与风险。 |
| `task.inspect` | `{ taskId: string \| null }` | 自己派遣、参与或受邀的任务；null 时列出全部 | `taskId`、`taskType`、`commandStatus`、`taskStatus`、`departTick`、`nominalCompletionTick`、`participants` | 查看你派遣、参与或受邀的任务状态。 |
| `conversation.inspect` | `{ conversationId: string \| null, limit: number }` | 受众包含自己的发言，条数不超过 profile 的 `historyTurns`（因此 M0 的 `baseline-current` 返回空列表） | `lines`（列表） | 查看你参与的对话里最近的发言。 |
| `operation.inspect` | `{ operationId }` | 查询本身份操作的 receipt | `receipt`、`taskStatus` | 查询你本轮发出的某个操作是否已被受理。 |
| `message.send` | `{ to: string[], intent: { kind, tone, reasonCode, subjectRef: string \| null, factRefs: string[] } }` | 先走对白流程生成并校验正文，再提交 `speech.commit`（channel message；`to` 为 `["public"]` 时为 broadcast，需要 broadcast 权限） | envelope + `messageId`、`deliverAtTick` | 给某人发一条消息。只描述想表达的意图和依据，正文由系统生成。 |
| `information.share` | `{ evidenceId, audience: string[] }` | 命令 `information.share` | envelope + `shareId`、`deliverAtTick` | 把你持有的一条证据交给指定对象。 |
| `agreement.propose` | `{ parties: string[], terms: ToolTerm[], expiresInTicks: number \| null }` | 命令 `agreement.propose` | envelope + `agreementId` | 提出一份协议。你提出即视为你已同意，其他当事人接受后生效。 |
| `agreement.respond` | `{ agreementId, response: "accept" \| "reject" \| "counter", counterTerms: ToolTerm[] \| null }` | 命令 `agreement.respond` | envelope + `agreementStatus` | 接受、拒绝或还价一份发给你的协议提案。 |
| `asset.dispatch` | `{ taskType, teamId, invitees: string[], params: DispatchParams, departAfterTicks: number \| null }` | 命令 `task.dispatch` | envelope + `taskId`、`departTick` | 派遣你有权调动的队伍执行运输、护送、救援、修复或侦察，可以邀请角色同行。 |
| `task.respond` | `{ taskId, response: "accept" \| "decline", reasonCode }` | 命令 `task.respond` | envelope | 回复一项任务邀请：参加或拒绝，并说明理由类别。 |
| `task.cancel` | `{ taskId }` | 命令 `task.cancel` | envelope | 撤销一项由你派遣的任务。 |
| `policy.set` | `{ key, value }` | 命令 `policy.set` | envelope + `oldValue`、`newValue` | 修改你所在派系掌管的政策（水闸分配或受控道路的通行状态）。 |
| `decision.submit` | 见 [prompts](prompts.md) 第 2.3 节 | 宿主结束工具循环 | — | 结束本轮并提交你的决定。对外说话只填意图，不写台词。 |

envelope 指 `executionStatus`、`commandStatus`、`reasonCode`、`receiptId`、`operationId`、`resultRef`（以及有任务时的 `taskStatus`）。

请求构建时按 binding 收窄 schema：`asset.dispatch.teamId` 写成该 Agent 可派遣队伍的 `enum`，`policy.set.key` 写成该 Agent 拥有的政策键的 `enum`，`information.share.evidenceId` 写成持有证据的 `enum`，`task.respond.taskId` 写成待回复邀请的 `enum`。**收窄后 enum 为空时，本 turn 不提供该工具**（例如没有任何证据的角色不会看到 `information_share`）。收窄结果在 turn 冻结时确定，同一工具循环内不变。

### 13.2 binding 模板与工具集

```yaml
# config/toolsets/character-default.yaml
schemaVersion: 1
toolsetId: character-default
tools:
  - { toolId: world.inspect,        version: "1", permissionProfile: self-known,         budgetProfile: query,   viewConstraints: { maxListItems: 5, maxTokens: 300 } }
  - { toolId: route.inspect,        version: "1", permissionProfile: self-known,         budgetProfile: query,   viewConstraints: { maxListItems: 5, maxTokens: 250 } }
  - { toolId: task.inspect,         version: "1", permissionProfile: self-known,         budgetProfile: query,   viewConstraints: { maxListItems: 5, maxTokens: 300 } }
  - { toolId: conversation.inspect, version: "1", permissionProfile: self-known,         budgetProfile: query,   viewConstraints: { maxListItems: 8, maxTokens: 400 } }
  - { toolId: operation.inspect,    version: "1", permissionProfile: self-known,         budgetProfile: query,   viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: message.send,         version: "1", permissionProfile: message-principals, budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: information.share,    version: "1", permissionProfile: share-held,         budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: agreement.propose,    version: "1", permissionProfile: agreement-personal, budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: agreement.respond,    version: "1", permissionProfile: agreement-personal, budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: asset.dispatch,       version: "1", permissionProfile: dispatch-delegated, budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: task.respond,         version: "1", permissionProfile: invited-only,       budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
  - { toolId: task.cancel,          version: "1", permissionProfile: cancel-own,         budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }
```

其余工具集都写成完整文件（不支持继承），与 character-default 的差别：

| 工具集 | 使用者 | 差别 |
|---|---|---|
| `character-broadcaster` | 伊诺 | `message.send` 的 permissionProfile 为 `message-principals-or-public` |
| `strategic-default` | 4 名 AI 党魁和 3 名外域 Agent | 去掉 `task.respond`。`agreement.propose`、`agreement.respond` 用 `agreement-faction`，`asset.dispatch` 用 `dispatch-faction`。增加 `{ toolId: policy.set, version: "1", permissionProfile: policy-owner, budgetProfile: command, viewConstraints: { maxListItems: 1, maxTokens: 150 } }` |

| permissionProfile | 调用前检查（不通过时返回 executionStatus=error、reasonCode=no-authority，不发命令） |
|---|---|
| `self-known` | 只读自己的视图 |
| `message-principals` / `message-principals-or-public` | `to` 中每个主体都在名册内或是玩家；后者还允许 `["public"]` |
| `share-held` | 持有该证据的知识授权；秘密 ID 一律拒绝 |
| `agreement-personal` / `agreement-faction` | 自己必须是当事人；`agreement-personal` 只检查本次提交的新条款：propose 的 `terms` 或 counter 的 `counterTerms` 中，资源类条款义务人只能是自己；accept/reject 不提交新条款，不检查已有协议中他方承担的资源义务。最终接受权限与履约约束仍由规则处理器校验 |
| `dispatch-delegated` / `dispatch-faction` | 队伍在自己的委托内 / 属于本派系 |
| `invited-only` | 自己是该任务的受邀者 |
| `cancel-own` | 自己是派遣者 |
| `policy-owner` | 政策键属于本派系，可设置的键见 [rules.md — 政策](../game/rules.md#8-政策) |

| budgetProfile | 每 turn 上限 |
|---|---|
| `query` | 同一工具最多 3 次 |
| `command` | 同一工具最多 2 次 |

所有工具合计受 profile 的 `maxToolCallsPerTurn` 与 `maxToolCallsPerRound` 约束（默认 8 与 3），一轮内多个调用的执行顺序见 [运行时](runtime.md) 第 13.3 节。这些检查只是提前拒绝，最终权限仍由规则处理器裁决。
