# 压缩与工具结果视图详细设计

> 状态：目标规范，尚未实现。两个槽分别回答“历史材料怎样变短”和“工具结果给模型看多细”。它们共享 provenance/预算协议，但必须能独立替换、独立比较。相关契约见 [context](context.md)、[工具](tools.md)。

## 1. 两个模块的边界

| 模块 | 输入与输出 | 不负责 |
|---|---|---|
| compression | 由指定 ContextArtifact 或段区间产出替代段、来源映射与损失报告 | 遗忘世界事实、修改 NPC 长期信念、重新执行工具 |
| tool-view | 由一次完整合法工具结果生成当前 phase/受众下的模型视图 | 改变执行结果、追加世界副作用、替换 command handler |

原始工具结果、原始上下文和完整请求档案分别保留。压缩只改变模型视图；NPC memory 的容量淘汰或信念修订走 [memory](memory.md)，不能把一次摘要自动变成长期“真相”。

policy 与 speech 仍是不同受众调用。policy 工具结果可能含本 Agent 所知秘密，speech 使用重新授权的工具视图与上下文；摘要不是去密工具，不能把私有摘要直接当公开信息。

## 2. compression 输入输出

| 请求字段 | 规范 |
|---|---|
| scope、runId、turnId、phase | 绑定 worldId/branchId/agentId，一 run 独占一 branch；phase 为 decision/speech |
| inputArtifactId/hash、selectedSegmentIds | 指定不可变输入，不能自动读取最新会话 |
| inputFrontier、memoryRevision | 固定既有来源边界；仅允许本 turn 已归档工具 receipt 的有限追加输入 |
| targetAudience、releasePolicyIds | 约束哪些内容可以进入当前调用 |
| protectedGroups | 协议、当前交互、未闭合工具组、必要 receipt 等不可拆组 |
| targetTokens、maxLossPolicy | 目标预算与允许损失类型，由宿主最终复核 |
| pluginConfig、modelMountRef | 策略参数与已解析挂载引用；不内嵌 provider 参数 |

输出 CompressionResult 包括 status、replacementSegments、sourceMap、lossReport、input/outputTokens、usedCallIds、stateRevision 与 artifact hash。status 至少区分 applied、not-triggered、cannot-fit、invalid-source、failed。

sourceMap 将每个摘要条目映射到原 segment/sourceRefs；lossReport 区分移除重复、删除细节、保留不确定性、无法压缩的保护项。映射只能证明出处存在，不能自动证明摘要语义完全忠实。

## 3. 压缩策略与流程

| 初始实现 | 行为 | 风险与适用范围 |
|---|---|---|
| `compression.none` | 不变换，执行最终窗口检查 | 超限显式失败，适合短上下文基线 |
| `compression.window` | 按完整交互组保留最近部分，旧部分移出模型视图 | 简单便宜，但早期原因可能丢失 |
| `compression.structured` | 保留结构字段、去重复投影、合并重复状态 | 需要工具/任务 schema，无法理解全部自然语言 |
| `compression.summary` | 宿主 model port 生成带证据的受限摘要 | 有延迟、费用和语义失真，必须观测与评估 |

压缩流程是：先检查触发条件，标记保护项与完整交互组；再选择允许变换的区间，做规则变换或受控模型摘要；然后验证来源、权限、状态、数字与工具配对；最后生成新 artifact，由宿主重算最终预算。

触发条件可选输入 token 占比、固定历史组数或任务阶段完成；逻辑时间条件只能使用 worldTick。触发点和阈值进入 resolved profile，不能每次按供应商隐式行为变化。

summary 通过 `(agentId, compression)` mount 请求共享模型池；它是同一 Agent 的辅助调用，计入全 turn/run 费用与并发。没有独立“摘要 Agent”，满 20 个 gameplay Agent 时也不能额外激活自主整理身份。

## 4. 不可丢的语义

1. 系统权限/输出协议、最小身份、当前交互不能为满足预算被偷偷删改。
2. tool call 与对应 result 作为完整组处理；未完成工具结果不能被写成已成功。
3. executionStatus、commandStatus、taskStatus 不可混用；网关拿到确定响应不等于命令获准，命令获准不等于任务完成。行动 receipt 和必要错误码保留。
4. “A 声称 B 背约”和“B 确已背约”必须不同；证据不足不能压成确定结论。
5. 当前世界状态取本次授权投影；旧工具快照保留 asOf/version，不能冒充当前库存。
6. 未被 memory/context 提供的承诺不得为了“保护承诺”从全局合同补入。

