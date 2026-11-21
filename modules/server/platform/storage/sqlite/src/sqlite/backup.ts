/**
 * 用 VACUUM INTO 生成整库一致副本：先写入同目录暂存文件，校验非空与完整性后原子改名为最终 .db。
 * 依赖 node:fs 创建目录、原子改名、设置权限与失败清理，node:sqlite 执行 VACUUM INTO 与完整性检查；
 * 时间戳与暂存文件名的唯一后缀由宿主注入，公共契约提供备份类型。
 * 禁止复制正在写入的库文件、在事务内执行备份、覆盖已有备份文件，或让未通过完整性检查的文件以最终名称出现。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 备份目录由配置的 dataDir 推导，label 已由 backupOptionsSchema 限定为小写字母/数字/连字符。 */
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  backupOptionsSchema,
  type BackupOptions,
  type BackupResult,
  type HostServices,
} from "@ai-npc/contracts";

/** 已发布备份的运行时记录：路径、字节数、完整性校验结果与实际权限位（Windows 权限位语义受限）。 */
export interface PublishedBackup extends BackupResult {
  readonly integrityCheck: "ok";
  readonly mode: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 删除暂存备份；文件已不存在视为已清理，其余失败返回原因供调用方记录。 */
function removeStagingFile(stagingPath: string): string | null {
  try {
    unlinkSync(stagingPath);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : errorMessage(error);
  }
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

/** 把 ISO-8601 UTC 时间转换为可跨平台的文件名片段（冒号与点在 Windows 上非法）。 */
function timestampForFileName(nowIso: string): string {
  return nowIso.replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * 校验暂存备份非空且通过 SQLite 完整性检查。
 * 备份文件可能被意外中断的 VACUUM INTO 写成不完整状态，只有检查通过的内容才允许发布为最终名称。
 */
function verifyStagedBackup(stagingPath: string): void {
  if (statSync(stagingPath).size === 0) {
    throw new Error("备份文件为空");
  }
  const verification = new DatabaseSync(stagingPath, { readOnly: true });
  try {
    const row = verification.prepare("PRAGMA integrity_check").get();
    const result = row === undefined ? undefined : Object.values(row)[0];
    if (result !== "ok") {
      throw new Error(`备份完整性检查未通过：${result === undefined ? "无结果" : String(result)}`);
    }
  } finally {
    verification.close();
  }
}

/** 在数据目录下生成一份可重新打开的整库备份；同名文件已存在时追加序号而不是覆盖。 */
export function backupDatabase(
  database: DatabaseSync,
  dataDir: string,
  host: HostServices,
  options: BackupOptions = {},
): PublishedBackup {
  const parsed = backupOptionsSchema.parse(options);
  const backupDir = resolve(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = timestampForFileName(host.nowIso());
  const baseName = parsed.label === undefined ? `ai-npc-${stamp}` : `ai-npc-${stamp}-${parsed.label}`;
  let targetPath = join(backupDir, `${baseName}.db`);
  let suffix = 2;
  while (existsSync(targetPath)) {
    targetPath = join(backupDir, `${baseName}-${suffix}.db`);
    suffix += 1;
  }
  // 暂存名带宿主生成的唯一后缀且不以 .db 结尾：崩溃或失败时不会被当作有效备份。
  const stagingPath = join(backupDir, `${baseName}.${host.ids("backup")}.partial`);
  try {
    database.exec(`VACUUM INTO '${escapeSqlString(stagingPath)}'`);
    verifyStagedBackup(stagingPath);
    // VACUUM INTO 生成的文件继承进程默认权限；发布前显式收紧为仅当前用户可读写。
    chmodSync(stagingPath, 0o600);
    const stats = statSync(stagingPath);
    const mode = stats.mode & 0o777;
    renameSync(stagingPath, targetPath);
    return { path: targetPath, byteSize: stats.size, integrityCheck: "ok", mode };
  } catch (error) {
    const cleanupError = removeStagingFile(stagingPath);
    const cleanupSuffix = cleanupError === null ? "" : `；删除暂存文件失败：${cleanupError}`;
    throw new DomainError("invalid-state", `生成 SQLite 备份失败：${errorMessage(error)}${cleanupSuffix}`, {
      cause: error,
      details: { targetPath, stagingPath },
    });
  }
}
