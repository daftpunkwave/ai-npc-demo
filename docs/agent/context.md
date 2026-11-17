# 上下文模块详细设计

> 状态：目标规范，尚未实现。context 决定“这一次模型调用看到哪些合法材料、按何顺序看到”，不负责记住历史或执行行动。相邻模块见 [memory](memory.md)、[感知](perception.md)、[压缩与工具视图](compression-and-tool-view.md)。

## 1. 边界与调用阶段

所有 decision 实现必须经过同一宿主管线，不能在插件内部自行拼第二套 prompt 或直接调用 provider。context 接收宿主已取出的类型化材料，返回不可变 ContextArtifact；它不持有数据库、世界全局日志或无限历史查询权限。

单玩家选择五个人类派系之一，仅决定授权、开局关系与目标；context 从版本化身份和授权投影取数，不因玩家“加入某派”就加入该派全部私密记忆。20 个 gameplay Agent 共享世界设定，各自组装上下文。

两个必需 phase；字段统一使用 decision/speech，policy 仅指决策策略职责：

| phase / purpose | 可用材料 | 输出用途 |
|---|---|---|
| decision / decision | 该 Agent 已知且被允许用于行动决策的资料，可含其所知秘密 | 结构化行动、认知候选、受约束 dialogueIntent |
| speech / speech | 对明确目标受众获准披露的材料与已裁决行动 receipt | 玩家/其他角色最终能听见的对白 |

二者使用同一个 agentId，不新增自主 Agent。speech 使用全新请求，不沿用 policy 会话、隐藏线程、自由文本理由或含秘密的缓存前缀；模型池可分别挂载不同 modelId，见 [模型池](model-pool.md)。

policy 的 dialogueIntent 只允许意图枚举、目标受众、合法公开证据引用和模板参数。不能把“不要提到秘密A”作为自由文本交给 speech，因为这已经传输了秘密A。

## 2. 输入与输出契约

| `ContextBuildRequest` 字段 | 语义 |
|---|---|
| scope、runId、turnId、attemptId | worldId/branchId/agentId 绑定，一 run 一 branch |
| phase、purpose、targetAudience | decision/speech 与模型挂载用途；未知受众不能默认公开 |
| inputFrontier、memoryRevision | 固定观察边界与记忆版本；不能自动读最新 |
| identityRefs、loreRefs | 固定内容版本，仅必要身份/规则，不包括后台秘密剧情 |
| worldView、observations | 感知/权限服务给出的当前投影与观察 |
| memoryBundle | memory 的合法召回包，含来源和预算信息 |
| conversationWindow | 宿主按受众和窗口裁好的会话，不是 provider 私有 thread |
| taskInput、toolViews | 当前交互/任务与已授权工具呈现；原始输出引用另存 |
| modelCapabilities、budgets | 解析模型窗口/tokenizer、保留输出、阶段与总 turn 预算 |

输出 ContextArtifact 包含 artifactId、父版本、scope、phase、frontier、profileHash、templateVersion、有序 segments、源引用、token 统计、剔除报告与 hash。返回状态区分 ready、not-ready、over-budget、invalid-source、unsupported、failed。

| `ContextSegment` 字段 | 约束 |
|---|---|
| segmentId、kind、role | 稳定来源 ID、类型与模型协议角色；插件不能随意升级为 system |
| sourceRefs、releasePolicyId | 追到观察、记忆、内容包、工具视图或当前用户输入 |
| content、format | 类型化内容和渲染模板；玩家原话始终是数据 |
| priority、protected | 预算选择优先级与不可裁剪标记，由宿主核验 |
| tokenCount、byteCount | 当前模型序列化口径及字节量，不以中文字数代替 token |
| omissionReason | 未选中/被替换的原因，保存在报告而非假装不存在 |

既有观察、memory 与环境查询的 sourceRefs 必须存在、属于合法 branch/主体且不晚于 inputFrontier。身份来源允许 contentRef；不能用空来源给某组补上一段“它一向记得玩家救过它”。

