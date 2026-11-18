# 公共契约与协议语义

> 以下是待实现的 TypeScript 公共类型示意，实际 schema 由 `packages/contracts` 维护。跨模块共有的语义由本文维护；Module/Plugin 机制见 [插件机制](plugins.md)，Tool、Model、Memory 的专有字段由对应专篇维护，其他文档只引用，不再复制一份契约。

## 1. 身份、事件与输入边界

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Realm = "server" | "client" | "console";

interface MemoryScope {
  readonly worldId: string;
  readonly branchId: string;
  readonly agentId: string;
}

interface ContentRef {
  readonly contentId: string;
  readonly contentVersion: string;
  readonly itemId?: string;
}

interface InputFrontier {
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly observationSeq: number;
  readonly perceptionRevision: number;
  readonly memoryRevision: number;
  readonly conversationCursor: string | null;
  readonly knowledgeGrantRevision: number;
}

interface EventEnvelope {
  readonly eventId: string;
  readonly schemaVersion: number;
  readonly worldId: string;
  readonly branchId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly type: string;
  readonly principalId: string;
  readonly causationIds: readonly string[];
  readonly correlationId: string;
  readonly audience: readonly AudienceSpec[]; // domain-model §7
  readonly payload: Json;
}

interface AgentObservation {
  readonly observationId: string;
  readonly scope: MemoryScope;
  readonly observationSeq: number;
  readonly sourceEventIds: readonly string[];
  readonly sourceObservationIds: readonly string[];
  readonly occurredAtTick: number;
  readonly sensedAtTick: number;
  readonly knownAtTick: number;
  readonly channel: string;
  readonly epistemic: "witnessed" | "reported" | "inferred"; // 怎么知道
  readonly confidence: number;
  readonly releasePolicyId: string;
  readonly content: Json;
}

interface MemoryRecord {
  readonly memoryId: string;
  readonly scope: MemoryScope;
  readonly kind: "episodic" | "relation" | "belief" | "prospective" | "core" | "public";
  readonly sourceObservationIds: readonly string[];
  readonly contentRefs: readonly ContentRef[];
  readonly status: "active" | "superseded" | "expired" | "evicted" | "retracted";
  readonly epistemic: "verified-event" | "reported-claim" | "inference"; // 证据地位
  readonly releasePolicyId: string;
  readonly validFromTick: number;
  readonly validUntilTick: number | null;
  readonly revision: number;
  readonly content: Json;
}
```

`AgentObservation.epistemic` 与 `MemoryRecord.epistemic` 是两个不同的枚举：前者表示获知方式（亲历/转述/推断），后者表示记忆的证据地位（已验证事件/声称/推断）。两者不能互换，也不能合并成一个字符串；传播权限另由 `releasePolicyId` 表达。scope 和事件 envelope 由服务端赋值或验证，worldSeq 在 branch 内排序。来源 ID 必须存在，并且落在合法的知识边界内。版本化的身份和 lore 用独立 contentRef 表达，不能拿来伪造观察来源。

InputFrontier 由 scope 绑定，是每个 Agent 的冻结边界；多主体快照按身份各存一份 frontier map。同一个 worldSeq 下，延迟观察也可能稍后送达，所以必须同时冻结 observationSeq、perceptionRevision 和 knowledgeGrantRevision，只比较世界序号不够。memoryRevision 指向满足边界的不可变视图；conversationCursor 限定该主体有权使用的会话日志。

时间顺序上，occurredAtTick 不晚于 sensedAtTick，sensedAtTick 不晚于 knownAtTick；confidence 必须是 0 到 1 的有限数，channel 从已注册渠道解析。运行中经历到的观察，来源不能为空；contentRefs 只用于版本化背景，不能替代经历证据。JSON 只是传输形态，实际 payload 按 type 和 schemaVersion 查 schema registry；未知命令、未知字段、错误版本都拒绝。

## 2. 命令与 receipt

CommandEnvelope 包含 commandId、type、schemaVersion、expectedVersions 与 payload；principal、world/branch、controllerEpoch 和 turnLeaseEpoch 由认证上下文或宿主附加。模型不能靠自报 author 取得权限。

CommandReceipt 包含 receiptId、commandId、commandStatus、reasonCode、acceptedEventIds、operationId 与 resultingVersions。commandStatus 只有 accepted 或 rejected 两个值，是不可变的提交回执；accepted 不代表异步任务已经完成。幂等键和 payloadHash 都相同的请求返回原 receipt，不重复执行；键相同但内容不同的请求拒绝。

异步任务投影使用独立的 taskStatus：pending、running、completed、failed、cancelled。ToolResult 使用 executionStatus：ok、error、unknown。ok 表示网关拿到了确定的合法响应，响应里仍可能带 commandStatus=rejected；unknown 表示副作用结果未确认，必须去查 receipt。工具视图不得把这几个层次的状态混成一个 status，也不能省略失败。没有任务的只读结果不伪造 taskStatus。

## 3. 模块、能力与装配

跨域契约只描述“可替换单位及其端口”，不泄露实现。以下为示意，字段以 `packages/contracts` 的 schema 为准：

```ts
type ModuleKind = "service" | "contributor" | "adapter";
type InstanceScope = "deployment" | "run" | "branch" | "agent" | "session";
type Cardinality = "exactly-one" | "many" | "optional";

