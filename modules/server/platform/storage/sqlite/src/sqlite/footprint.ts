/**
 * 核心职责：在后台分块测量存储占用：主库页面与空闲页字节、artifact 正文字节、只追加表的行数与生效的保留天数，
 *   并调度启动时立即测量、之后按固定间隔重测的测量轮次。
 * 交互契约：经存储适配器提供的事务外只读入口逐条执行有界查询：每张表沿 rowid 范围分块计数，每块至多 chunkRows 行，
 *   artifact 正文字节在同一遍分块里累加；每条查询之前让出事件循环，中止信号在下一次读取之前生效；
 *   完整测得的结果经回调交给适配器保存，中止的一轮不产出结果。
 * 约束与禁忌：只读不写；表名来自本文件的固定清单，禁止拼接调用方传入的表名、用一条语句统计整张表，
 *   或在中止后继续读取。被测表必须是 rowid 表：WITHOUT ROWID 表没有可分块的 rowid。
 */
import type { HostServices, StorageFootprint, StorageValue } from "@world-prism/contracts";
import type { RetentionDays } from "../definition";
import { startBackgroundPass, yieldToEventLoop, type BackgroundPassSchedule } from "./background-pass";

/** 只追加、随运行持续增长的表；测量结果按此顺序列出。 */
export const measuredTables = [
  "domain_events",
  "command_receipts",
  "consumer_inbox",
  "observations",
  "memory_records",
  "memory_revisions",
  "turn_runs",
  "model_attempts",
  "tool_calls",
  "artifacts",
  "trace_spans",
  "lifecycle_events",
  "budget_ledger",
] as const;

export type MeasuredTable = (typeof measuredTables)[number];

/**
 * 单块读取的行数上限。分块沿表的 rowid B-tree 读取叶页，一块的读取量只取决于块大小与行宽，与表规模无关；
 * 计数与 artifact 字节汇总只用到 rowid 与正文之前的列，不读取溢出页上的正文。
 */
export const footprintChunkRows = 1_000;

/** 两轮测量之间的间隔。一轮要读完每张被测表的叶页，不随约 2 秒一次的健康摘要重测。 */
export const footprintIntervalMs = 5 * 60 * 1000;

/** 通用分块计数：从上一块的最大 rowid 之后取至多 ? 行，返回本块行数与最大 rowid。 */
function tableChunkSql(table: MeasuredTable): string {
  return `SELECT COUNT(*) AS row_count, MAX(rowid) AS last_rowid
  FROM (SELECT rowid FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?)`;
}

/** artifacts 的分块在计数的同时按存放方式累加 byte_size；storage 与 byte_size 位于 body 之前，不读取溢出页。 */
const artifactChunkSql = `SELECT COUNT(*) AS row_count, MAX(rowid) AS last_rowid,
  COALESCE(SUM(CASE storage WHEN 'inline' THEN byte_size END), 0) AS inline_bytes,
  COALESCE(SUM(CASE storage WHEN 'file' THEN byte_size END), 0) AS file_bytes
  FROM (SELECT rowid, storage, byte_size FROM artifacts WHERE rowid > ? ORDER BY rowid LIMIT ?)`;

/** 测量用到的全部语句；测试对同一组语句断言查询计划只按 rowid 范围读取。 */
export const footprintStatements = {
  pageBytes: `SELECT page_count * page_size AS database_bytes, freelist_count * page_size AS free_bytes
  FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()`,
  chunks: Object.fromEntries(measuredTables.map((table) =>
    [table, table === "artifacts" ? artifactChunkSql : tableChunkSql(table)])) as Readonly<Record<MeasuredTable, string>>,
} as const;

/* eslint-disable no-unused-vars -- 回调类型签名中的参数名只用于表达调用契约。 */
/** 适配器提供的事务外只读入口：同步执行一条语句并返回首行。 */
export type FootprintRead = (sql: string, params: readonly StorageValue[]) => Readonly<Record<string, unknown>> | undefined;