对于自然语言，schema、实体/数字核对和来源检查只能降低失真，不能穷尽语义校验。记录 validationCoverage；关键机制事实优先用结构化字段，不让 LLM 摘要覆盖。正式实验仍需语义探针和人工抽检。

## 5. 压缩状态与撤销

无状态策略每次从固定输入生成新 artifact。会话 compaction 可保存压缩检查点：schemaVersion、输入区间/hash、摘要版本、sourceMap、releasePolicy、保留尾部边界和策略 hash；它仍是 context 状态，不自动写入 memory。

同一次重试复用有效检查点前，检查分支、phase、受众、模型口径和输入 hash。任一不匹配重新生成，不能将 policy 摘要缓存复用到 speech。审计重放直接读已归档摘要，不调用模型重新压缩。

detail eviction、压缩保留和彻底撤回是不同操作。允许忘记细节但保留显式摘要；若来源被撤回、纠正或权限收紧，派生摘要需失效或重算。已经公开过的旧文本属于历史事实，不因数据库删除就变成“从未说过”。

memory 的 derivedThroughSeq 只由其维护提交推进；context 压缩成功不会伪造 memory-ready。若某种长期整理会产出 memory 核心块，任务归 memory-maintenance，并纳入其水位协议。

## 6. tool-view 契约

| 数据 | 必需字段 |
|---|---|
| `ToolExecutionRecord` | toolCallId、toolId/version、原参数、scope、执行权限、原始合法输出、executionStatus、asOf/version |
| `ToolViewRequest` | executionRef/hash、phase、targetAudience、inputFrontier、预算、策略配置 |
| `ToolViewResult` | 视图阶段状态、modelVisibleContent、sourceMap、omittedFields、resultRef、tokenCount、完整语义 envelope |

原始合法输出指工具在该主体权限内返回的完整结果，不是数据库全量真值。tool-view 接收的是先授权、再经当前 phase/受众过滤的候选数据；full 也不能扩大这个集合。

稳定 envelope 保留 executionStatus=ok/error/unknown、错误原因、必要 receipt 与 taskStatus、来源和传播标签。receipt.commandStatus=accepted/rejected 不可变；taskStatus=pending/running/completed/failed/cancelled 是独立任务投影。ok 表示网关拿到确定合法响应，可包含 command rejected；unknown 需核对 receipt。完整协议由 [公共契约](../architecture/contracts.md) 维护。

tool-view 的实现只由 Agent profile 的 toolView 插件槽选择；ToolBinding.viewConstraints 只限制允许字段、条数和 token，不再另选 full/structured/brief。解析出的 effective 上限同时服从 profile 预算、binding 收窄和动态权限，不能靠更换视图突破约束。不同细度保持同一 schema 和执行逻辑，只改变业务 detail。

| 实现 | 模型看到什么 | 展开方式 |
|---|---|---|
| `tool-view.full` | 完整授权字段，含可读列表与结构结果 | 按正常分页继续查询 |
| `tool-view.structured` | 任务相关字段、状态、关键原因、来源和有限列表 | resultRef 查询已省略字段 |
| `tool-view.brief` | 简短结论、必要状态/receipt、resultRef | 显式 recall/result-read 工具，重新鉴权 |

resultRef 是不透明受限引用，不是可跨 Agent 读取的公共 URL。引用包含/绑定 scope、原执行版本和允许受众；读引用仍检查当前权限、预算和记录存在性。被撤销或过期引用返回明确错误。

## 7. 一次工具细度示例

玩家请求护送材料。工具已拿到确定响应：护送命令接受，operation 为 op-17，任务当前 pending，预计 worldTick 42 完成；道路通行条件不足，可能改道。

```json
{
  "executionStatus": "ok",
  "receipt": {
    "receiptId": "receipt-17",
    "commandId": "cmd-17",
    "operationId": "op-17",
    "commandStatus": "accepted",
    "acceptedEventIds": ["event-17"]
  },
  "taskStatus": "pending",
  "detail": "护送已受理，尚未抵达。",
  "resultRef": "result-17"
}
```

这是 brief 的示意结果，不包含凭据或真实运行记录。structured 可再给出到达 tick 和合法风险码；full 还给出授权路线与前置条件列表。任何模式都不能写成“材料已经送到”。