type CapabilityId = string & { readonly __brand: "CapabilityId" }; // 如 "game.clock"、"agent.memory"

interface CapabilityRef {
  readonly capability: CapabilityId;
  readonly cardinality: Cardinality;
  readonly instanceScope: InstanceScope;
}

interface ModuleRef {
  readonly moduleId: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly configHash: string;
}

interface ResolvedModuleSet {
  readonly realm: Realm;
  readonly protocolVersion: string;
  readonly modules: readonly ModuleRef[];
  readonly capabilities: readonly CapabilityRef[];
  readonly assemblyHash: string;
}

type AgentSlot = "perception" | "memory" | "context" | "compression" | "toolView" | "decision";

interface AssemblyDescriptor {           // file format: platform/configuration.md §10.1
  readonly schemaVersion: number;
  readonly assemblyId: string;
  readonly configs: Readonly<Record<string, Json>>;          // named config blocks
  readonly realms: {
    readonly server: {
      readonly bindings: readonly CapabilityBinding[];
      readonly agentSlots: Readonly<Record<AgentSlot, readonly string[]>>; // implementations profiles may pick
    };
    readonly client: { readonly bindings: readonly CapabilityBinding[] };
    readonly console: { readonly bindings: readonly CapabilityBinding[] };
  };
}

interface CapabilityBinding {
  readonly capability: CapabilityId;
  readonly moduleId: string;
  readonly configRef: string | null;     // key in AssemblyDescriptor.configs
  readonly fallbackModuleIds?: readonly string[]; // unused in the first version (strict, no fallback)
}

interface ModuleDefinition {
  readonly id: string;                 // <group>.<family>.<impl>；server 用 game/agent/platform/transport，浏览器用 client/console
  readonly realm: Realm;
  readonly kind: ModuleKind;
  readonly version: string;
  readonly apiVersion: string;
  readonly instanceScope: InstanceScope;
  readonly provides: readonly CapabilityRef[];
  readonly requires: readonly CapabilityRef[];
  readonly requiresRemote: readonly CapabilityId[]; // 仅浏览器 realm
  readonly configSchema: StrictConfigSchema;
  readonly defaults?: Json;
  readonly stateSchemaVersion: number | null;
  readonly ownsAggregates?: readonly string[];   // game modules: aggregate types this module may write (domain-model §4)
  readonly migrationPaths: readonly MigrationPath[];
  readonly contributions?: readonly ContributionRef[];
  readonly experimentAxes?: readonly ExperimentAxis[];
  create(input: ModuleCreateInput): Promise<ModuleInstance>;
}

interface ModuleInstance {
  readonly moduleId: string;
  start(signal: AbortSignal): Promise<void>;
  drain(deadlineMs: number): Promise<void>;
  dispose(): Promise<void>;
  readonly port?: unknown; // 由 kind/capability 映射收窄，禁止 any 万能入口
}

interface ModuleCreateInput {
  readonly moduleId: string;
  readonly realm: Realm;
  readonly config: Json;                                   // validated against configSchema, defaults applied
  readonly scope: { readonly worldId?: string; readonly branchId?: string; readonly agentId?: string; readonly sessionId?: string };
  readonly ports: Readonly<Record<string, unknown>>;       // resolved `requires`, keyed by capability id, narrowed by the kind mapping
  readonly host: HostServices;
  readonly signal: AbortSignal;
}

interface HostServices {                                   // the only way modules reach time, randomness, ids and I/O
  ids(prefix: string): string;
  nowIso(): string;
  monotonicMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>; // the only way a module waits (backoff, polling)
  rng(...seedParts: string[]): () => number;               // rules.md §11
  hash(value: Json): Promise<string>;                      // sha256 of canonical JSON
  logger: { info(msg: string, data?: Json): void; warn(msg: string, data?: Json): void; error(msg: string, data?: Json): void };
  tracer: { span<T>(name: string, attrs: Json, fn: () => T): T };
  storage?: unknown;                                       // server only: scoped storage port of the owning module
  model?: unknown;                                         // server only: ScopedModelPort (agent/model-pool.md §12.1)
}

