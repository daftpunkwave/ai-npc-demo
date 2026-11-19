/**
 * 定义服务端模块可用的受控端口类型：scoped storage、事务内 WorldTx、处理器结果、已批准对白读取与 scoped 模型句柄。
 * 依赖公共契约的 JSON、受众、认证上下文、原因码与模块创建输入；只声明类型边界，不创建存储、事务或网络资源。
 * 禁止提供 SQL 执行、跨模块万能上下文、全局 service locator 或绕过 ownsAggregates/预算的写入口。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 类型签名中的参数名只用于表达调用契约。 */
import {
  DomainError,
  type AudienceSpec,
  type AuthContext,
  type Json,
  type ModuleCreateInput,
  type ModuleDefinition,
  type Purpose,
  type ReasonCode,
} from "@ai-npc/contracts";

/** 一份模块状态的作用域：世界、分支、主体（可空）、模块与状态版本共同确定命名空间。 */
export interface ScopedStateKey {
  readonly worldId: string;
  readonly branchId: string;
  /** 按主体隔离的状态填 agentId；模块级状态（如 run 作用域缓存）为 null。 */
  readonly agentId: string | null;
  readonly moduleId: string;
  readonly stateSchemaVersion: number;
}

/** 一条 scoped 状态记录；value 必须是 JSON，具体 schema 由拥有该状态的模块校验。 */
export interface ScopedStorageRecord {
  readonly recordId: string;
  readonly value: Json;
}

/**
 * 拥有该状态的模块专属存储端口：绑定一个 ScopedStateKey，只能读写自己命名空间内的记录。
 * 实现方负责持久化、事务与迁移；端口不暴露连接、SQL 或跨模块命名空间。
 */
export interface ScopedStoragePort {
  readonly scope: ScopedStateKey;
  read(recordId: string): Json | null;
  write(recordId: string, value: Json): void;
  remove(recordId: string): void;
  list(prefix?: string): readonly ScopedStorageRecord[];
}

/** 事务内单个聚合的读取结果；version 是聚合版本，state 由拥有该聚合类型的模块解释。 */
export interface AggregateRecord<TState> {
  readonly version: number;
  readonly state: TState;
}

/** 事务内按聚合类型枚举的条目，带聚合 ID 与版本。 */
export interface AggregateEntry<TState> {
  readonly id: string;
  readonly version: number;
  readonly state: TState;
}

/**
 * authority 在一个事务内提供给规则处理器的受控读写端口。
 * 处理器只能读写自己声明 ownsAggregates 的聚合类型，事件与 job 也经此登记后由 authority 统一提交；
 * 不提供直接 SQL、手动提交/回滚或跨模块实现的万能执行通道。
 */
export interface WorldTx {
  readonly worldTick: number;
  get<TState>(aggregateType: string, aggregateId: string): AggregateRecord<TState> | null;
  list<TState>(aggregateType: string): readonly AggregateEntry<TState>[];
  put(aggregateType: string, aggregateId: string, state: Json): void;
  remove(aggregateType: string, aggregateId: string): void;
  emit(type: string, payload: Json, audience: readonly AudienceSpec[], causationIds?: readonly string[]): string;
  schedule(kind: string, dueTick: number, idempotencyKey: string, payload: Json): void;
  cancelJobs(idempotencyKeyPrefix: string): void;
}

/** 只读事务视图：事件订阅与查询处理器不能登记聚合写入、事件或 job。 */
export type WorldTxReader = Pick<WorldTx, "worldTick" | "get" | "list">;

/** 按模块 ID 取得同一事务内受该模块写作用域限制的 WorldTx。 */
export type ScopedWorldTxFactory = (moduleId: string) => WorldTx;

/**
 * 宿主在每次处理器调用时绑定模块端口：传入的 txFor 与当前事务共享提交与回滚。
 * 端口实现应在方法内部按自身模块 ID 取 tx，不能跨模块直接写聚合。
 */
export type ModuleBinder = (txFor: ScopedWorldTxFactory) => unknown;