如果命令被拒绝，工具 executionStatus 仍可为 ok，但 receipt.commandStatus 必须是 rejected；如果执行是否生效未知则为 unknown，不能擅自写 rejected。三种视图均保留真实状态与原因，不得为了简短删掉错误。展开增加调用与 token，其收益和费用都计入该组。

## 8. 流程与副作用

runtime 调用工具，工具网关完成鉴权、执行与持久化并保存完整结果；结果先按 phase 和受众过滤，再经过 tool-view 和 context，需要时做 compression，最后经 guard 送入模型。

环境查询固定在 inputFrontier 的 read view。本 turn 副作用命令按当下世界验证，其 receipt 可晚于 frontier，以 toolCallId/operationId/acceptedEventIds 标记为本 turn 追加结果；视图/压缩必须保留这种来源区别，不把它混成原先已知状态或扩大到无关新事实。

tool-view 不重试原业务工具，也不以“获取更完整结果”为由再执行派遣。副作用只走标准 command 与 operationId 幂等；查看 resultRef 是只读。旧 turn 的晚到 view 不能触发新动作。

开环对比使用固定检查点的只读工具结果；写工具只返回提案或模拟结果，并明确 simulation 标识，不能把模拟 taskStatus=pending 当真实世界已接受。闭环则在独立分支运行正常 authority，保留内生后果。

## 9. 配置维度

| 槽 | 可配置项 | 不能由普通策略改变 |
|---|---|---|
| compression | trigger、阈值、尾部组数、目标 token、结构字段、损失容忍 | 来源权限、当前问题、工具协议与最终窗口 guard |
| tool-view | full/structured/brief、字段白名单、列表上限、文本长度、展开预算 | 执行状态、必要 receipt、错误真实性与源权限 |

以下仅展示 compression/toolView 槽配置片段，不是完整可启动配置：

```yaml
compression:
  module: agent.compression.window
  config:
    triggerRatio: 0.8
    preserveRecentGroups: 4
    targetTokenRatio: 0.6
toolView:
  module: agent.tool-view.structured
  config:
    maxListItems: 5
    includeEvidenceRefs: true
```

比例与容量为待实测起点。模型定义只在 [配置总入口](../platform/configuration.md) 的 models/mounts 维护；同一 Agent 的 compression 挂载不可由上述片段覆盖。工具字段白名单由 schema 定义，未知字段或非法组合预检失败。

## 10. 故障与生命周期

| 故障 | 处理 |
|---|---|
| 压缩未触发 | not-triggered；记录阈值与实际 token，不能标为执行成功 |
| 保护项已超过窗口 | cannot-fit，不删协议或吞当前输入 |
| 摘要超时/坏来源/数字矛盾 | 丢弃候选，保留错误；按显式策略失败或使用可容纳的原文 |
| resultRef 不存在/越权 | typed error，不能回全局工具日志兜底 |
| 原始结果损坏 | failed；brief 不得靠自然语言猜测修复 |
| 运行停止/策略切换 | drain 后保存检查点，新 run/branch 隔离；晚到产物校验租约/版本 |

fallback 若使用原文或另一策略，必须记录 effective 配置和额外费用；正式单轴实验不得把 fallback 样本当作目标策略成功。生命周期遵守 [插件协议](../architecture/plugins.md)。

## 11. 验收用例

1. 只换 tool-view，原始工具输入/结果 hash 与世界结果不变，模型可见字段和 token 确实改变。
2. commandStatus=accepted、taskStatus=pending 经 brief/summary 后仍不是 completed；executionStatus=ok 不会掩盖命令拒绝，unknown 不伪装成确定失败。
3. 压缩不拆 tool call/result 组；保护项超限有明确错误，无 provider 隐式截断。
4. 私密 policy 结果和摘要不能进入公开 speech，跨 branch/Agent 的 resultRef 读取失败。
5. 重试 view、展开引用和审计重放不重复派遣、不重复扣资源；开环无真实副作用。
6. 来源纠错/撤回后，旧摘要和 view 缓存失效；普通细节淘汰按声明保留或移除概括。
7. 在固定其他槽后分别比较压缩率、事实/不确定性保留、工具展开次数、费用及行为影响。

详细请求档案与指标定义见 [观测](../platform/observability.md) 和 [评估](../platform/evaluation.md)。压缩率高本身不构成通过，仍需检验角色行为、秘密边界和真实机制结果。
