# 公共契约与协议语义

> 以下是待实现的 TypeScript 公共类型示意，具体 schema 由 `packages/contracts` 维护。本篇拥有跨模块共有语义；Module/Plugin 机制由 [插件机制](plugins.md) 维护，Tool、Model、Memory 的专有字段由对应专篇维护，禁止复制多份契约。

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
  readonly audiencePolicyId: string;
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

`AgentObservation.epistemic` 与 `MemoryRecord.epistemic` 是不同枚举：前者表示获知方式（亲历/转述/推断），后者表示记忆的证据地位（已验证事件/声称/推断）。两者不得互换或合并成一个字符串；传播权限另由 `releasePolicyId` 表达。scope 与事件 envelope 由服务端赋值或验证；worldSeq 在 branch 内排序。来源 ID 必须存在并属于合法知识边界。版本化身份/lore 使用独立 contentRef，不能伪造观察来源。

InputFrontier 是每个 Agent 的冻结边界，由 scope 绑定；多主体快照存各身份的 frontier map。同一 worldSeq 下延迟观察也可能稍后送达，必须同时冻结 observationSeq、perceptionRevision 和 knowledgeGrantRevision，不能只比较世界序号。memoryRevision 指向满足边界的不可变视图；conversationCursor 限定该主体有权使用的会话日志。

时间满足 occurredAtTick ≤ sensedAtTick ≤ knownAtTick；confidence 校验为有限 0–1；channel 从已注册渠道解析。运行中经历的观察来源非空；contentRefs 仅用于版本化背景，不能替代经历证据。Json 只是传输形态，实际 payload 按 type + schemaVersion 查 schema registry；未知命令、未知字段、错误版本都拒绝。

## 2. 命令与 receipt

CommandEnvelope 包含 commandId、type、schemaVersion、expectedVersions 与 payload；principal、world/branch、controllerEpoch 和 turnLeaseEpoch 由认证上下文/宿主附加。不能由模型自报 author 获得权限。

CommandReceipt 包含 receiptId、commandId、commandStatus、reasonCode、acceptedEventIds、operationId 与 resultingVersions。commandStatus 只为 accepted 或 rejected，是不可变提交回执；accepted 不等于异步任务已完成。相同幂等键与 payloadHash 返回原 receipt，不重复执行；键相同但内容不同拒绝。

异步任务投影使用独立 taskStatus：pending、running、completed、failed、cancelled。ToolResult 使用 executionStatus：ok、error、unknown；ok 表示网关拿到确定合法响应，仍可能包含 commandStatus=rejected；unknown 表示副作用结果未确认，必须查询 receipt。工具视图不得把这些不同层状态混成一个 status 或省略失败。无任务的只读结果不伪造 taskStatus。

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
  readonly configHash: string;
}

interface ResolvedModuleSet {
  readonly realm: Realm;
  readonly protocolVersion: string;
  readonly modules: readonly ModuleRef[];
  readonly capabilities: readonly CapabilityRef[];
  readonly assemblyHash: string;
}

interface AssemblyDescriptor {
  readonly schemaVersion: number;
  readonly id: string;
  readonly realms: Readonly<Record<Realm, {
    readonly modules: readonly string[];
    readonly bindings: readonly CapabilityBinding[];
  }>>;
}

interface CapabilityBinding {
  readonly capability: CapabilityId;
  readonly moduleId: string;
  readonly configRef: string;
  readonly fallbackModuleIds?: readonly string[];
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

interface UiExtension {
  readonly extensionId: string;
  readonly slot: string;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly order: number;
  readonly viewRef: string;
}
```

`StrictConfigSchema`、`MigrationPath`、`ContributionRef`、`ExperimentAxis`、`ModuleCreateInput` 是 contracts 包内的受控类型，暂不在本篇展开。`ResolvedModuleSet` 是浏览器 realm 握手时唯一可以拿到的东西：模块 ID/版本、能力、协议版本与装配 hash。它不包含工厂、服务端对象、数据库句柄或密钥。assembly 解析、能力闭包与冲突规则见 [积木组合](composition.md) 与 [模块目录](module-catalog.md)。

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

WebSocket 只推送授权投影与已提交对话/任务状态；重连携带最后确认游标，缺口过大重取快照。控制台请求必须携带会话并重新校验角色与 scope，不能依赖同源、隐藏菜单或本机地址。玩家/控制台协议版本不一致时显式拒绝，不尝试兼容未声明字段。

## 5. 模型和工具的关联

runId、turnId、attemptId、llmCallId、toolCallId、operationId、commandId 分开。一个逻辑 operation 可对应多次网络重试，但只能产生一次有效副作用。模型多次建议同一动作不能借新 toolCallId 规避 operation 去重。

ToolDefinition/ToolBinding 的 schema 见 [工具](../agent/tools.md)；modelId/mounts/purpose 的 schema 见 [模型池](../agent/model-pool.md)；ContextArtifact 和 memory revision 由 [上下文](../agent/context.md) 与 [记忆](../agent/memory.md) 维护；模块描述符与装配 schema 以本文 §3 为唯一实现，[插件机制](plugins.md) 只解释注册、生命周期与拔插机制，不另建第二套 schema。

## 6. 错误与取消

统一错误至少包含 code、retryable、safeMessage、traceId、detailsArtifactRef；敏感 details 不返回玩家。code 区分 forbidden、validation、paused、idempotency-conflict、version-conflict、stale-controller、stale-turn、not-ready、budget-exhausted、module-missing、capability-conflict、assembly-incompatible、realm-violation、plugin-failed、provider-failed、cancelled。

取消是请求，fencing 才保证晚到输出无效。provider 连接超时不证明 tool/command 未执行，必须查询 receipt。响应不完整保持明确状态，不能解析失败后返回空成功。模块卸载/替换期间返回 not-ready，不返回旧实现的伪造结果。

## 7. 契约演进

公共 API 不在 v1 中改变既有字段含义；新增可选字段需默认语义，破坏性变更使用新 schemaVersion 和迁移。事件旧版本保留 reader/upcaster 与原始 payload，不原地重写日志。模块 apiVersion 与内容 schemaVersion 分别校验，不能混成一个版本号。assembly 增加新 realm 或新能力类别属于契约升级，必须记录兼容窗口与迁移说明。

共享契约测试覆盖合法/非法 payload、scope、幂等、旧版本读取、重连投影、realm 兼容、能力闭包与装配冲突。仓库尚未创建 contracts 包，本篇不是已验证的运行时 API。
