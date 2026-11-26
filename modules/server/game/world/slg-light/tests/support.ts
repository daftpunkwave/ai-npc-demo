/**
 * 为世界模块测试提供确定性的内存事务与宿主夹具。
 * 仅依赖公共模块契约与 module-sdk 的事务类型。
 * 禁止在测试用例之间共享可变状态，也禁止访问真实存储或进程时间。
 */
import type {
  AudienceSpec,
  HostServices,
  Json,
  ModuleCreateInput,
} from "@world-prism/contracts";
import type { AggregateEntry, AggregateRecord, WorldTx } from "@world-prism/module-sdk";
import { worldModuleDefinition } from "../src/definition";

interface StoredCell {
  readonly state: Json;
  readonly version: number;
}

/** 隔离世界模块测试使用的最小确定性 WorldTx。 */
export class TestWorldTx implements WorldTx {
  readonly worldTick: number;
  private readonly cells = new Map<string, Map<string, StoredCell>>();
  private eventSequence = 0;
  private readonly recordedEvents: { readonly type: string; readonly payload: Json }[] = [];

  constructor(worldTick = 0) {
    this.worldTick = worldTick;
  }

  get<TState>(aggregateType: string, aggregateId: string): AggregateRecord<TState> | null {
    const cell = this.cells.get(aggregateType)?.get(aggregateId);
    return cell === undefined ? null : { version: cell.version, state: cell.state as TState };
  }

  list<TState>(aggregateType: string): readonly AggregateEntry<TState>[] {
    return [...(this.cells.get(aggregateType) ?? new Map<string, StoredCell>()).entries()].map(
      ([id, cell]) => ({ id, version: cell.version, state: cell.state as TState }),
    );
  }

  put(aggregateType: string, aggregateId: string, state: Json): void {
    const bucket = this.cells.get(aggregateType) ?? new Map<string, StoredCell>();
    const version = (bucket.get(aggregateId)?.version ?? 0) + 1;
    bucket.set(aggregateId, { state, version });
    this.cells.set(aggregateType, bucket);
  }

  remove(aggregateType: string, aggregateId: string): void {
    this.cells.get(aggregateType)?.delete(aggregateId);
  }

  emit(
    type: string,
    payload: Json,
    _audience: readonly AudienceSpec[],
    _causationIds?: readonly string[],
  ): string {
    this.eventSequence += 1;
    this.recordedEvents.push({ type, payload });
    return `evt-${String(this.eventSequence).padStart(12, "0")}`;
  }

  /** 已发出的事件；供测试断言事务内写入了哪些事实。 */
  events(): readonly { readonly type: string; readonly payload: Json }[] {
    return this.recordedEvents;
  }

  schedule(_kind: string, _dueTick: number, _idempotencyKey: string, _payload: Json): void {
    // 世界模块测试不执行已调度 job。
  }

  cancelJobs(_idempotencyKeyPrefix: string): void {
    // 世界模块测试不执行已调度 job。
  }

  private readonly clockStops: { readonly requestId: string; readonly tick: number }[] = [];

  requestClockStop(requestId: string, _reason: string): void {
    this.clockStops.push({ requestId, tick: this.worldTick });
  }

  /** 已登记的持久时钟停止点，供测试断言章节终点与业务结果同事务提交。 */
  stopRequests(): readonly { readonly requestId: string; readonly tick: number }[] {
    return this.clockStops;
  }
}

/** 供模块创建与规则贡献测试使用的确定性 HostServices。 */
export function createTestHost(): HostServices {
  let idSequence = 0;
  return {
    ids: (prefix) => {
      idSequence += 1;
      return `${prefix}-${String(idSequence).padStart(12, "0")}`;
    },
    nowIso: () => "2026-01-01T00:00:00.000Z",
    monotonicMs: () => 0,
    sleep: async () => {
      // 世界模块没有异步等待。
    },
    rng: () => () => 0.5,
    hash: async (value) => String(JSON.stringify(value).length).padStart(64, "0"),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    tracer: {
      span: (_name, _attrs, fn) => fn(),
    },
  };
}

/** 使用世界模块定义身份与确定性宿主构造模块输入。 */
export function createWorldModuleInput(config: Json): ModuleCreateInput {
  return {
    moduleId: worldModuleDefinition.id,
    realm: "server",
    config,
    scope: { worldId: "wld-000000000000", branchId: "br-000000000000" },
    ports: {},
    host: createTestHost(),
    signal: new AbortController().signal,
  };
}
