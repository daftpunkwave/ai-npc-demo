# 模型传输：统一 ModelPort 与三个适配器

> 状态：已实现。当前装配支持 OpenAI 兼容、Anthropic 与本地夹具驱动的确定性模型传输；真实供应商连通性按部署凭据单独验证。本文维护规范化线协议及三种传输方案的配置。参见 [model-pool.md — 模型池](model-pool.md)、[prompts.md — Prompt 与输出契约](prompts.md)。

## 1. 分层

```text
agent-runtime / memory / compression
        │  ModelCallRequest(agentId, purpose, ...)
        ▼
agent.model-pool.shared   ── resolves (agentId, purpose) -> modelId -> connection, queues, budgets, retries, archives
        │  ModelRequest (normalized)
        ▼
platform.model-transport.<adapter>   ── maps to wire protocol, single attempt, no retries
        │
        ▼
provider HTTP API / deterministic fixtures
```

- 适配器只做“一次尝试”：不重试、不排队、不记账、不选模型。重试与退避由模型池负责，每次重试都是新的 `attemptId`。
- 适配器拿到的密钥来自 `platform.secrets.env` 按 `credentialRef` 解析出的值；适配器不读环境变量。
- 每次请求要么带工具（decision 的工具循环），要么带 JSON 输出格式（speech、memory-maintenance、compression），**不会同时使用**，以避免各供应商在两者组合上的差异。

## 2. 规范化类型（`packages/contracts`）

```ts
type Purpose = "decision" | "speech" | "memory-maintenance" | "compression" | "embedding" | "evaluation";

interface NormalizedTool {
  readonly name: string;            // 线上传输名，见 §6
  readonly description: string;
  readonly inputSchema: JsonSchema; // 严格 schema profile，见 §7
}

interface NormalizedToolCall {
  readonly id: string;              // 供应商调用 ID
  readonly name: string;            // 线上传输名
  readonly arguments: Json | null;  // 解析后的对象；解析失败时为 null
  readonly argumentsRaw: string;    // 供应商发送的原始文本
  readonly parseError: string | null;
}

type NormalizedMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly toolCalls: readonly NormalizedToolCall[];
      readonly providerReplay: Json | null }   // 供应商原生内容，仅由同一适配器按其历史规则回放
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string; readonly isError: boolean };

interface ModelRequest {
  readonly llmCallId: string;
  readonly attemptId: string;
  readonly purpose: Purpose;
  readonly externalModel: string;
  readonly system: string;          // 同一工具循环的各轮之间必须保持逐字节一致
  readonly messages: readonly NormalizedMessage[]; // 同一工具循环内只追加
  readonly tools: readonly NormalizedTool[];       // 同一工具循环内必须保持一致
  readonly output: { readonly kind: "text" } | { readonly kind: "json"; readonly schemaName: string; readonly schema: JsonSchema };
  readonly maxOutputTokens: number;
  readonly parameters: Json;        // 适配器专用，由适配器的 configSchema 校验
  readonly timeoutMs: number;
  readonly context: {               // 仅用于夹具与归档；真实适配器忽略
    readonly agentId: string | null;
    readonly evaluatorId: string | null;
    readonly workRef: string;       // turn ID、整理任务 ID 或探针 ID
    readonly round: number;         // 工具循环内从 1 开始；单次调用固定为 1
    readonly triggerPrincipalIds: readonly string[]; // 本 turn 各 trigger 的发言者或发送者
    readonly contextArtifactId?: string; // 可用时归档本轮上下文
  };
}

interface ModelResponse {
  readonly finishReason: "stop" | "tool_calls" | "length" | "refusal";
  readonly text: string | null;
  readonly json: Json | null;       // output.kind === "json" 时解析
  readonly jsonError: string | null;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly providerReplay: Json | null;
  readonly usage: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; estimated: boolean };
  readonly servedModel: string | null;      // 供应商报告的模型 ID
  readonly providerRequestId: string | null;
  readonly fallbackUsed: boolean;           // 供应商在调用内部切换了模型
  readonly wire: { readonly requestBody: Json; readonly responseBody: Json }; // 归档内容，绝不包含凭据
}

interface ModelTransportError {
  readonly kind: "rate-limited" | "timeout" | "network" | "server" | "bad-request" | "auth" | "not-found" | "protocol";
  readonly retryable: boolean;      // rate-limited、timeout、network、server 可重试
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;
  readonly message: string;         // 安全信息，不含凭据
}

interface ModelTransportPort {
  readonly adapterId: string;
  readonly capabilities: (modelConfig: Json, model?: string) => ModelCapabilities;
  validateConnection?(connection: ModelConnectionInput): Promise<{ readonly ok: boolean; readonly error?: string }>;
  complete(request: ModelRequest, credential: string | null, connection: ModelConnectionInput):
    Promise<ModelResponse>; // 失败时抛出 ModelTransportError
  embed?(input: { externalModel: string; texts: readonly string[]; timeoutMs: number }, credential: string | null, connection?: ModelConnectionInput):
    Promise<{ vectors: number[][]; usage: { inputTokens: number | null } }>;
}

interface ModelConnectionInput {
  readonly endpoint: string | null;
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly jsonOutputSuffix?: string;
  readonly fixtures: readonly ModelFixture[];
  readonly signal: AbortSignal;
}

interface ModelCapabilities {
  readonly toolCalling: boolean;
  readonly strictTools: boolean;
  readonly structuredOutput: "json_schema" | "json_object" | "none";
  readonly assistantReplay: "standard" | "verbatim";   // 仅 OpenAI 兼容适配器使用，见 §3.1
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly embedding: boolean;
  readonly embeddingDimensions: number | null;
}
```

