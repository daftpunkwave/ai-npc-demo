/**
 * 核心职责：把健康响应中的存储占用测量转换为运行总览面板直接渲染的字节、行数与保留策略文案。
 * 交互契约：输入已通过 consoleHealthResponseSchema 校验的响应；不发起请求、不保留状态。
 * 约束与禁忌：响应不含 storage 时返回 null，首轮测量未完成时返回待测量状态，禁止用 0 冒充未提供或尚未完成的测量；
 *   保留天数为空时必须标明永久保留。
 */
import type { ConsoleHealthResponse } from "@world-prism/contracts";

/** 已完成测量的面板文案。 */
export interface StorageMeasuredView {
  readonly status: "measured";
  readonly measuredAt: string;
  readonly databaseText: string;
  /** 空闲页：删除释放、等待复用的空间。 */
  readonly freeText: string;
  readonly artifactText: string;
  readonly retentionText: string;
  readonly tables: readonly { readonly table: string; readonly rowsText: string }[];
}

/** 服务端提供测量，但首轮后台测量尚未完成。 */
export interface StoragePendingView {
  readonly status: "pending";
}

export type StorageSummaryView = StorageMeasuredView | StoragePendingView;

const byteUnits = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** 按 1024 进位格式化字节数；1 KiB 以上保留一位小数。 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${byteUnits[unit] ?? "TiB"}`;
}

export function storageSummary(health: ConsoleHealthResponse): StorageSummaryView | null {
  const storage = health.storage;
  if (storage === undefined) {
    return null;
  }
  if (storage === null) {
    return { status: "pending" };
  }
  const rowsFormat = new Intl.NumberFormat("en-US");
  return {
    status: "measured",
    measuredAt: storage.measuredAt,
    databaseText: formatBytes(storage.databaseBytes),
    freeText: formatBytes(storage.freeBytes),
    artifactText: `内联 ${formatBytes(storage.artifactBytes.inline)} / 文件 ${formatBytes(storage.artifactBytes.file)}`,
    retentionText: storage.retention.length === 0
      ? "全部永久保留"
      : storage.retention.map((entry) => `${entry.table} ${entry.days} 天`).join("，"),
    tables: storage.tables.map((entry) => ({ table: entry.table, rowsText: rowsFormat.format(entry.rows) })),
  };
}