/** 规则处理器的结果：接受（可携带结果）或按原因码拒绝，不能伪造 receipt 或异步任务状态。 */
export type HandlerResult =
  | { readonly kind: "accepted"; readonly result?: Json }
  | { readonly kind: "rejected"; readonly reasonCode: ReasonCode; readonly safeMessage: string };

/** 模块间 ops 的同步结果：失败只返回原因码，由调用方转成拒绝，不抛通用异常代替业务拒绝。 */
export type OpResult = { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };

/** 已批准并已提交的对白：speech 与 decision 隔离，处理器只能读取不能改写。 */
export interface ApprovedSpeech {
  readonly text: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly branchId: string;
  readonly audience: readonly string[];
  readonly channel: "dialogue" | "message" | "broadcast";
  readonly approved: boolean;
}

/** 事务内的已批准对白只读索引；artifact 在事务外装载校验，事务内不做文件 I/O。 */
export interface ApprovedSpeechReader {
  read(ref: string): ApprovedSpeech | null;
}

/**
 * 一次事务内规则处理器可见的宿主能力。
 * tx 的写权限由 authority 按 ownsAggregates 收紧；其他游戏模块的 typed ports 与内容索引
 * 由具体装配以类型参数给出，避免在这里退化成万能 execute 或 Json 查询通道。
 */
export interface HandlerContext<TModulePorts, TContentIndex> {
  readonly auth: AuthContext;
  readonly tx: WorldTx;
  readonly modules: TModulePorts;
  readonly approvedSpeech: ApprovedSpeechReader;
  readonly content: TContentIndex;
  /**
   * 确定性随机源：宿主已绑定本次 run 的 seed，规则只传语义字段（tick、agentId、teamId、roadId 等）。
   * 不得把 taskId、turnId 等随机生成的 ID 作为输入。
   */
  readonly rng: (...seedParts: string[]) => () => number;
  readonly ids: (prefix: string) => string;
}

/** scoped 模型调用的作用域：由模型池按 run 与主体绑定，模块不能跨主体复用。 */
export interface ScopedModelScope {
  readonly runId: string;
  readonly agentId: string | null;
  readonly purpose: Purpose;
}

/**
 * scoped 模型端口骨架：宿主按 run 与主体把调用预算、路由和取消绑定到该句柄。
 * 请求、响应与 attempt 记录契约由模型池提供者收窄，这里只保留不透明句柄与作用域，
 * 模块不能借此读取凭据、跨主体调用或绕过预算与 fencing。
 */
export interface ScopedModelPort {
  readonly scope: ScopedModelScope;
}

/**
 * 由模块定义与创建输入构造状态作用域：无状态模块、realm 不一致或缺少世界/分支标识时直接报错。
 * 模块作者据此得到与 ownsAggregates/stateSchemaVersion 一致的存储命名空间，不手工拼 scope。
 */
export function createScopedStateKey(
  definition: ModuleDefinition,
  input: ModuleCreateInput,
): ScopedStateKey {
  if (definition.stateSchemaVersion === null) {
    throw new DomainError("assembly-incompatible", `模块 ${definition.id} 是无状态模块，不能创建状态作用域`, {
      details: { moduleId: definition.id },
    });
  }
  if (definition.id !== input.moduleId) {
    throw new DomainError("assembly-incompatible", "模块定义与创建输入的模块 ID 不一致", {
      details: { definitionId: definition.id, inputModuleId: input.moduleId },
    });
  }
  if (definition.realm !== input.realm) {
    throw new DomainError("realm-violation", "模块定义与创建输入的 realm 不一致", {
      details: { moduleId: definition.id, definitionRealm: definition.realm, inputRealm: input.realm },
    });
  }
  const { worldId, branchId, agentId } = input.scope;
  if (worldId === undefined || branchId === undefined) {
    throw new DomainError("assembly-incompatible", `模块 ${definition.id} 的状态作用域缺少 worldId 或 branchId`, {
      details: { moduleId: definition.id },
    });
  }
  return Object.freeze({
    worldId,
    branchId,
    agentId: agentId ?? null,
    moduleId: definition.id,
    stateSchemaVersion: definition.stateSchemaVersion,
  });
}
