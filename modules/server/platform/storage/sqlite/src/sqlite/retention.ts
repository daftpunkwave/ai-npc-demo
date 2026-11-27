/**
 * 核心职责：按配置的保留天数分批删除可轮转观测表中的过期行，并调度启动时立即运行、之后按固定间隔重复的清理轮次。
 * 交互契约：经存储端口的 transact 逐批执行，截止时间按宿主时钟换算；每一批删除与本轮审计记录在同一短事务内提交，
 *   审计经 module-sdk 写入 lifecycle_events，一张表的一轮清理对应一条 StorageRetentionPruned 记录，行数随每批累加。
 * 约束与禁忌：只处理配置 schema 允许的可轮转表；未配置保留期时不创建定时器；禁止在一个事务里删完全部过期行、
 *   在其他组件的事务内执行，或在调度停止后继续发起下一批。
 */
import { canonicalJson, type HostServices, type Json, type StoragePort } from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import type { RetentionDays } from "../definition";

/** 可轮转表名；集合由配置 schema 的 retentionDays 决定。 */
export type RotatableTable = keyof RetentionDays;

/**
 * 每张可轮转表的单批删除语句：按墙上时钟开始时间从旧到新取一批行删除。
 * 类型要求覆盖 schema 中的每张表，新增可轮转表时必须同时给出年龄列与语句；
 * started_at 为 NULL 的早期跨度不满足范围条件，没有可判定的年龄，按永久保留处理。
 */
export const pruneBatchStatements = {
  trace_spans: `DELETE FROM trace_spans WHERE rowid IN (
      SELECT rowid FROM trace_spans WHERE started_at < ? ORDER BY started_at LIMIT ?)`,
} as const satisfies Record<RotatableTable, string>;

/** 生命周期审计中的清理记录类型。 */
export const retentionAuditType = "StorageRetentionPruned";

/** 单批删除上限：每个写事务只持锁删除这么多行，其他写入最多等待一批的时间。 */
export const retentionBatchRows = 500;

/** 两轮清理之间的间隔；保留期以天计，按小时检查足以让过期行及时离开。 */
export const retentionIntervalMs = 60 * 60 * 1000;

const dayMs = 24 * 60 * 60 * 1000;

/** 一张表在一轮清理中的目标：保留天数与截止时间。 */
export interface RetentionTarget {
  readonly table: RotatableTable;
  readonly retentionDays: number;
  /** 开始时间早于该 ISO 时刻的行视为过期。 */
  readonly cutoff: string;
}

/** 一张表在一轮清理中的结果；deletedRows 只计已提交的批次。 */
export interface RetentionResult extends RetentionTarget {
  readonly deletedRows: number;
}

