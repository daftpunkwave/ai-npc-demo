/**
 * 逐消费者推进 worldSeq offset，并在同一事务内调用处理器、写 inbox 与更新 offset。
 * 依赖 domain_events、consumer_offsets/inbox 表、事件信封契约与系统认证。
 * 禁止在事件处理后单独提交 offset、跳过 inbox 去重或在 handler 失败后继续推进。
 */
import {
  DomainError,
  eventEnvelopeSchema,
  jsonValueSchema,
  type EventEnvelope,
  type Json,
  type StorageRawRow,
  type StorageTransaction,
} from "@ai-npc/contracts";
import { readBranch, readClock } from "./branch-state";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
import type { RuleRegistry } from "./rule-registry";
import { requireStorageNumber } from "./storage-values";
import { createSystemAuth, systemPrincipalId } from "./system-auth";
import type { RuleRuntime, StoredEventConsumer } from "./types";
import { assertSynchronous, TransactionWorldTx } from "./world-tx";

function rawCell(row: StorageRawRow, column: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- column 由本文件的固定事件字段列表提供。
  return row[column];
}

function rawString(row: StorageRawRow, column: string): string {
  const value = rawCell(row, column);
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("invalid-state", `domain_events 列 ${column} 不是非空字符串`, {
      details: { column },
    });
  }
  return value;
}

function rawNumber(row: StorageRawRow, column: string): number {
  const value = rawCell(row, column);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid-state", `domain_events 列 ${column} 不是非负安全整数`, {
      details: { column },
    });
  }
  return value;
}

function rawJson(row: StorageRawRow, column: string): Json {
  const value = rawCell(row, column);
  if (typeof value !== "string") {
    throw new DomainError("invalid-state", `domain_events 列 ${column} 不是 JSON 文本`, {
      details: { column },
    });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new DomainError("invalid-state", `domain_events 列 ${column} 无法解析`, {
      cause: error,
      details: { column },
    });
  }
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `domain_events 列 ${column} 不是合法 JSON`, {
      details: { column },
    });
  }
  return parsed.data;
}

/** 消费者单次运行结果：scanned 含被过滤或去重跳过的事件。 */
export interface ConsumerRunResult {
  readonly processed: number;
  readonly scanned: number;
}

/** 消费者运行选项；maxEvents 防止一次运行被新事件无限拉长。 */
export interface ConsumerRunOptions {
  readonly maxEvents?: number;
}

/** 消费者执行器依赖。 */
export interface EventConsumerRunnerOptions extends RuleRuntime {
  readonly registry: RuleRegistry;
}

const defaultMaxEvents = 1000;

/** 事件消费者执行器；每个事件一个事务，offset 与 inbox 随处理结果提交。 */
export class EventConsumerRunner {
  private readonly storage: RuleRuntime["storage"];
  private readonly host: RuleRuntime["host"];
  private readonly registry: RuleRegistry;
  private readonly modules: unknown;
  private readonly content: unknown;
  private readonly approvedSpeech: RuleRuntime["approvedSpeech"];
  private readonly moduleBinder: RuleRuntime["moduleBinder"];
  private readonly runSeed: RuleRuntime["runSeed"];

  constructor(options: EventConsumerRunnerOptions) {
    this.storage = options.storage;
    this.host = options.host;
    this.registry = options.registry;
    this.modules = options.modules;
    this.content = options.content;
    this.approvedSpeech = options.approvedSpeech;
    this.moduleBinder = options.moduleBinder;
    this.runSeed = options.runSeed;
  }