interface UiExtension {
  readonly extensionId: string;
  readonly slot: string;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly order: number;
  readonly viewRef: string;
}
```

其余受控类型的首版定义：`StrictConfigSchema` 是一个调用过 `.strict()` 的 Zod object schema（未知键报错），控制台用 `z.toJSONSchema()` 由它生成表单；`MigrationPath` 为 `{ fromVersion, toVersion, migrate(state: Json): Json }`；`ContributionRef` 为 `{ extensionId, slot, order, allowedRoles? }`（UI 贡献与控制台页面都用它）；`ExperimentAxis` 为 `{ key, label, values? }`，只用于控制台展示可比较参数。浏览器 realm 握手时只能拿到 `ResolvedModuleSet`，内容包括模块 ID 和版本、能力、协议版本与装配 hash。它不包含工厂、服务端对象、数据库句柄或密钥。assembly 解析、能力闭包与冲突规则见 [积木组合](composition.md) 和 [模块目录](module-catalog.md)。

## 4. 跨端会话与协议

```ts
interface SessionDescriptor {
  readonly principalId: string;
  readonly roles: readonly ("player" | "operator" | "researcher" | "evaluator")[];
  readonly worldId: string;
  readonly branchId: string;
  readonly protocolVersion: string;
  readonly serverAssembly: ResolvedModuleSet;
  readonly clientAssembly: ResolvedModuleSet | null;
}

interface ProjectionEnvelope {
  readonly worldId: string;
  readonly branchId: string;
  readonly streamSeq: number;
  readonly projectionVersion: number;
  readonly snapshotRef: string | null;
  readonly eventRefs: readonly string[];
}

interface ConsoleRequestContext {
  readonly principalId: string;
  readonly roles: readonly string[];
  readonly scope: Json;          // 资源 scope，服务端校验，不信任页面自报
  readonly expectedEpoch?: number;
  readonly expectedVersion?: number;
}
```

WebSocket 只推送授权投影和已提交的对话与任务状态；重连时携带最后确认的游标，缺口过大就重取快照。控制台请求必须携带会话，角色与 scope 每次重新校验，不能依赖同源、隐藏菜单或本机地址。玩家侧或控制台侧的协议版本不一致时显式拒绝，不尝试兼容未声明的字段。

## 5. 模型和工具的关联

runId、turnId、attemptId、llmCallId、toolCallId、operationId 与 commandId 要分开。一个逻辑 operation 可以对应多次网络重试，但只能产生一次有效副作用。模型反复建议同一动作时，不能靠新的 toolCallId 绕过 operation 去重。

ToolDefinition/ToolBinding 的 schema 见 [工具](../agent/tools.md)，modelId/mounts/purpose 的 schema 见 [模型池](../agent/model-pool.md)，ContextArtifact 与 memory revision 由 [上下文](../agent/context.md) 和 [记忆](../agent/memory.md) 维护。模块描述符与装配 schema 以本文第 3 节为准，[插件机制](plugins.md) 只解释注册、生命周期与拔插机制，不另建第二套 schema。

## 6. 错误与取消

统一错误至少包含 code、retryable、safeMessage、traceId、detailsArtifactRef，敏感 details 不返回给玩家。code 分五组：请求类 unauthenticated、forbidden、validation、not-found；状态与预算类 paused、not-ready、invalid-state、budget-exhausted、cancelled；版本与并发类 idempotency-conflict、version-conflict、stale-controller、stale-turn；装配与供应商类 module-missing、capability-conflict、assembly-incompatible、realm-violation、plugin-failed、provider-failed。HTTP 状态码映射见 [API](api.md) 第 7 节；业务规则拒绝使用 receipt 的 reasonCode（[领域模型](domain-model.md) 第 9 节），不使用这里的错误码。

取消只是一个请求，真正保证晚到输出无效的是 fencing。provider 连接超时不能证明 tool 或 command 没有执行，必须查询 receipt。响应不完整时要保持明确状态，不能解析失败后返回一个空成功。模块卸载或替换期间返回 not-ready，不能返回旧实现伪造的结果。

## 7. 契约演进

公共 API 在 v1 中不改变既有字段的含义；新增可选字段需要有默认语义，破坏性变更使用新的 schemaVersion 和迁移。事件旧版本保留 reader/upcaster 与原始 payload，不原地重写日志。模块 apiVersion 与内容 schemaVersion 分别校验，不能混成一个版本号。assembly 增加新 realm 或新能力类别属于契约升级，必须记录兼容窗口与迁移说明。

共享契约测试覆盖合法与非法 payload、scope、幂等、旧版本读取、重连投影、realm 兼容、能力闭包与装配冲突。仓库里还没有 contracts 包，本文描述的 API 尚未经过运行时验证。