/** 一轮测量的依赖与参数。 */
export interface FootprintMeasureInput {
  readonly read: FootprintRead;
  readonly nowIso: () => string;
  readonly retentionDays: RetentionDays | undefined;
  readonly signal: AbortSignal;
  readonly chunkRows?: number;
  /** 每次读取之前的让出；缺省经 setImmediate 让出事件循环。 */
  readonly pause?: () => Promise<void>;
}

/** 测量调度的依赖：只读入口、宿主时钟与日志，以及保存完整测得结果的回调。 */
export interface FootprintScheduleInput {
  readonly read: FootprintRead;
  readonly host: Pick<HostServices, "nowIso" | "logger">;
  readonly retentionDays: RetentionDays | undefined;
  readonly onMeasured: (footprint: StorageFootprint) => void;
}
/* eslint-enable no-unused-vars */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 测量一轮：逐表分块计数，最后读取页面统计。各块各自取读快照，测量期间的并发写入只影响本轮读到的行数，
 * 不影响其正确性；measuredAt 取完成时刻。中止时返回 null，不产出只覆盖部分表的结果。
 * SQLite 自动分配的 rowid 从 1 起递增，被测表都不显式写入 rowid，因此游标从 0 开始。
 */
export async function measureFootprint(input: FootprintMeasureInput): Promise<StorageFootprint | null> {
  const chunkRows = input.chunkRows ?? footprintChunkRows;
  const pause = input.pause ?? yieldToEventLoop;
  const readAfterPause = async (sql: string, params: readonly StorageValue[]): Promise<Readonly<Record<string, unknown>> | null> => {
    await pause();
    return input.signal.aborted ? null : (input.read(sql, params) ?? {});
  };
  const tables: { readonly table: string; readonly rows: number }[] = [];
  const artifactBytes = { inline: 0, file: 0 };
  for (const table of measuredTables) {
    let rows = 0;
    let afterRowid = 0;
    for (;;) {
      // eslint-disable-next-line security/detect-object-injection -- table 来自本文件固定的被测表清单。
      const chunk = await readAfterPause(footprintStatements.chunks[table], [afterRowid, chunkRows]);
      if (chunk === null) {
        return null;
      }
      const counted = Number(chunk["row_count"] ?? 0);
      rows += counted;
      if (table === "artifacts") {
        artifactBytes.inline += Number(chunk["inline_bytes"] ?? 0);
        artifactBytes.file += Number(chunk["file_bytes"] ?? 0);
      }
      if (counted < chunkRows) {
        break;
      }
      afterRowid = Number(chunk["last_rowid"]);
    }
    tables.push({ table, rows });
  }
  const pages = await readAfterPause(footprintStatements.pageBytes, []);
  if (pages === null) {
    return null;
  }
  return {
    measuredAt: input.nowIso(),
    databaseBytes: Number(pages["database_bytes"] ?? 0),
    freeBytes: Number(pages["free_bytes"] ?? 0),
    artifactBytes,
    tables,
    retention: Object.entries(input.retentionDays ?? {}).flatMap(([table, days]) =>
      days === undefined ? [] : [{ table, days }]),
  };
}

/**
 * 启动测量调度：立即排入首轮，每轮结束后再隔 footprintIntervalMs 重测。单轮失败只记日志，下一轮照常执行；
 * stop 让进行中的一轮在下一次读取之前停止，已中止的一轮不会回调结果。
 */
export function startFootprintSchedule(input: FootprintScheduleInput): BackgroundPassSchedule {
  return startBackgroundPass({
    intervalMs: footprintIntervalMs,
    run: async (signal) => {
      const footprint = await measureFootprint({
        read: input.read,
        nowIso: () => input.host.nowIso(),
        retentionDays: input.retentionDays,
        signal,
      });
      if (footprint !== null && !signal.aborted) {
        input.onMeasured(footprint);
      }
    },
    onError: (error) => {
      input.host.logger.error("存储占用测量失败", { message: errorMessage(error) });
    },
  });
}
