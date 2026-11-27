# 集中模型池与 Agent 挂载

> 状态：已实现。标准与测试装配均已接入集中挂载、共享队列、尝试级预算账本以及三种模型传输；`evaluator` 运行与 `compression`/`embedding` 挂载尚未使用。本文给出路由、排队和预算契约。

## 1. 核心关系

解析路径只有一条：从 `connection` 出发，经 `models`、`mounts` 与 `resolved (agentId, purpose)`，最后交给 `host model port`。roster 只定义身份与职责，不复制每个 Agent 的 provider、密钥、温度和超时参数。

同一个 modelId 可服务多个 Agent 与多个 purpose；共享的是连接、参数配置及资源额度，消息、记忆、工具集、供应商会话和私密上下文必须分别隔离。

序章有 8 名公社支持者、4 名 AI 党魁、3 名外域 Agent，最多 15 个活跃 gameplay 身份。模型池并发上限是另一组资源约束，不因配置 15 个 Agent 就默认启动 15 路请求。

在线与实验活跃身份合计不得超过 15；完整 15 个 Agent 的对比实验要暂停在线运行，再逐分支执行。改变挂载不改变 Agent 身份，memory-maintenance 和 speech 也不另占身份。

## 2. 三类配置职责

| 配置 | 内容 | 禁止内容 |
|---|---|---|
| connections | adapterId（模块 ID）、受控 endpoint、credentialRef、账号级 rateLimitKey | 明文密钥、Agent 消息历史 |
| models | modelId、connectionId、外部模型名、可选的供应商返回名别名（`servedModels`，见第 12.5 节）、生成参数、能力与资源上限 | 每个角色的主张、记忆与授权 |
| mounts | modelId、agentIds、purposes，精确挂载关系 | 复制模型参数、放宽工具权限 |

credentialRef 由服务端 secret resolver 解析；前端只能看到连接别名与验证状态。导出 manifest 保留引用及配置 hash，删除实际密钥、认证 header、Cookie 和敏感 URL 参数。

modelId 是本平台配置 ID，externalModel 是供应商名称；两者都记录。不同 modelId 若共用同一账号，仍受同一 rateLimitKey 总限额，不能通过多个别名规避配额。

## 3. Purpose 契约

| purpose | 输入与用途 | 额外约束 |
|---|---|---|
| decision | NPC 的行动/认知决策策略 | 可使用本身份合法秘密；工具与输出 schema 必须受控 |
| speech | 对外对白 | 独立受众过滤 context，无命令工具，不复用携密会话 |
| memory-maintenance | 理解、反思、合并等维护 | 使用 scoped 来源和 job 预算，发布经过 revision CAS |
| compression | 指定区间的模型视图压缩 | 保存原件、来源与损失，不能改事实或扩大受众 |
| embedding | 选定记忆/查询的向量化 | 验证向量维度、版本与索引命名空间，不处理未授权文本 |
| evaluation | 辅助研究评分 | 独立 evaluator 主体与研究权限，不挂入 gameplay roster |

policy 指决策策略，配置字段统一写 decision。purpose 不允许插件任意创建字符串绕过限额；新增类别先扩展契约与预检。

只有启用该能力的 profile 才要求对应挂载；memory.none 不强制配 maintenance 模型，纯规则压缩不要求 compression 模型，未启用 embedding 不要求向量模型。

evaluation 由独立 evaluator 配置引用 `modelId`，调用主体类型为 evaluator。评估主体只执行评分。gameplay `mounts` 只接受前五类 purpose。

## 4. 目标配置示例

四个布局位于 `config/model-layouts/`。连接、生成参数、能力、限流及输出上限使用下表引用的 `connections` 和 `models` 配置。真实供应商须通过连通性与能力预检。

