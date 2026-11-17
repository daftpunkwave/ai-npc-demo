# 共享 Tool：一次实现，多主体受限注册

> 状态：待实现规范。ToolDefinition 是实现目录，ToolBinding 是 Agent 授权装配；工具实现不随 Agent 数量复制。

## 1. 两层设计

工具能力分为定义、注册绑定、执行三个层次。新增角色通常只新增数据化 binding；新增能力才增加 definition/executor。不存在 npc-cenyan 的专用运输实现与其他角色的另一份相同实现。

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

有效权限 = 身份能力 ∩ binding 收窄 ∩ 当前动态授权，再经世界规则裁决。注册了工具，只代表可以尝试调用，不保证任意参数都可执行。

binding 可以限制地点、目标类型、自己受委托的资产、最大数量、可分享受众、调用频率与单次结果预算；不能在 profile 中把角色升级为种族控制器。

执行上下文从已认证任务取得身份，再查该身份有效 binding 与当前 grants。模型的“我是指挥官”文本、另一 NPC 的工具结果或模型选择的 toolId 都不能替代授权。

限制既参与工具 schema 投影和描述，也在调用时强制校验。为模型隐藏选项只是减少误用，最终动态权限仍在服务端检查。

角色权限变化时，旧 schema 不必立即重发也能拒绝越权请求；下一次模型请求使用新工具集，并归档实际生效版本。不可用工具明确返回 forbidden/unavailable，不改名伪装成功。

## 4. 首批共用工具

| toolId | effect | 输入与输出重点 |
|---|---|---|
| world.inspect | query | 已知区域/实体引用 → 授权当前投影、版本与证据 |
| route.inspect | query | 起终点 → 已知路径、可达条件与风险来源 |
| task.inspect | query | 有权查看的任务/receipt 引用 → 分别返回 commandStatus 与适用的 taskStatus |
| conversation.inspect | query | 当前合法会话与窗口 → 受众过滤后的消息，不提供全历史外挂 |
| operation.inspect | query | 当前身份 operationId → 既有 receipt 与未知结果的核对状态 |
| message.send | command | 目标主体、受约束发送意图/披露引用 → 宿主安全生成与裁决后的消息 receipt |
| information.share | command | 可披露证据引用与受众 → InformationShared 或明确拒绝 |
| agreement.propose | command | 条款、对象、期限 → 提案 receipt，不代表双方已签约 |
| agreement.respond | command | 提案引用、接受/拒绝/修改 → 权限与条款裁决 |
| asset.dispatch | command | 受委托资产、路线、任务 → 派遣 receipt 与异步任务引用 |
| task.cancel | command | 本身份有权取消的任务引用 → 撤销裁决，不保证已完成任务可回滚 |

memory.retrieve 由固定检索阶段驱动，不默认提供可任意深挖历史的工具；如未来增加主动回忆工具，所有组必须明确启用并纳入同一记忆/预算实验协议。

decision 只能提发送意图、受约束模板参数与可披露 sourceRefs；message.send 不接受自由文本直发。宿主接续 safe speech/template 管线生成批准 artifact，最终发送 handler 校验 approvedSpeechArtifactRef、目标受众与当前权限后才写入消息；生成/裁决前不能返回“已发送”。information.share 只接受经验证可披露的来源引用，也不能夹带自由文本绕过该流程。

世界 lore 是统一版本的只读内容，按 context 配置注入或通过受限内容 port 获取；不能通过 world.inspect 绕回未被选中记忆策略提供的完整个人关系史。

## 5. 角色授权矩阵

下表是角色类的权限上限模板，实际每次仍取交集。12 个角色不因同属 character 就获得相同资产或私聊权限。

| 工具组 | 5 人类战略 Agent | 3 非人类势力战略 Agent | 12 角色 Agent |
|---|---|---|---|
| world/route.inspect | 本派已知区域 | 本种族已知区域 | 个人已知与被授予区域 |
| task/operation.inspect | 自己及受委托任务 | 自己及受委托任务 | 自己参与或可观察任务 |
| conversation.inspect | 当前参与的会话 | 当前参与的会话 | 当前参与的会话 |
| message.send | 可联系主体，仍校验受众 | 可联系主体，仍校验受众 | 可联系主体，禁止冒充派系 |
| information.share | 自己持有且可披露的证据 | 自己持有且可披露的证据 | 自己持有且可披露的证据 |
| agreement.propose/respond | 本派授权条款 | 本种族授权条款 | 个人承诺；组织条款需委托 |
| asset.dispatch | 本派可用资产 | 本种族可用资产 | 无默认权；按角色职责委托 |
| task.cancel | 自己有撤销权的任务 | 自己有撤销权的任务 | 自己有撤销权的任务 |

玩家选择五个人类派系之一，改变开局关系、已知信息和有限授权，不直接继承该派战略 Agent 全部工具权限。三个非人类势力真人运营席位也走同一 command pipeline，控制方式见 [运营控制](../platform/operations.md)。

研究评估器没有 gameplay binding；读取评估证据走独立研究权限。全平台 20 个活跃 gameplay 身份上限与工具并发/调用限额分别管理。

## 6. 数据化模板与组件复用

permissionProfile、budgetProfile 和 constraint preset 是复用数据；角色装配解析 selector 为固定 agentIds 后冻结。禁止在 executor 写 `if (agentId === "npc-cenyan")` 决定功能分支。

例如“可派遣自己的护送队”由 delegated-assets 约束读取当前 grants；岑雁与其他角色引用同一个 asset.dispatch，只是被委托资产集合不同。

新增角色的工作顺序为：定义身份/职责 → 选择 binding 模板 → 收窄具体限制 → 校验能力 → 生成 effective tool manifest。无需新增同义工具名称或复制实现。

新增工具的工作顺序为：定义输入/输出及 effect → 实现通用 executor → 注册一次 → 新增契约验证 → 按需要引用 binding；世界命令先有规则 handler，才可绑定 command 工具。

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

稳定关联为 `(worldId, branchId, agentId, operationId) → commandId + payloadHash`。operationId 由宿主在首次接受操作时生成并持久化；模型重试、worker 恢复沿用该映射。

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

并行只用于可并行的查询；涉及同资源的 command 由世界单写者裁决，顺序与冲突必须留痕。不能承诺“同一模型批次”意味着所有命令原子成功。

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
