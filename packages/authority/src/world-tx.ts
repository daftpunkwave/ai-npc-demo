/**
 * 实现事务内 WorldTx：按模块所有权读写聚合、分配事件 worldSeq 与 job seq。
 * 依赖存储事务、事件/JSON 契约、宿主 ID 与注册作用域；所有写入立即进入当前事务，回滚由 authority 统一触发。
 * 禁止读写他人聚合、手工提交事务、跳过事件信封校验或让 job 的唯一键重复。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import {
  DomainError,
  domainEventSchemaVersion,
  eventEnvelopeSchema,
  jsonValueSchema,
  type AudienceSpec,
  type EventPayloadSchema,
  type Json,
  type StorageTable,
  type StorageTransaction,
} from "@ai-npc/contracts";
import type { HostServices } from "@ai-npc/contracts";
import type { AggregateEntry, AggregateRecord, WorldTx } from "@ai-npc/module-sdk";
import { type ContributorScope } from "./types";
import { isThenable, readJsonCell, requireStorageNumber, requireStorageString } from "./storage-values";

/** 事务内事件与版本收集器；绑定端口与主处理器共享同一实例。 */
export interface TxCollector {
  readonly eventIds: string[];
  readonly versions: Record<string, number>;
}

/** 构造 WorldTx 所需的固定事务上下文；principalId 与 correlationId 由发起来源决定。 */
export interface WorldTxOptions {
  readonly storageTx: StorageTransaction;
  readonly worldId: string;
  readonly branchId: string;
  readonly worldTick: number;
  readonly principalId: string;
  readonly correlationId: string;
  readonly scope: ContributorScope;
  readonly host: HostServices;
  /** 可写入事务的事件类型与 payload schema；未登记的事件类型一律拒绝。 */
  readonly eventSchemas: ReadonlyMap<string, EventPayloadSchema>;
  readonly collector?: TxCollector;
}

function aggregateKey(aggregateType: string, aggregateId: string): string {
  return `${aggregateType}:${aggregateId}`;
}

function invalidJson(label: string): never {
  throw new DomainError("validation", `${label} 必须是合法 JSON 值`, { details: { label } });
}

function requireJson(value: unknown, label: string): Json {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) {
    invalidJson(label);
  }
  return parsed.data;
}

function nextSequence(table: StorageTable, column: string): number {
  const value = table.max(column);
  if (value === null) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid-state", `表 ${table.table} 的序号列 ${column} 不是非负安全整数`, {
      details: { table: table.table, column },
    });
  }
  return value + 1;
}

/** 一个模块在一次事务内的受控写入口；写入的可见性与回滚由外层存储事务决定。 */
export class TransactionWorldTx implements WorldTx {
  readonly worldTick: number;
  private readonly storageTx: StorageTransaction;
  private readonly aggregateTable: StorageTable;
  private readonly jobsTable: StorageTable;
  private readonly eventsTable: StorageTable;
  private readonly worldId: string;
  private readonly branchId: string;
  private readonly principalId: string;
  private readonly correlationId: string;
  private readonly scope: ContributorScope;
  private readonly host: HostServices;
  private readonly eventSchemas: ReadonlyMap<string, EventPayloadSchema>;
  private readonly collector: TxCollector;

  constructor(options: WorldTxOptions) {
    if (options.correlationId.trim().length === 0) {
      throw new DomainError("validation", "事务关联 ID 不能为空");
    }
    if (!Number.isSafeInteger(options.worldTick) || options.worldTick < 0) {
      throw new DomainError("validation", "事务世界 tick 必须是非负安全整数");
    }
    this.storageTx = options.storageTx;
    this.worldTick = options.worldTick;
    this.worldId = options.worldId;
    this.branchId = options.branchId;
    this.principalId = options.principalId;
    this.correlationId = options.correlationId;
    this.scope = options.scope;
    this.host = options.host;
    this.eventSchemas = options.eventSchemas;
    this.collector = options.collector ?? { eventIds: [], versions: {} };
    const branch = options.storageTx.branch(options.branchId);
    this.aggregateTable = branch.table("aggregate_state");
    this.jobsTable = branch.table("jobs");
    this.eventsTable = branch.table("domain_events");
  }

  private assertOwned(aggregateType: string): void {
    if (!this.scope.ownsAggregates.has(aggregateType)) {
      throw new DomainError("forbidden", `模块 ${this.scope.moduleId} 不能写入聚合类型 ${aggregateType}`, {
        details: { moduleId: this.scope.moduleId, aggregateType },
      });
    }
  }

  get<TState>(aggregateType: string, aggregateId: string): AggregateRecord<TState> | null {
    this.assertOwned(aggregateType);
    const row = this.aggregateTable.get({ aggregate_type: aggregateType, aggregate_id: aggregateId });
    if (row === null) {
      return null;
    }
    return {
      version: requireStorageNumber(row, "aggregate_state", "version"),
      state: readJsonCell(row["state_json"], "aggregate_state", "state_json") as TState,
    };
  }

  list<TState>(aggregateType: string): readonly AggregateEntry<TState>[] {
    this.assertOwned(aggregateType);
    const rows = this.aggregateTable.list(
      { aggregate_type: aggregateType },
      { orderBy: [{ column: "aggregate_id" }] },
    );
    return rows.map((row) => ({
      id: requireStorageString(row, "aggregate_state", "aggregate_id"),
      version: requireStorageNumber(row, "aggregate_state", "version"),
      state: readJsonCell(row["state_json"], "aggregate_state", "state_json") as TState,
    }));
  }