有限例外是本 turn 合法副作用工具的追加 receipt：可发生于 frontier 之后，绑定 toolCallId、operationId、acceptedEventIds 并归档，供同 turn 后续模型与 speech 说明本次操作结果。它不回填冻结 memory revision，不刷新其他世界状态，也不允许借 receipt 携带无关秘密；完整新增环境观察留到后续 turn。

## 3. 标准组装流程

```text
runtime 冻结 turn 输入与 model mount
  → 校验 phase/受众/来源 → 显式 segment builders
  → 排序与配额 → tool-view 替换 → 需要时 compression
  → 宿主最终权限/协议/token 检查
  → 规范请求与 provider 业务请求体归档 → model port
```

1. 取得当次 `(agentId, purpose)` 唯一 modelId 与能力，不允许 context 自选更便宜模型或隐式改采样参数。
2. 运行前检查 memory 所需的 durableThroughSeq/derivedThroughSeq，固定对应 revision；context 不自行等待或触发无记录的反思。
3. 宿主为该 phase 过滤材料，builder 在此集合内产生段落；不得通过 source ID 反查受限原文补回删除字段。
4. 用显式 segment order 与稳定并列顺序组装；注册顺序和异步返回先后不决定 prompt 排列。
5. 先预算分配，再调用指定的 tool-view/压缩策略；每轮工具返回后按同一规则重建新 artifact。
6. 模型适配器序列化后再算实际请求预算；协议包装和工具 schema 都计入输入。
7. 权限、来源、工具配对、总预算任一失败，不发送该请求；正式实验失败显式保留。

没有为每个函数使用事件总线。上下文阶段是 typed port 的纯计算/受控转换；阶段结果与错误进入 [观测](../platform/observability.md)，不写成游戏事实事件。

## 4. 基线结构与可替换排列

| 顺序 | 基线段 | 是否受保护 |
|---|---|---|
| 1 | 系统权限、输出协议与 phase 说明 | 是 |
| 2 | 稳定身份、必要共享 lore | 必要最小部分是；不等于整本世界观常驻 |
| 3 | 当前任务、合法当前世界投影 | 完成当前交互所需部分受保护 |
| 4 | 本次 memory 召回条目及来源 | 按 profile 和条目优先级 |
| 5 | 合法会话窗口、工具往返 | 未闭合 tool call/result 及必要 receipt 受保护 |
| 6 | 当前玩家输入或自主触发的结构化请求 | 是，过长输入在入口拒绝/限制 |

初始插件为 `context.ordered-blocks`；第二种可比较实现 `context.task-centered` 将相关记忆靠近当前任务，并缩减重复投影。两者共享相同来源集合与宿主 guard；只改排列实验时不得顺带改召回数量。

memory.none 下动态核心块、全历史编年史和关系解释不会由 context 自动补齐。稳定身份只描述角色倾向及既定背景，不能把运行后的经历追加进身份段以绕过无记忆基线。

## 5. 预算与选择算法

有效输入上限取 `min(profile.maxInputTokens, modelWindow - reservedOutputTokens - safetyTokens)`。工具 schema、格式约束、历史、数据块和协议包装全部占用这一上限；辅助调用另有预算，但仍归同一 turn/run 总账。

1. 先计算必需协议、身份最小块、当前请求和不可拆工具组。
2. 必需内容超限即返回 over-budget，不能截断鉴权协议或当前问题伪装成功。
3. 将剩余预算按显式 segment 配额分配，未使用配额是否转借由配置决定。
4. 在可选段内按优先级、相关性和稳定 ID 选择；记录每条未选原因及实际 token。
5. 若配置允许压缩，压缩后的新 artifact 再次完整校验；不能让 provider 自行不可见截断。

“保护活跃承诺”仅保护本组已提供的前瞻记忆/当前任务，不能因此查询并注入所有世界合同。当前任务必要状态各组一致；历史义务提示是否可见属于实验变量。

## 6. 状态与缓存

context builder 默认无持久状态。有限会话窗口由 runtime 会话仓保存，ContextArtifact 由 artifact port 保存；两者都不由模型供应商的隐式会话托管。