  /** 按注册顺序推进每个消费者；某个消费者抛错时停止整次运行并向调用方传播。 */
  run(branchId: string, options: ConsumerRunOptions = {}): ConsumerRunResult {
    const maxEvents = options.maxEvents ?? defaultMaxEvents;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) {
      throw new DomainError("validation", "消费者 maxEvents 必须是非负安全整数", {
        details: { maxEvents },
      });
    }
    let processed = 0;
    let scanned = 0;
    for (const consumer of this.registry.consumerList()) {
      while (scanned < maxEvents) {
        const outcome = this.storage.transact((tx) => this.processNext(tx, branchId, consumer));
        if (outcome === null) {
          break;
        }
        scanned += 1;
        processed += outcome;
      }
      if (scanned >= maxEvents) {
        break;
      }
    }
    return { processed, scanned };
  }

  private processNext(
    tx: StorageTransaction,
    branchId: string,
    consumer: StoredEventConsumer,
  ): number | null {
    const branch = readBranch(tx, branchId);
    if (branch === null) {
      throw new DomainError("not-found", `分支 ${branchId} 不存在`, { details: { branchId } });
    }
    if (branch.status !== "active" && branch.status !== "paused") {
      throw new DomainError("forbidden", `分支 ${branchId} 当前状态不接受事件消费`, {
        details: { branchId, status: branch.status },
      });
    }
    const clock = readClock(tx, branchId);
    const branchStorage = tx.branch(branchId);
    const offsets = branchStorage.table("consumer_offsets");
    const offsetRow = offsets.get({ consumer_id: consumer.consumerId });
    const lastWorldSeq =
      offsetRow === null ? 0 : requireStorageNumber(offsetRow, "consumer_offsets", "last_world_seq");
    const events = tx.all(
      "SELECT * FROM domain_events WHERE branch_id = ? AND world_seq > ? ORDER BY world_seq ASC LIMIT 1",
      [branchId, lastWorldSeq],
    );
    const row = events[0];
    if (row === undefined) {
      return null;
    }
    const event = this.parseEvent(row, branch.worldId, branchId);
    const inbox = branchStorage.table("consumer_inbox");
    const alreadyProcessed = inbox.get({ consumer_id: consumer.consumerId, event_id: event.eventId });
    if (alreadyProcessed !== null) {
      offsets.put({ consumer_id: consumer.consumerId, last_world_seq: event.worldSeq });
      return 0;
    }
    if (consumer.eventTypes !== null && !consumer.eventTypes.has(event.type)) {
      offsets.put({ consumer_id: consumer.consumerId, last_world_seq: event.worldSeq });
      return 0;
    }
    const worldTx = new TransactionWorldTx({
      storageTx: tx,
      worldId: branch.worldId,
      branchId,
      worldTick: clock.worldTick,
      principalId: systemPrincipalId,
      correlationId: `event:${event.eventId}`,
      scope: consumer.owner,
      host: this.host,
    });
    const context = createHandlerContext({
      auth: createSystemAuth(branch.worldId, branchId),
      tx: worldTx,
      modules: bindModulePorts({
        binder: this.moduleBinder,
        fallback: this.modules,
        registry: this.registry,
        storageTx: tx,
        worldId: branch.worldId,
        branchId,
        worldTick: clock.worldTick,
        principalId: systemPrincipalId,
        correlationId: `event:${event.eventId}`,
        host: this.host,
      }),
      content: this.content,
      approvedSpeech: this.approvedSpeech,
      host: this.host,
      runSeed: this.runSeed,
    });
    const outcome = consumer.handler(context, event);
    assertSynchronous(outcome, `事件消费者 ${consumer.consumerId}`);
    inbox.put({
      consumer_id: consumer.consumerId,
      event_id: event.eventId,
      processed_at: this.host.nowIso(),
    });
    offsets.put({ consumer_id: consumer.consumerId, last_world_seq: event.worldSeq });
    return 1;
  }

  private parseEvent(row: StorageRawRow, worldId: string, branchId: string): EventEnvelope {
    const parsed = eventEnvelopeSchema.safeParse({
      eventId: rawString(row, "event_id"),
      schemaVersion: rawNumber(row, "schema_version"),
      worldId,
      branchId,
      worldSeq: rawNumber(row, "world_seq"),
      worldTick: rawNumber(row, "world_tick"),
      type: rawString(row, "type"),
      principalId: rawString(row, "principal_id"),
      causationIds: rawJson(row, "causation_ids_json"),
      correlationId: rawString(row, "correlation_id"),
      audience: rawJson(row, "audience_json"),
      payload: rawJson(row, "payload_json"),
    });
    if (!parsed.success) {
      throw new DomainError("invalid-state", "存储中的领域事件不符合信封契约", {
        details: {
          eventId: String(row["event_id"] ?? ""),
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
          })),
        },
      });
    }
    return parsed.data;
  }
}
