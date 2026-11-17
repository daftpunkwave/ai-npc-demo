# 集中模型池与 Agent 挂载

> 状态：待实现规范。供应商连接、模型参数集中定义，Agent 通过挂载引用；本文未锁定真实模型、价格、吞吐量或 SDK 版本。

## 1. 核心关系

`connection → models → mounts → resolved (agentId, purpose) → host model port` 是唯一解析路径。roster 只定义身份与职责，不复制每个 Agent 的 provider、密钥、温度和超时参数。

同一个 modelId 可服务多个 Agent 与多个 purpose；共享的是连接、参数配置及资源额度，消息、记忆、工具集、供应商会话和私密上下文必须分别隔离。

首版 5 个人类派系、3 个非人类势力、12 个角色最多 20 个活跃 gameplay 身份。模型池并发上限是另一组资源约束，不因配置 20 个 Agent 就默认启动 20 路请求。

在线与实验活跃身份合计不得超过 20；完整 20 Agent 对比暂停在线，逐分支执行。改变挂载不改变 Agent 身份，memory-maintenance 和 speech 也不另占身份。

## 2. 三类配置职责

| 配置 | 内容 | 禁止内容 |
|---|---|---|
| connections | adapterId、受控 endpoint、credentialRef、账号级 rateLimitKey | 明文密钥、Agent 消息历史 |
| models | modelId、connectionId、外部模型名、生成参数、能力与资源上限 | 每个角色的主张、记忆与授权 |
| mounts | modelId、agentIds、purposes，精确挂载关系 | 复制模型参数、放宽工具权限 |

credentialRef 由服务端 secret resolver 解析；前端只能看到连接别名与验证状态。导出 manifest 保留引用及配置 hash，删除实际密钥、认证 header、Cookie 和敏感 URL 参数。

modelId 是本平台配置 ID，externalModel 是供应商名称；两者都记录。不同 modelId 若共用同一账号，仍受同一 rateLimitKey 总限额，不能通过多起别名规避配额。

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

evaluation 由独立 evaluator 配置引用 modelId，调用主体类型为 evaluator；它不是第 21 个 NPC，没有 gameplay 工具、世界写权限或个人记忆。gameplay mounts 只能挂载前五类 purpose，不接受 evaluation。

## 4. 目标配置示例

下例展示同一模型挂载全部 20 个 Agent，参数仅为设计起点；示例 endpoint 和外部模型名需由部署配置替换并通过连接测试，不代表真实可用供应商。

~~~yaml
schemaVersion: 1
connections:
  primary:
    adapterId: model.http-compatible
    endpoint: https://provider.example/v1
    credentialRef: env:NPC_MODEL_API_KEY
    rateLimitKey: primary-account
models:
  npc-shared:
    connectionId: primary
    externalModel: configured-chat-model
    parameters:
      temperature: 0.6
      maxOutputTokens: 1200
    limits:
      maxConcurrent: 2
      requestsPerMinute: 20
      tokensPerMinute: 40000
      requestTimeoutMs: 20000
mounts:
  - modelId: npc-shared
    agentIds:
      - human-independent
      - human-earth-alliance
      - human-pacifist
      - human-alien-accord
      - human-neutral
      - species-fauna
      - species-flora
      - species-extraterrestrial
      - npc-cenyan
      - npc-linwu
      - npc-qiaoshu
      - npc-yinuo
      - npc-shenli
      - npc-guxun
      - npc-tangzhen
      - npc-suhui
      - npc-wenyuan
      - npc-zhuifeng
      - npc-qingzhi
      - npc-luo
    purposes: [decision, speech, memory-maintenance, compression]
evaluator:
  enabled: false
  principalId: evaluator-judge
  modelId: npc-shared
~~~

这是共享模型的完整挂载示例，不表示所有策略都必须进行模型反思或压缩。embedding 未启用；需要时在 models 声明向量模型，并为所需主体增加不冲突的 embedding 挂载。

让 npc-cenyan 使用另一模型时，在 models 增加一次定义，并从原挂载的对应 purpose 移除该身份，再新增指向新 modelId 的挂载。不能保留重叠行后依赖“最后一条优先”。

若一个 Agent 的 decision 和 speech 使用不同模型，拆成两条 purpose 不重叠的挂载；不把两份 LLM 配置复制到角色档案。配置 UI 应同时提供“按模型看挂载”和“按角色看已解析路由”。

## 5. 解析与 run 冻结

算法 profile 装配顺序为平台配置 → 场景 profile → 可复用 Agent profile → 实验 variant patch。Agent profile 只声明 required purposes/capabilities，不隐式选择 modelId 或覆盖路由；模型布局唯一由 RunSpec.modelLayoutRef 选择集中 connections/models/mounts 版本，再预检并写入 resolved manifest。

1. 校验 connections/models 的引用、字段、单位、有限上限与 adapter 可用性。
2. 将 mounts 展开为唯一 `(agentId, purpose) → modelId`；未知身份或重复键立即报错。
3. 由激活 roster、策略能力与运行模式确定 required purposes；缺少挂载报错，不自动套默认模型。
4. 从 modelId 解析 connection、externalModel、参数、tokenizer 与能力证据，检查与工具/输出协议兼容。
5. 生成去密钥的路由表、请求能力、预算、显式 fallback、版本与 hash，并随 run 持久化。

每个 run 独占 branchId，激活期间绑定 profileHash 和模型池快照。控制台改动只对新 run 生效；在线切换在维护边界创建后继分支/run，不修改已开始样本的路由。

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
- 重叠挂载、未知 agentId、缺 purpose、坏引用与不兼容能力均在预检失败。
- 改一个模型定义后新 run 的所有相关挂载一致更新，既有 run 的冻结路由不变。
- 同账号不同 modelId 共同触达总限额，队列有界且低优先维护不会永久饥饿。
- 在排队/调用/返回阶段接管或取消，验证旧结果不能下令、写认知或发布对白。
- 检查失败、重试、fallback、未知 usage 和 evaluator 费用全部可定位且不漏算。

观测、配置与实验规则分别见 [可观测性](../platform/observability.md)、[配置体系](../platform/configuration.md)、[评估](../platform/evaluation.md)；运行阶段见 [Runtime](runtime.md)。

## 11. 参考边界

借鉴 deepseek-harness 的 [可替换 LLM 服务与适配器](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/llm/llm/src/index.ts)。集中 models/mounts、NPC purpose 路由、公平队列和 20 身份限制是本项目设计，不声称参考框架已经提供这一游戏模型池。
