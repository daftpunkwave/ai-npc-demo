/**
 * 核心职责：在一个事务内测量存储占用：主库页面与空闲页字节、artifact 正文字节、只追加表的行数与生效的保留天数。
 * 交互契约：由存储适配器在自己的短事务内调用；计数与汇总语句都只扫描覆盖索引，不读取行正文与 artifact 文件。
 * 约束与禁忌：只读不写；表名来自本文件的固定清单，禁止拼接调用方传入的表名或访问文件系统。
 */
import type { StorageFootprint, StorageTransaction } from "@world-prism/contracts";
import type { RetentionDays } from "../definition";

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

/** 测量用到的全部语句；测试对同一组语句断言查询计划只扫描覆盖索引。 */
export const footprintStatements = {
  /** 一条语句统计全部表的行数；每张表都有覆盖索引，COUNT(*) 只扫描索引页。 */
  tableRows: measuredTables
    .map((table) => `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`)
    .join("\nUNION ALL\n"),
  pageBytes: `SELECT page_count * page_size AS database_bytes, freelist_count * page_size AS free_bytes
  FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()`,
  /** 按存放方式汇总正文字节；0021 的 artifacts_storage_bytes 覆盖索引让汇总不读取内联正文。 */
  artifactBytes: "SELECT storage, COALESCE(SUM(byte_size), 0) AS bytes FROM artifacts GROUP BY storage",
} as const;

/** 测量当前占用；measuredAt 由调用方按宿主时钟给出。 */
export function measureFootprint(
  tx: StorageTransaction,
  measuredAt: string,
  retentionDays: RetentionDays | undefined,
): StorageFootprint {
  const pages = tx.get(footprintStatements.pageBytes);
  const rowCounts = new Map(tx.all(footprintStatements.tableRows).map((row) => [String(row["table_name"]), Number(row["row_count"])]));
  const artifactBytes = { inline: 0, file: 0 };
  for (const row of tx.all(footprintStatements.artifactBytes)) {
    if (row["storage"] === "inline") {
      artifactBytes.inline = Number(row["bytes"]);
    } else if (row["storage"] === "file") {
      artifactBytes.file = Number(row["bytes"]);
    }
  }
  return {
    measuredAt,
    databaseBytes: Number(pages?.["database_bytes"] ?? 0),
    freeBytes: Number(pages?.["free_bytes"] ?? 0),
    artifactBytes,
    tables: measuredTables.map((table) => ({ table, rows: rowCounts.get(table) ?? 0 })),
    retention: Object.entries(retentionDays ?? {}).flatMap(([table, days]) =>
      days === undefined ? [] : [{ table, days }]),
  };
}