`finishReason: "refusal"` 与 `jsonError != null` 都算该 attempt 失败（`protocol`），由调用方决定是否进入安全模板；`length` 时不执行其中的工具调用。

## 3. OpenAI 兼容适配器

### 3.1 配置

```yaml
connections:
  openai-compat:
    adapterId: platform.model-transport.openai-compatible
    endpoint: env:NPC_OPENAI_COMPAT_BASE_URL     # e.g. https://api.deepseek.com/v1 or http://127.0.0.1:11434/v1
    credentialRef: env:NPC_OPENAI_COMPAT_API_KEY # empty value allowed for local servers
    rateLimitKey: openai-compat-account
models:
  npc-chat:
    connectionId: openai-compat
    externalModel: env:NPC_OPENAI_COMPAT_MODEL
    parameters: { temperature: 0.6, maxTokensField: max_tokens }
    capabilities: { toolCalling: true, strictTools: false, structuredOutput: json_object, assistantReplay: verbatim,
                    contextWindowTokens: 64000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null }
    limits: { maxConcurrent: 2, requestsPerMinute: 20, tokensPerMinute: 40000, requestTimeoutMs: 30000 }
    maxOutputTokensByPurpose: { decision: 1500, speech: 400, memory-maintenance: 800 }
```

`assistantReplay` 决定同一工具循环内怎样回传上一轮的 assistant 消息：`standard` 只回传 `role`、`content`、`tool_calls`；`verbatim` 把供应商返回的 assistant 消息对象原样回传（包括 `reasoning_content` 之类的扩展字段）。有的推理模型要求在工具循环内回传这类字段，有的会拒绝它们，按所用供应商的文档设置。`env:NAME` 形式的值在预检时解析；`externalModel` 与 `endpoint` 不是秘密，解析结果写入 manifest，`credentialRef` 只记录引用名。`capabilities` 由部署者按供应商文档填写，预检时与工具、输出协议核对。控制台的 `/model-layouts/{id}/probe` 实测接口属[目标契约](../architecture/api.md#52-模型池)，尚未实现；配置真实凭据后的连通性验证使用 `tests/live/` 下的手动用例。

### 3.2 请求映射

`POST {endpoint}/chat/completions`，请求头 `Authorization: Bearer <credential>`（凭据为空时不发这个头）、`Content-Type: application/json`。一次请求要么带工具（decision），要么带 JSON 输出格式（speech、整理），不会同时带。decision 请求体示例（第二轮）：

```json
{
  "model": "<externalModel>",
  "messages": [
    { "role": "system", "content": "<system>" },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": null, "tool_calls": [ { "id": "call_1", "type": "function", "function": { "name": "world_inspect", "arguments": "{\"nodeId\":\"pass\"}" } } ] },
    { "role": "tool", "tool_call_id": "call_1", "content": "{...}" }
  ],
  "tools": [ { "type": "function", "function": { "name": "world_inspect", "description": "...", "parameters": { } } } ],
  "tool_choice": "auto",
  "temperature": 0.6,
  "max_tokens": 1500,
  "stream": false
}
```

speech 请求体示例（`structuredOutput: json_object`，schema 说明追加在 system 末尾）：

```json
{
  "model": "<externalModel>",
  "messages": [
    { "role": "system", "content": "<system>\n只输出一个 JSON 对象，必须符合下面的 JSON Schema：\n{...}" },
    { "role": "user", "content": "..." }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.6,
  "max_tokens": 400,
  "stream": false
}
```

| 规范化字段 | 映射 |
|---|---|
| `system` | 第一条 `role: system` 消息 |
| user / tool 消息 | 按上例 |
| assistant 消息 | `assistantReplay: verbatim` 且有 `providerReplay` 时原样回传该对象；否则构造 `{ role: "assistant", content, tool_calls }`，`arguments` 用原始 `argumentsRaw` 字符串 |
| `tools` 非空 | 发 `tools` 与 `tool_choice: "auto"`；`capabilities.strictTools` 为 true 时在每个 function 上加 `"strict": true` |
| `tools` 为空 | 不发 `tools` 与 `tool_choice` |
| `output.kind === "json"` | `structuredOutput` 为 `json_schema` 时发 `{"type":"json_schema","json_schema":{"name":<schemaName>,"schema":<schema>,"strict":true}}`；为 `json_object` 时发 `{"type":"json_object"}`，并在 system 末尾追加换行、`jsonOutputSuffix`（“只输出一个 JSON 对象，必须符合下面的 JSON Schema：”）、换行与 schema 文本；为 `none` 时只追加这段说明 |
| `maxOutputTokens` | 写到 `parameters.maxTokensField` 指定的字段（`max_tokens` 或 `max_completion_tokens`） |
| `parameters.temperature` | 配置了才发送 |

超时：用 `AbortSignal.timeout(timeoutMs)` 传给 `fetch`。

### 3.3 响应映射

| 来源 | 规范化字段 |
|---|---|
| `choices[0].message.content` | `text`（可能为 null） |
| `choices[0].message.tool_calls[]` | `toolCalls`：`arguments` 用 `JSON.parse` 解析，失败时为 null 并写 `parseError` |
| `choices[0].finish_reason` | `stop`→stop，`tool_calls`→tool_calls，`length`→length，`content_filter`→refusal（`message.refusal` 非空时同样归为 `refusal`），其他值→stop |
| `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | `usage`（缓存命中数缺省时回退读 `usage.prompt_cache_hit_tokens`）；缺失为 null |
| `model`、`id` | `servedModel`、`providerRequestId` |
| `choices[0].message`（整个对象） | `assistantReplay` 为 `verbatim` 时作为 `providerReplay`，否则 `providerReplay = null` |
| — | `fallbackUsed = false` |

JSON 输出解析：去掉首尾空白与 Markdown 代码围栏，取第一个括号配平的 `{...}` 子串再 `JSON.parse`；失败写 `jsonError`。

HTTP 错误：400/422 → `bad-request`；401/403 → `auth`；404 → `not-found`；408/409/429 → `rate-limited`（`Retry-After` 秒数换算为 `retryAfterMs`）；≥500 → `server`；`fetch` 因超时中止 → `timeout`；其他网络异常 → `network`；响应不是合法 JSON 或缺少 `choices` → `protocol`。

### 3.4 向量

`POST {endpoint}/embeddings`，请求体 `{ "model": <externalModel>, "input": [<texts>] }`，取 `data[i].embedding`。首版的记忆实现不依赖向量（见 [记忆](memory.md) 第 11 节），只在模型配置声明 `embedding: true` 且某个 profile 启用时使用。

## 4. Anthropic 适配器

### 4.1 配置

```yaml
connections:
  anthropic:
    adapterId: platform.model-transport.anthropic
    credentialRef: env:ANTHROPIC_API_KEY
    rateLimitKey: anthropic-account
models:
  npc-claude:
    connectionId: anthropic
    externalModel: claude-opus-5-5
    parameters: { effort: medium, serverSideFallback: default, strictTools: false }
    limits: { maxConcurrent: 2, requestsPerMinute: 30, tokensPerMinute: 200000, requestTimeoutMs: 120000 }
    maxOutputTokensByPurpose: { decision: 16000 }
```

能力由适配器按模型固定给出：工具调用可用，`structuredOutput: json_schema`，`contextWindowTokens: 1000000`，`maxOutputTokens: 128000`，`embedding: false`。`parameters.strictTools` 默认 false：工具 schema 较大、可空字段较多时，严格模式可能触及 API 对 strict schema 的复杂度限制；宿主对每个工具调用都会用原始 Zod schema 校验，不合格的调用返回错误结果让模型重试。`connections.anthropic.endpoint` 可省略，省略时用 SDK 默认地址。

### 4.2 请求映射

```ts
import Anthropic from "@anthropic-ai/sdk";

// 每个连接只创建一个客户端；重试由模型池负责，SDK 不得自行重试。
const client = new Anthropic({ apiKey: credential, maxRetries: 0 });

const params = {
  model: request.externalModel,                        // 例如 "claude-opus-5-5"
  max_tokens: request.maxOutputTokens,
  system: request.system,
  messages: toAnthropicMessages(request.messages),     // 映射见下表
  ...(request.tools.length > 0 && {
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema,
                                       ...(parameters.strictTools === true && { strict: true }) })),
    tool_choice: { type: "auto" as const },            // claude-opus-5-5 会拒绝强制工具选择
  }),
  output_config: {
    effort: parameters.effort ?? "medium",
    ...(request.output.kind === "json" && { format: { type: "json_schema" as const, schema: request.output.schema } }),
  },
};

