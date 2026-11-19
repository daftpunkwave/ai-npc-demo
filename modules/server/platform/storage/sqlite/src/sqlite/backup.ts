/**
 * 用 VACUUM INTO 生成整库一致副本：按 UTC 时间戳命名，写入数据目录下的 backups 子目录。
 * 依赖 node:fs 创建目录与读取文件大小、node:sqlite 执行 VACUUM INTO、公共契约的备份类型。
 * 禁止复制正在写入的库文件、在事务内执行备份或覆盖已有备份文件。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 备份目录由配置的 dataDir 推导，label 已由 backupOptionsSchema 限定为小写字母/数字/连字符。 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  backupOptionsSchema,
  type BackupOptions,
  type BackupResult,
} from "@ai-npc/contracts";

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

/** 把 ISO-8601 UTC 时间转换为可跨平台的文件名片段（冒号与点在 Windows 上非法）。 */
function timestampForFileName(nowIso: string): string {
  return nowIso.replaceAll(":", "-").replaceAll(".", "-");
}

/** 在数据目录下生成一份可重新打开的整库备份；同名文件已存在时追加序号而不是覆盖。 */
export function backupDatabase(
  database: DatabaseSync,
  dataDir: string,
  nowIso: string,
  options: BackupOptions = {},
): BackupResult {
  const parsed = backupOptionsSchema.parse(options);
  const backupDir = resolve(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = timestampForFileName(nowIso);
  const baseName = parsed.label === undefined ? `ai-npc-${stamp}` : `ai-npc-${stamp}-${parsed.label}`;
  let targetPath = join(backupDir, `${baseName}.db`);
  let suffix = 2;
  while (existsSync(targetPath)) {
    targetPath = join(backupDir, `${baseName}-${suffix}.db`);
    suffix += 1;
  }
  try {
    database.exec(`VACUUM INTO '${escapeSqlString(targetPath)}'`);
  } catch (error) {
    throw new DomainError("invalid-state", "生成 SQLite 备份失败", {
      cause: error,
      details: { targetPath },
    });
  }
  const stats = statSync(targetPath);
  return { path: targetPath, byteSize: stats.size };
}