  put(aggregateType: string, aggregateId: string, state: Json): void {
    this.assertOwned(aggregateType);
    if (aggregateId.length === 0) {
      throw new DomainError("validation", "聚合 ID 不能为空", { details: { aggregateType } });
    }
    const json = requireJson(state, "聚合状态");
    const existing = this.aggregateTable.get({ aggregate_type: aggregateType, aggregate_id: aggregateId });
    const version =
      existing === null ? 1 : requireStorageNumber(existing, "aggregate_state", "version") + 1;
    this.aggregateTable.put({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      version,
      state_json: json,
    });
    this.collector.versions[aggregateKey(aggregateType, aggregateId)] = version;
  }

  remove(aggregateType: string, aggregateId: string): void {
    this.assertOwned(aggregateType);
    this.aggregateTable.delete({ aggregate_type: aggregateType, aggregate_id: aggregateId });
    this.collector.versions[aggregateKey(aggregateType, aggregateId)] = 0;
  }

  emit(
    type: string,
    payload: Json,
    audience: readonly AudienceSpec[],
    causationIds: readonly string[] = [],
  ): string {
    if (type.trim().length === 0) {
      throw new DomainError("validation", "事件类型不能为空");
    }
    const json = requireJson(payload, "事件 payload");
    // 未登记的事件类型不能落库：公共契约与模块显式登记的扩展事件构成唯一目录。
    const payloadSchema = this.eventSchemas.get(type);
    if (payloadSchema === undefined) {
      throw new DomainError("validation", `事件类型 ${type} 未登记`, { details: { type } });
    }
    const payloadResult = payloadSchema.safeParse(json);
    if (!payloadResult.success) {
      throw new DomainError("validation", `事件 ${type} 的 payload 不合法`, {
        details: {
          type,
          issues: payloadResult.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
          })),
        },
      });
    }
    // 持久化 schema 解析后的结果：默认值、剥离与转换必须与校验结论一致。
    const validatedPayload = requireJson(payloadResult.data, "事件 payload");
    const worldSeq = nextSequence(this.eventsTable, "world_seq");
    const eventId = this.host.ids("evt");
    const envelope = eventEnvelopeSchema.safeParse({
      eventId,
      schemaVersion: domainEventSchemaVersion,
      worldId: this.worldId,
      branchId: this.branchId,
      worldSeq,
      worldTick: this.worldTick,
      type,
      principalId: this.principalId,
      causationIds: [...causationIds],
      correlationId: this.correlationId,
      audience: [...audience],
      payload: validatedPayload,
    });
    if (!envelope.success) {
      throw new DomainError("validation", `事件 ${type} 的信封不合法`, {
        details: {
          type,
          issues: envelope.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
          })),
        },
      });
    }
    const valid = envelope.data;
    this.eventsTable.put({
      world_seq: valid.worldSeq,
      event_id: valid.eventId,
      world_tick: valid.worldTick,
      type: valid.type,
      schema_version: valid.schemaVersion,
      principal_id: valid.principalId,
      causation_ids_json: valid.causationIds,
      correlation_id: valid.correlationId,
      audience_json: valid.audience,
      payload_json: valid.payload,
      committed_at: this.host.nowIso(),
    });
    this.collector.eventIds.push(valid.eventId);
    return valid.eventId;
  }

  schedule(kind: string, dueTick: number, idempotencyKey: string, payload: Json): void {
    if (kind.trim().length === 0) {
      throw new DomainError("validation", "job 类型不能为空");
    }
    if (!Number.isSafeInteger(dueTick) || dueTick < 0) {
      throw new DomainError("validation", "job 到期 tick 必须是非负安全整数", { details: { dueTick } });
    }
    if (idempotencyKey.trim().length === 0) {
      throw new DomainError("validation", "job 幂等键不能为空", { details: { kind } });
    }
    const json = requireJson(payload, "job payload");
    const existing = this.jobsTable.list({ idempotency_key: idempotencyKey }, { limit: 1 });
    if (existing.length > 0) {
      return;
    }
    const jobId = this.host.ids("job");
    this.jobsTable.put({
      job_id: jobId,
      seq: nextSequence(this.jobsTable, "seq"),
      kind,
      due_tick: dueTick,
      status: "scheduled",
      idempotency_key: idempotencyKey,
      payload_json: json,
      attempts: 0,
    });
  }

  cancelJobs(idempotencyKeyPrefix: string): void {
    if (idempotencyKeyPrefix.trim().length === 0) {
      throw new DomainError("validation", "job 幂等键前缀不能为空");
    }
    const rows = this.jobsTable.list({ status: "scheduled" });
    for (const row of rows) {
      const key = String(row["idempotency_key"] ?? "");
      if (!key.startsWith(idempotencyKeyPrefix)) {
        continue;
      }
      this.jobsTable.put({
        ...row,
        status: "cancelled",
      });
    }
  }

  /** 本次事务写入或删除过的聚合版本，键为 “聚合类型:聚合 ID”。 */
  resultingVersions(): Readonly<Record<string, number>> {
    return { ...this.collector.versions };
  }

  /** 本次事务成功登记的事件 ID，按登记顺序返回。 */
  emittedEventIds(): readonly string[] {
    return [...this.collector.eventIds];
  }
}

/** 断言处理器没有返回 Promise；同步事务内出现异步回调属于编程错误。 */
export function assertSynchronous(value: unknown, label: string): void {
  if (isThenable(value)) {
    throw new DomainError("invalid-state", `${label} 必须是同步函数，不能返回 Promise`, {
      details: { label },
    });
  }
}