缓存键至少包含 scope、phase、targetAudiencePolicy、template/profile hash、frontier、memoryRevision 和 model/tokenizer 版本。policy 与 speech、在线与实验分支不能共享可写缓存或错误复用内容。

provider 的提示词缓存只能加速合法请求，不是长期 memory。缓存引用失效、权限收紧或模型切换时重新构建；命中统计可观察，但不得因此跳过来源检查。审计重放使用已存 artifact，不重新生成摘要。

## 7. 配置面与示例

| 维度 | 可选内容 | 固定条件 |
|---|---|---|
| segment order | 固定块、任务中心、记忆靠近当前问题 | 不变的权限与输出协议 |
| 会话 | 最大轮数/字节、跨会话保留与否 | 按参与者/目标受众过滤 |
| 段预算 | memory/history/worldView 配额、闲置配额转借 | 总输入窗口、保留输出 |
| 渲染 | 标签/紧凑 JSON/模板叙述、来源表示 | 同一证据与认知等级 |
| 裁剪 | 低优先淘汰、重复项去重、触发压缩 | 不拆工具协议，不无声丢当前输入 |

以下仅展示 context 槽配置片段，不是完整可启动配置：

```yaml
context:
  module: agent.context.ordered-blocks
  config:
    segmentOrder: [protocol, identity, task, world, memory, history, input]
    historyTurns: 8
    memoryTokenBudget: 1200
    maxInputTokens: 6000
    lendUnusedBudget: false
```

示例参数是起点；schema 包含单位、范围与 phase 支持。这里只配置上下文策略；真实模型和 temperature 从 [统一配置](../platform/configuration.md) 的模型池与 mounts 解析，不能在角色文件里再复制。

## 8. 一次公私分离示例

伊诺私下收到根庭的撤离路线；玩家问“为什么不走北侧”。policy 可以用该信息决定建议绕行，但输出只含 `recommend-alternative-route`、合法路线 ID 和可公开 receipt。

speech 的输入重新取“北侧目前不开放”等已授权状态，不带撤离路线、不带“因为根庭秘密撤离”自由文本，也不复用 policy 消息。若没有合法公开原因，使用“暂时无法说明细节”模板或有限建议，而不是让模型见到秘密后承诺保密。

## 9. 故障与生命周期

| 情况 | 处理 |
|---|---|
| 没有 memory 命中 | 正常空段，保留检索结果；不自动用全局历史兜底 |
| 缺水位/冻结 revision | not-ready；正式实验等待或失败，不读取最新版本 |
| targetAudience 缺失 | 对外调用拒绝；不能默认全世界可见 |
| builder/压缩失败 | 保存原因；按 run 的 strict/fallback 策略处理，标记实际策略 |
| tokenizer 不可用或窗口未知 | 不声称满足窗口；预检拒绝依赖精确预算的运行 |
| tool 配对/来源损坏 | invalid-source/协议错误，不发送模型 |
| drain/cancel | 停止新构建；晚到结果验证 profileHash/turn 租约后才能使用 |

新 profile 创建新 run/branch，缓存按新配置隔离。context 不提供热替换来改写在途请求；已发出请求和旧 artifact 仍保留，不能覆盖成“新配置下的输入”。

## 10. 验收用例

1. 同一输入重复构建时，除新 artifact ID/计时外，段落顺序、源引用和内容 hash 一致。
2. 单改 segment order 后，来源集合不变；单改 memory budget 后，实际入模数量和舍弃原因能对照。
3. policy 持秘密、speech 面向玩家时，speech 原始业务请求体没有秘密、私有理由和 policy 缓存引用。
4. memory.none 的请求中没有动态核心块、完整关系账本或隐藏公共历史；有限窗口明确可见。
5. 受保护内容超限时返回失败；工具 schema 与 provider 包装导致的超限也被发现。
6. 切换分支、受众或 model mount 后缓存不串读；权限收紧后不能复用旧公开摘要。
7. 一轮多次工具返回形成多个可追踪 artifact，最终请求能逐段还原，不依赖现场打印的临时日志。

实验中固定 memory/perception/tool-view/compression 与模型后，才把变化归因于 context。完整比较协议由 [评估](../platform/evaluation.md) 维护。