const options = { timeout: request.timeoutMs };         // 单次请求超时
const response = parameters.serverSideFallback === "off"
  ? await client.messages.create(params, options)
  : await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, options);
```

规则：

- 不发送 `temperature`、`top_p`、`top_k`，也不发送 `thinking` 字段：`claude-opus-5-5` 始终使用自适应思考，深度只用 `output_config.effort` 控制（默认 `medium`，建议 speech 与 memory-maintenance 配 `low`）。
- 默认开启服务端 refusal fallback（`fallbacks: "default"`）。它在同一次调用内换模型，因此适配器必须如实报告 `fallbackUsed` 与 `servedModel`；正式单变量实验里出现 fallback 的样本按 [评估](../platform/evaluation.md) 第 8 节标为无效。部署者可以在模型配置里设 `serverSideFallback: off` 关闭。
- `maxOutputTokens` 包含思考所用的 token，不要设得过小；decision 建议 16000、speech 建议 4000。模型池的预算预留使用 profile 里的 `reserveOutputTokens`，与这个硬上限分开（见 [模型池](model-pool.md) 第 12.4 节）。
- SDK 类型请直接使用 `@anthropic-ai/sdk` 导出的类型（`Anthropic.MessageParam`、`Anthropic.Tool` 等），不要自己重新定义；只有在使用 beta 接口时才用 beta 命名空间下的类型。

消息映射（`toAnthropicMessages`）：

| 规范化消息 | Anthropic 消息 |
|---|---|
| user | `{ role: "user", content: <text> }` |
| assistant，带 `providerReplay`（来自本适配器的上一轮响应） | `{ role: "assistant", content: <providerReplay> }`。没有服务端 fallback 时原样回放，包含 thinking 块；有 fallback 时保留 `text` 与 `fallback` 边界，丢弃最终边界前的 `thinking`/`redacted_thinking`/客户端 `tool_use`，并保留最终边界后的全部块 |
| assistant，不带 `providerReplay` | `{ role: "assistant", content: [{type:"text",text}] + [{type:"tool_use", id, name, input: arguments}] }`，文本为空时省略 text 块 |
| 连续的多条 tool 消息 | 合并成**一条** user 消息：`{ role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }, ...] }` |

一个 turn 的工具循环内，`system` 与 `tools` 必须逐字节保持不变，`messages` 只能在末尾追加。不要改写、删除或重排之前的消息，也不要从中间删除 thinking 块；否则后续请求会被拒绝（400），或模型丢失之前的推理。需要压缩上下文时，只能在一个 turn 的第一次请求之前进行（见 [压缩与工具视图](compression-and-tool-view.md) 第 12 节）。

### 4.3 响应映射

| 来源 | 规范化字段 |
|---|---|
| `response.content` 中的 `text` 块 | 依次拼接为 `text` |
| `tool_use` 块 | `toolCalls`：`id`、`name`、`arguments = input`、`argumentsRaw = JSON.stringify(input)` |
| 整个 `response.content` 数组 | `providerReplay`，原样保存，下一轮回放 |
| `stop_reason` | `end_turn`/`stop_sequence`→stop，`tool_use`→tool_calls，`max_tokens`/`model_context_window_exceeded`→length，`refusal`→refusal；`pause_turn` 视为 `protocol` 错误（首版不用服务端工具） |
| `usage` | `inputTokens = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)`（`input_tokens` 不含缓存部分）、`outputTokens = output_tokens`、`cachedInputTokens = cache_read_input_tokens`；有 `usage.iterations` 时把它原样存进响应 artifact，供核对 fallback 的计费 |
| `response.model`、`response.id` | `servedModel`、`providerRequestId` |
| `content` 中存在 `type: "fallback"` 的块，或 `usage.iterations` 中存在 `type: "fallback_message"` 的条目 | `fallbackUsed = true` |

先检查 `stop_reason`，再读取内容：`refusal` 时内容可能不符合 schema，不做解析；`max_tokens` 时不执行其中的工具调用。JSON 输出从 `text` 解析（与 3.3 节相同的解析规则），再用 Zod 校验。

错误分类按 SDK 的类型化异常，从具体到一般判断（在 TypeScript SDK 中 `APIConnectionError` 是 `APIError` 的子类，必须先判断）：

| 异常 | kind |
|---|---|
| `Anthropic.APIConnectionTimeoutError` | `timeout`（retryable；它是 `APIConnectionError` 的子类，要最先判断） |
| `Anthropic.BadRequestError`、`Anthropic.UnprocessableEntityError` | `bad-request` |
| `Anthropic.AuthenticationError`、`Anthropic.PermissionDeniedError` | `auth` |
| `Anthropic.NotFoundError` | `not-found` |
| `Anthropic.RateLimitError` | `rate-limited` |
| `Anthropic.InternalServerError` | `server` |
| `Anthropic.APIConnectionError` | `network`（retryable） |
| 其他 `Anthropic.APIError` | 按 HTTP 状态码归入上面各类 |

不要用字符串匹配错误信息。

## 5. 确定性适配器（测试）

`platform.model-transport.deterministic` 只出现在测试装配 `local-slg-test-v1` 中，不发网络请求、不产生费用，用来验证事务、工具循环、fencing 与记忆链路，不能用来声称模型行为效果。

```yaml
connections:
  fixtures:
    adapterId: platform.model-transport.deterministic
    fixtureFiles: [tests/fixtures/model/default.jsonl]   # loaded in order; first match wins