/** 一轮清理的依赖：只用存储端口的事务入口与宿主时钟、日志。 */
export interface RetentionPassInput {
  readonly storage: Pick<StoragePort, "transact">;
  readonly host: Pick<HostServices, "nowIso" | "logger">;
  readonly retentionDays: RetentionDays | undefined;
  readonly signal: AbortSignal;
  readonly batchRows?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 按配置与当前时刻计算本轮各表的截止时间；未配置的表不出现在结果里。 */
export function retentionTargets(retentionDays: RetentionDays | undefined, nowIso: string): readonly RetentionTarget[] {
  if (retentionDays === undefined) {
    return [];
  }
  const now = Date.parse(nowIso);
  const tables = Object.keys(pruneBatchStatements) as RotatableTable[];
  return tables.flatMap((table) => {
    // eslint-disable-next-line security/detect-object-injection -- table 来自本文件固定的可轮转表清单。
    const days = retentionDays[table];
    return days === undefined ? [] : [{ table, retentionDays: days, cutoff: new Date(now - days * dayMs).toISOString() }];
  });
}

function auditPayload(result: RetentionResult): Json {
  return { retentionDays: result.retentionDays, cutoff: result.cutoff, deletedRows: result.deletedRows };
}

/** 批与批之间让出事件循环，使排队的请求与其他写事务能在两批之间执行。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * 清理一张表：每批删除与审计行在同一事务内提交，第一批插入审计行，后续批次把累计行数写回同一行。
 * 进程在两批之间退出时，审计记录的行数仍与已提交的删除一致，不会出现没有记录的删除。
 */
async function pruneTable(input: RetentionPassInput, target: RetentionTarget, createdAt: string): Promise<RetentionResult> {
  const batchRows = input.batchRows ?? retentionBatchRows;
  let deletedRows = 0;
  let auditSeq: number | null = null;
  while (!input.signal.aborted) {
    const previousSeq: number | null = auditSeq;
    const committedRows = deletedRows;
    const batch = input.storage.transact((tx): { readonly deleted: number; readonly seq: number | null } => {
      // eslint-disable-next-line security/detect-object-injection -- target.table 来自本文件固定的可轮转表清单。
      const deleted = tx.run(pruneBatchStatements[target.table], [target.cutoff, batchRows]).changes;
      if (deleted === 0) {
        return { deleted, seq: previousSeq };
      }
      const payload = auditPayload({ ...target, deletedRows: committedRows + deleted });
      if (previousSeq !== null) {
        tx.run("UPDATE lifecycle_events SET payload_json = ? WHERE seq = ?", [canonicalJson(payload), previousSeq]);
        return { deleted, seq: previousSeq };
      }
      insertLifecycleAuditEvent(tx, {
        runId: null,
        branchId: null,
        type: retentionAuditType,
        subjectId: target.table,
        payload,
        createdAt,
      });
      return { deleted, seq: Number(tx.get("SELECT last_insert_rowid() AS seq")?.["seq"]) };
    });
    // 事务提交后才更新累计值：回滚的批次既不计数，也不留下指向不存在审计行的序号。
    deletedRows += batch.deleted;
    auditSeq = batch.seq;
    if (batch.deleted < batchRows) {
      break;
    }
    await yieldToEventLoop();
  }
  return { ...target, deletedRows };
}

/** 执行一轮清理：逐表逐批删除过期行；有删除的表记一条日志，返回各表本轮已提交的删除行数。 */
export async function runRetentionPass(input: RetentionPassInput): Promise<readonly RetentionResult[]> {
  const startedAt = input.host.nowIso();
  const results: RetentionResult[] = [];
  for (const target of retentionTargets(input.retentionDays, startedAt)) {
    if (input.signal.aborted) {
      break;
    }
    const result = await pruneTable(input, target, startedAt);
    results.push(result);
    if (result.deletedRows > 0) {
      input.host.logger.info("存储保留期清理完成", {
        table: result.table,
        retentionDays: result.retentionDays,
        cutoff: result.cutoff,
        deletedRows: result.deletedRows,
      });
    }
  }
  return results;
}

/** 已启动的清理调度；stop 清除定时器并让进行中的一轮在下一批之前停止。 */
export interface RetentionSchedule {
  stop(): void;
}

/**
 * 启动清理调度：立即排入第一轮，每轮结束后再隔 retentionIntervalMs 排下一轮，轮次之间不会重叠。
 * 没有任何表配置保留天数时返回 null，不创建定时器。单轮失败只记日志，下一轮照常执行。
 */
export function startRetentionSchedule(input: Omit<RetentionPassInput, "signal">): RetentionSchedule | null {
  if (Object.values(input.retentionDays ?? {}).every((days) => days === undefined)) {
    return null;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      timer = null;
      void runRetentionPass({ ...input, signal: controller.signal })
        .catch((error: unknown) => {
          input.host.logger.error("存储保留期清理失败", { message: errorMessage(error) });
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            schedule(retentionIntervalMs);
          }
        });
    }, delayMs);
    // 清理定时器不应单独让进程保持存活；服务端由监听端口保持运行。
    timer.unref();
  };
  schedule(0);
  return {
    stop: () => {
      controller.abort();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