| 布局 | 挂载 | 连接与模型配置 |
|---|---|---|
| `shared-model-layout-v1.yaml` | `decision`、`speech`、`memory-maintenance` 均挂载 `npc-chat` | [model-transport.md — OpenAI 兼容配置](model-transport.md#31-配置) |
| `claude-model-layout-v1.yaml` | `decision` 挂载 `npc-claude`，`speech` 与 `memory-maintenance` 挂载 `npc-chat` | [model-transport.md — Anthropic 配置](model-transport.md#41-配置)、[model-transport.md — OpenAI 兼容配置](model-transport.md#31-配置) |
| `openai-compatible-gateway-layout-v1.yaml` | 与共享布局相同；`npc-chat` 的推理开关与返回名别名取自部署变量 | [model-transport.md — OpenAI 兼容配置](model-transport.md#31-配置)、[evaluation.md — 经网关执行](../platform/evaluation.md#82-经-openai-兼容网关用真实模型执行) |
| `openai-compatible-gateway-layout-v2.yaml` | 同 v1，`npc-chat` 的限额提高到并发 4、每分钟 60 次请求与 30 万 token | [model-transport.md — OpenAI 兼容配置](model-transport.md#31-配置)、[evaluation.md — 经网关执行](../platform/evaluation.md#82-经-openai-兼容网关用真实模型执行) |
| `deterministic-model-layout-v1.yaml` | `decision`、`speech`、`memory-maintenance` 均挂载 `npc-fixture` | [model-transport.md — 确定性适配器](model-transport.md#5-确定性适配器测试) |

下面是共享布局的挂载片段，以伊诺为例。正式布局按 `standard-15` 填入全部 Agent ID，测试布局按所选测试名册填写。名单见 [00-scope-and-invariants.md — 15 个上场身份](../00-scope-and-invariants.md#11-15-个上场身份)。

~~~yaml
schemaVersion: 1
layoutId: shared-model-layout-v1
pricingRef: pricing-live
mounts:
  - modelId: npc-chat
    agentIds: [npc-yinuo]
    purposes: [decision, speech, memory-maintenance]
~~~

`pricingRef` 可选，省略时读取 `config/pricing.yaml`；共享与 Claude 真实布局都引用 `config/pricing-live.yaml`，网关布局引用估算价目 `config/pricing-openai-compatible-gateway.yaml`（`evaluator` 独立评估主体目前尚未写入仓库预设布局文件，开启 `evaluator.enabled: true` 会在运行启动预检时被拒绝）。把某个 Agent 的一个用途改挂其他模型时，从原挂载移除该 `(agentId, purpose)`，再新增指向新 `modelId` 的挂载。同一 Agent 若用不同模型承担 `decision` 与 `speech`，为两个用途各写一条挂载。启用向量检索时，在 `models` 声明向量模型，为所需主体增加 `embedding` 挂载。

## 5. 解析与 run 冻结

Agent profile 的装配顺序是平台配置、场景 profile、可复用 Agent profile、实验 variant patch。Agent profile 只声明 required purposes/capabilities，不隐式选择 modelId 或覆盖路由；模型布局唯一由 RunSpec.modelLayoutRef 选择集中 connections/models/mounts 版本，再预检并写入 resolved manifest。

1. 校验 connections/models 的引用、字段、单位、有限上限与 adapter 可用性。
2. 将 mounts 展开为唯一映射，由 `(agentId, purpose)` 解析出唯一 `modelId`；未知身份或重复键立即报错。
3. 由激活 roster、策略能力与运行模式确定 required purposes（当前 `agentRequiredModelPurposes` 在运行启动预检阶段强制校验 `decision` 与 `speech` 挂载；M2/M3 所需的 `memory-maintenance` 在整理任务实际调用模型时解析，缺失时报错）；缺少挂载报错，不自动套默认模型。
4. 从 modelId 解析 connection、externalModel、参数、tokenizer 与能力证据，检查与工具/输出协议兼容。
5. 生成去密钥的路由表、请求能力、预算、显式 fallback、版本与 hash，并随 run 持久化。

每个 run 独占 branchId，激活期间绑定 profileHash 和模型池快照。控制台改动只对新 run 生效；在线切换在维护边界创建后继分支/run，不修改已开始样本的路由。

测试装配的 manifest 记录模型布局、价目、提示词及夹具摘要。旧线上运行经冻结摘要复算后继续使用原有策略。

账号密钥轮换可以保留同 credentialRef，但连接失败或供应商返回模型标识变化必须留痕；供应商部署变化可能破坏可比性，不能仅凭 modelId 相同认定环境相同。

## 6. 能力预检与适配边界

模型能力包括输入模态、上下文窗口、最大输出、工具调用/并行调用、结构化输出、流式方式、取消、usage、tokenizer 与 embedding 维度。声明、适配器支持和已验证事实分别展示。

decision 的工具协议不兼容、窗口容不下最小受保护 context、embedding 维度与索引不一致时，拒绝组合。不能暗中删工具、取消 schema 校验、转用另一模型或让 provider 自动截断。

可通过适配器做格式映射，但不能隐藏语义损失；实际序列化请求与规范化请求分别归档。供应商不提供 usage、指纹或精确 tokenizer 时记录 unknown/估算，不能伪造已验证值。

所有插件只拿 host model port，不能直接获取 credentials 或私建 SDK client。装配、生命周期与能力依赖统一见 [插件规范](../architecture/plugins.md) 和 [组合配置](../architecture/composition.md)。

## 7. 全池公平队列与背压

宿主维护全池 admission queue，再受 modelId 和 connection/rateLimitKey 限流。单进程首版集中记账；若以后拆 worker，必须保留一个可原子预留的配额权威。

队列按主体轮转并按 purpose 分配服务份额；玩家 decision/speech 可优先，同时预留 maintenance 的最低进展。evaluator 使用独立低优先预算，不能挤占在线交互保底额度。

队列项包含 scope、turn/job、purpose、deadline、估算 token、挂载 hash 与取消信号。出队再次检查 lease/epoch；失效请求在发往供应商前撤销，避免接管后的无效费用。

queueMax、maxWaitMs、model 并发、账号 RPM/TPM、run 总费用同时约束。达到边界返回 queued、backpressure 或 budget-exhausted，不无限堆积 Promise，也不自动多开连接逃避限流。

请求前预留估算输入与输出上限，结束后对账实际用量。usage 未知时按声明的保守规则占额；供应商计费未知与本地额度状态分别显示。

限流重试遵守供应商可观测 retry-after 和有上限的退避；重试仍算实际 attempt。取消不能保证供应商停止计费，晚到响应只归档，是否发布仍由 fencing 决定。

闭环实验的逻辑世界时钟可受实验调度推进，不把现实队列等待误算为 NPC 记忆衰减；现实截止/网络耗时继续真实记录。

## 8. 隔离与共享缓存

连接池、TLS client、只读 tokenizer 和账号额度可以共享；消息列表、供应商 thread/session、memory store、tool schema selection 与 context artifacts 不共享可写单例。

每次调用携带明确主体、purpose、branch、contextArtifactId 和 modelConfigHash。不能让共用 modelId 的两个角色在同一服务端聊天会话继续彼此历史。

精确响应缓存若启用，必须包含授权域、完整规范请求、模型/参数版本与受众；默认实验关闭结果缓存或显式单列。provider 的 prefix cache 使用与命中情况如可观测则记录，不承诺可控。

speech 不复用携密会话或不透明的私密上下文句柄；公共只读设定可以复用内容，仍须证明最终请求只包含该受众合法素材。模型池复用资源不等于复用人格。

## 9. 显式 fallback 与失败

fallback 是配置化路由策略，声明触发错误、候选 modelId 顺序、最大次数和是否影响实验有效性。默认严格运行不自动换模型；缺少可用挂载直接失败。

fallback 目标也须先通过同 purpose 能力预检与池预算，不得降低鉴权、工具或输出协议。每次切换记录原路由、实际路由、原因、错误与费用。

在线允许已声明 fallback 时标记 degraded；正式单变量实验中模型切换通常为 invalid/独立分层样本，除非假设本身就在研究 fallback。不同组不能静默享有不同失败恢复条件。

speech 故障可使用预先批准的安全模板或不回应；decision 故障不能凭模型池臆造成功行动。世界已接受任务继续按规则运行，不随供应商故障消失。

## 10. Trace、评估与验收

每次 attempt 保存 agent/evaluator 主体、purpose、resolved mount、connection/modelId、供应商实际标识、规范请求、序列化业务请求、原始响应、结束原因、request ID、usage 与错误。

拆分排队、限流等待、首 token、完整响应及解析耗时；prompt/schema、超时、重试、fallback 和 tokenizer 版本进入 manifest。认证内容永不写入原文 artifact。

memory 实验固定解析后的路由、参数、池限额和预算；轮换运行顺序并记录缓存与队列负载。单纯“用了同一 modelId”不足以保证实验公平，也不保证 LLM 确定性。

- 一个模型挂载多个 Agent，验证只共享资源配额，不串消息、工具、索引或供应商会话。
- 重叠挂载、未知 agentId、缺 purpose、坏引用与不兼容能力均在预检阶段失败。
- 改一个模型定义后新 run 的所有相关挂载一致更新，既有 run 的冻结路由不变。
- 同账号不同 modelId 共同触达总限额，队列有界且低优先维护不会永久饥饿。
- 在排队/调用/返回阶段接管或取消，验证旧结果不能下令、写认知或发布对白。
- 检查失败、重试、fallback、未知 usage 和 evaluator 费用全部可定位且不漏算。

观测、配置与实验规则分别见 [可观测性](../platform/observability.md)、[配置体系](../platform/configuration.md)、[评估](../platform/evaluation.md)；运行阶段见 [Runtime](runtime.md)。

## 11. 参考边界

借鉴 deepseek-harness 的 [可替换 LLM 服务与适配器](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm/src/index.ts)。集中 models/mounts、NPC purpose 路由、公平队列和 15 个身份限制是本项目设计，不声称参考框架已经提供这一游戏模型池。

## 12. 首版实现规格：`agent.model-pool.shared`

### 12.1 调用入口

当前宿主通过 `RunModelPort` 绑定冻结路由。模型决策和对白只取得绑定当前 turn、主体与用途的调用回调。回调固定截止时间及租约检查，策略只能提交该阶段的规范化请求。

```ts
interface ScopedModelPort {             // runtime、memory 与 speech 收到的调用端口；已绑定 Agent 或 evaluator。
  call(input: {
    purpose: Purpose;
    workRef: string;                    // turn ID、整理任务 ID 或探针 ID。
    system: string;
    messages: NormalizedMessage[];
    tools: NormalizedTool[];
    output: ModelRequest["output"];
    reserveOutputTokens: number;        // 预算预留，取自 profile。
    deadlineMs: number;                 // turn 或 job 的绝对单调截止时间。
    fence: () => boolean;               // 发送前与接收后都会复查；返回 false 时丢弃结果。
  }): Promise<ModelCallResult>;         // 返回 { response, attempts }；失败时抛出 ModelPoolError。
}
```

一次 `call` 是一个逻辑调用（`llmCallId`），内部可能有多次 attempt。

### 12.2 解析

1. 预检时把 `mounts` 展开成 `(agentId, purpose) → modelId` 的映射；任何键出现两次即拒绝，不按“后者覆盖”。
2. 由 `modelId` 找到 model 与 connection，解析 `env:` 值（外部模型名、endpoint）与 `credentialRef`（密钥只交给适配器，不写进任何记录）。
3. 挂载用途的最大输出取 `maxOutputTokensByPurpose[purpose]`，未配置时取能力上限与 4096 中较小的值，这个值就是请求发出的硬上限（`max_tokens`），也是账本预留与限流窗口的占额依据。预检要求 profile 的 `reserveOutputTokens` 在该上限以内，超限时报告主体、用途、预留与上限的具体数值。`reserveOutputTokens` 是成本估算的参考值，不参与硬上限：把预留当 `max_tokens` 会让 Anthropic 模型在思考阶段就耗尽输出预算（思考也计入输出）。参见 [model-transport.md — Anthropic 配置](model-transport.md#41-配置)。
4. 生成去密钥的路由表（agentId、purpose、modelId、connectionId、adapterId、externalModel、参数 hash）写入 manifest。

### 12.3 排队、限流与重试

- 全池一个 admission 队列，按 `(purpose 份额, 等待时间)` 出队：decision 与 speech 共享 70% 的份额，memory-maintenance 至少 20%，evaluation 至多 10%；同一 purpose 内按 Agent 轮转。
- 出队时检查：该 model 的 `maxConcurrent`；`rateLimitKey` 对应账号在最近 60 秒内的请求数与 token 数（估算输入 + 挂载的用途上限，即请求可能产生的最大输出）不超过 `requestsPerMinute` 与 `tokensPerMinute`（单次请求自身估算 token 超过 `tokensPerMinute` 时立即以 `backpressure` 拒绝，不再排队等待）；`fence()` 仍为 true；距 `deadlineMs` 至少还剩 `requestTimeoutMs` 的一半。不满足时继续排队，等到 deadline 就以 `backpressure` 失败。
- 队列长度上限 200；超过时新请求立即以 `backpressure` 失败。上述余量判据在准入筛选、发送前检查与重试判断三处共用同一实现，不各自重算超时的一半。
- 重试：只对可重试错误（`rate-limited`、`timeout`、`network`、`server`）重试，最多 2 次，等待 1 秒、4 秒，若错误带 `retryAfterMs` 且更长则用它，单次等待上限 30 秒。每次重试都是新的 attempt，之前的 attempt 标为 superseded。不可重试错误与 `protocol` 错误（refusal、JSON 不合法）不在模型池内重试，交给调用方按失败策略处理。
- 收到响应后再检查一次 `fence()`：为 false 时响应只归档、标 superseded，不返回给调用方使用。

### 12.4 预算与费用

- 发送前在 `budget_ledger` 预留：输入为估算 token（[上下文](context.md) 第 11.2 节），输出为 `max(reserveOutputTokens, 挂载用途上限)`；收到响应后按实际 usage 结算，usage 缺失时按预留值记账并标 `usage_unknown`。按请求上限占额而不是按较小的成本预留，是为了保证剩余预算不足以覆盖最大可能输出时请求在发送前就以 `budget-exhausted` 失败，而不是先发送再超支。`reserveOutputTokens` 仍然保留，它的语义是成本估算的参考值，不能低于 1、也不能超过挂载的用途上限，见 12.2 节第 3 条。
- run、Agent、turn 三级预算：run 的 `maxTokens` 与 `maxCost`（来自 RunSpec，可为 null 表示不限）、每个 Agent 每游戏日的 `maxTokensPerAgentPerDay`（profile 的 budgets，默认 60000）、turn 的调用次数上限（profile）。任何一级不足时以 `budget-exhausted` 失败，不排队。
- 进程退出时未结算的预留在重启后按预留计入，并标记为未知用量；该清理只扫 `settled_at IS NULL` 并由部分索引支撑。缺少完整归档的运行标记为证据不完整，其中 `started` 的尝试标记为 `process-interrupted`。
- 费用：布局的 `pricingRef` 选择价目文件，省略时为 `config/pricing.yaml`。文件按 `modelId` 给出 `externalModel` 与每百万输入/输出 token 的单价；预检要求实际解析出的供应商模型与记录一致。manifest 冻结所用的价目版本，报告里的费用一律标注为估算值。

### 12.5 记录

每个 attempt 写一行 `model_attempts`（agent、purpose、modelId、connectionId、adapterId、状态、是否为有效 attempt、请求/响应 artifact、usage、排队/首字/总耗时、错误），并写一个 span。`servedModel` 与配置的 `externalModel` 不同、或 `fallbackUsed` 为 true 时，attempt 标记 `model-substituted`，该 turn 的 effective 记录写明实际服务的模型。

有的网关按请求名路由，却在响应的 `model` 字段报告上游名称（例如请求 `deepseek-v4.1-flash-official`，响应报告 `deepseek/deepseek-flash`）。模型定义可以用 `servedModels` 声明这类名称：

- `servedModels` 是精确名称列表，1–16 项且不得重复；也可以写成 `env:WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS`，由宿主预检时按逗号拆分，变量未设置时按未声明处理，见 [配置](../platform/configuration.md#10-完整配置文件首版)。
- 预检把解析出的列表写入该模型每条冻结路由的 `servedModels`，并计入路由的 `configHash`；没有声明的模型，路由里不出现该键。
- `servedModel` 精确命中列表中的某一项时不算替换。span 的 `reason` 记为 `served-model-alias`，请求 artifact 同时保存请求名（`request.externalModel`）和声明的 `servedModels`，响应 artifact 保存供应商报告的 `servedModel`。
- 未命中的名称仍记 `model-substituted`；`fallbackUsed` 为 true 时，即使命中别名也算替换。