models:
  npc-fixture:
    connectionId: fixtures
    externalModel: deterministic-v1
```

`npc-fixture` 的 `maxOutputTokensByPurpose` 采用第 3.1 节 `npc-chat` 的配置。

fixture 文件每行一个 JSON：

```json
{"id":"cenyan-refuse-escort","match":{"purpose":"decision","agentId":"human-independent","round":1,"inputIncludes":["护送"]},
 "response":{"finishReason":"tool_calls","toolCalls":[{"name":"decision_submit","arguments":{"stance":"decline","dialogueIntent":{"kind":"refuse","audience":["player-1"],"tone":"cold","reasonCode":"past-breach","subjectRef":null,"factRefs":[]},"noteworthy":[],"citedMemoryIds":[],"decisionNote":"fixture"}}]}}
```

- `match` 的全部字段都满足才命中。可选条件包括 `agentId`、`round`、`schemaName`、`triggerPrincipalCount` 及 `inputIncludes`。发言主体数为零的自主回合命中无对白夹具，文本条件在 `system` 与全部消息的拼接文本中匹配。
- 响应可以是正常结果，也可以是故障注入：`{"error":{"kind":"timeout"}}`、`{"delayMs":5000, ...}`（先等待再返回，用于测试晚到结果被 fencing 拒绝）。
- 响应可以设置 `"usage": null` 模拟供应商缺少用量。账本按本次预留结算并标记用量未知。
- 没有命中时返回默认值：decision 返回一次 `decision_submit`，完整参数为 `{ stance: "none", dialogueIntent: { kind: "acknowledge", audience: request.context.triggerPrincipalIds, tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] }, noteworthy: [], citedMemoryIds: [], decisionNote: "" }`；默认 decision 仅适用于触发主体均为本次请求中合法 principal 且数量为 1–4 人的请求，否则须提供合法 fixture，不得靠截断受众伪装成功；speech（schemaName `speech`）返回 `{"utterance":"我知道了。","citedRefs":[]}`；schemaName `reflection` 返回 `{"reflections":[]}`；schemaName `daily-review` 返回 `{"beliefOps":[],"currentConcerns":null,"intents":[]}`；embedding 返回由文本 SHA-256 确定的 64 维向量。
- `usage` 用 [上下文](context.md) 第 11 节的 token 估算函数计算，标记 `estimated: true`。
- `servedModel = "deterministic-v1"`，`fallbackUsed = false`。

## 6. 工具名映射

工具在平台内的 ID 带点号（如 `world.inspect`），而 OpenAI 兼容协议与 Anthropic 协议的工具名都只允许 `[a-zA-Z0-9_-]`。规则：

- `wireName = toolId.replaceAll(".", "_")`，例如 `world.inspect` → `world_inspect`，`decision.submit` → `decision_submit`。
- 工具注册时检查 `wireName` 匹配 `^[a-zA-Z0-9_-]{1,64}$` 且全局唯一，冲突即启动失败。
- 工具网关收到工具调用时，用反向表把 `wireName` 映射回 `toolId`；未知名字按“未授权工具”返回错误结果，不执行。

## 7. 面向模型的 JSON Schema（strict profile）

工具输入与 JSON 输出的 schema 都由 Zod 定义，用 `z.toJSONSchema()` 生成，再按以下规则清洗后发给模型：

1. 含固定 `properties` 的普通 object 设 `additionalProperties: false`，并把全部属性列入 `required`。可选字段在 Zod 里写成 `.nullable()`，不要用 `.optional()`。没有固定属性的 `record` 或自由对象保留输入中的 `additionalProperties: true` 或子 schema，不把“无固定属性”收窄为只能传空对象。同时声明固定 `properties` 与开放 `additionalProperties` 的对象无法由 strict profile 表达，清洗时直接拒绝；只有 `additionalProperties: false` 的对象按闭合空对象处理。
2. 删除模型协议不支持的约束关键字：`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`、`minLength`、`maxLength`、`pattern`、`minItems`、`maxItems`、`uniqueItems`、`format`、`default`、`$schema`。
3. 不允许递归 schema；出现 `$ref` 时内联展开。
4. 只保留白名单关键字：`type`、`properties`、`required`、`items`、`enum`、`const`、`anyOf`、`description`、`additionalProperties`（可空字段写成 `type: ["x", "null"]` 或 `anyOf` 含 `null`）；`oneOf` 改写为 `anyOf`；`$defs`/`definitions` 在内联后删除；`propertyNames` 等其他关键字一律删除。

模型返回后，必须用**原始** Zod schema（含被删掉的长度与范围约束）重新校验；不通过就按 `protocol` 失败处理。清洗函数放在 `packages/contracts`，并有单元测试覆盖以上四条。工具 schema 不使用判别联合与 record（[工具](tools.md) 第 13.1 节）；清洗函数仍须正确保留其他调用方定义的 `record` 语义。

## 8. 归档与脱敏

每次 attempt 由模型池写两个 artifact：请求 artifact（规范化请求 + `wire.requestBody`）与响应 artifact（`wire.responseBody` + 规范化响应 + 错误）。请求体本来就不含凭据；写入前再扫描一遍，若出现凭据原文则替换为 `[REDACTED]` 并记一条安全生命周期事件。artifact 访问规则见 [观测](../platform/observability.md) 第 3 节。

## 9. 验收

- 同一条规范化请求分别经两个真实适配器，生成的请求体与本文映射表一致（用快照测试锁定，不发网络请求：对 Anthropic 适配器注入假的 `fetch` 或拦截 SDK 请求）。
- 两轮工具循环中，Anthropic 适配器的第二次请求以第一次的 `response.content` 原样作为 assistant 消息，`system` 与 `tools` 字节相同；并行工具结果合并在一条 user 消息里。
- 工具名映射往返一致，冲突在注册时失败。
- OpenAI 兼容适配器在 `json_object` 能力下把 schema 追加到 system，返回的围栏 JSON 能被正确解析。
- 429 与 5xx 被归类为可重试；400 与 401 不可重试；`refusal` 与 JSON 校验失败记为 `protocol`。
- 确定性适配器的 fixture 匹配顺序、默认响应、超时与延迟注入都有测试。
- `tests/live/` 下各有一个真实连通性用例（只在设置了 API key 时手动运行），验证一次 decision 工具循环与一次 speech JSON 输出。
