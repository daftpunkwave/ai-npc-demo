/**
 * 用 VACUUM INTO 生成整库一致副本：先写入 0700 暂存目录，校验非空与完整性并收紧权限，
 * 再以硬链接独占发布为最终 .db；发布后按数量保留策略清理旧备份。
 * 依赖 node:fs 创建目录、原子链接、权限与失败清理，node:sqlite 执行 VACUUM INTO 与完整性检查；
 * 时间戳与暂存文件名由宿主注入，公共契约提供备份类型。
 * 禁止复制正在写入的库文件、在事务内执行备份、覆盖已有备份文件，或让未通过完整性检查的文件以最终名称出现。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 备份目录由配置的 dataDir 推导，label 已由 backupOptionsSchema 限定为小写字母/数字/连字符。 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  backupOptionsSchema,
  type BackupOptions,
  type BackupResult,
  type HostServices,
} from "@world-prism/contracts";

/** 备份保留上限：成功发布后只保留最近的若干份，避免无界增长。 */
export const maxRetainedBackups = 20;

/** 已发布备份的运行记录：路径、字节数、完整性结论、实际权限位与保留清理结果。 */
export interface PublishedBackup extends BackupResult {
  readonly integrityCheck: "ok";
  readonly mode: number;
  readonly retentionLimit: number;
  readonly removedBackups: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** 删除暂存目录；目录已不存在视为已清理，其余失败返回原因供调用方记录。 */
function removeStagingDirectory(stagingDirectory: string): string | null {
  try {
    rmSync(stagingDirectory, { recursive: true, force: true });
    return null;
  } catch (error) {
    return errorMessage(error);
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

/**
 * 独占发布暂存备份：用硬链接创建最终名称，已存在时追加序号重试，避免并发备份互相覆盖。
 * 返回实际发布的路径；链接由同一目录内的暂存文件生成，不复制内容。
 */
function publishStagedBackup(stagingPath: string, backupDir: string, baseName: string): string {
  for (let suffix = 1; suffix <= maxRetainedBackups * 5; suffix += 1) {
    const candidate = join(backupDir, suffix === 1 ? `${baseName}.db` : `${baseName}-${suffix}.db`);
    try {
      linkSync(stagingPath, candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("同名备份候选过多，无法独占发布");
}

/**
 * 按文件名时间戳保留最近的 maxRetainedBackups 份备份，删除更旧的文件。
 * 清理失败只记录日志，不回滚已经成功发布的备份。
 */
function pruneBackups(backupDir: string, host: HostServices, currentPath: string): number {
  let names: readonly string[];
  try {
    names = readdirSync(backupDir)
      .filter((name) => /^world-prism-.*\.db$/.test(name))
      .sort()
      .reverse();
  } catch (error) {
    host.logger.warn("读取备份目录失败，跳过保留清理", { message: errorMessage(error) });
    return 0;
  }
  let removed = 0;
  for (const name of names.slice(maxRetainedBackups)) {
    const path = join(backupDir, name);
    if (path === currentPath) {
      continue;
    }
    try {
      unlinkSync(path);
      removed += 1;
    } catch (error) {
      host.logger.warn("清理旧备份失败", { path, message: errorMessage(error) });
    }
  }
  return removed;
}

/** 在数据目录下生成一份可重新打开的整库备份；同名文件已存在时占用下一个序号而不是覆盖。 */
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
  const baseName = parsed.label === undefined ? `world-prism-${stamp}` : `world-prism-${stamp}-${parsed.label}`;
  // 暂存目录权限 0700：VACUUM INTO 生成期间的内容不会先以默认权限暴露给其他用户。
  const stagingDirectory = join(backupDir, `${baseName}.${host.ids("backup")}.partial`);
  const stagingPath = join(stagingDirectory, "backup.db");
  try {
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    database.exec(`VACUUM INTO '${escapeSqlString(stagingPath)}'`);
    verifyStagedBackup(stagingPath);
    // VACUUM INTO 生成的文件继承进程默认权限；发布前显式收紧为仅当前用户可读写。
    chmodSync(stagingPath, 0o600);
    const stats = statSync(stagingPath);
    const mode = stats.mode & 0o777;
    const targetPath = publishStagedBackup(stagingPath, backupDir, baseName);
    const removedBackups = pruneBackups(backupDir, host, targetPath);
    return {
      path: targetPath,
      byteSize: stats.size,
      integrityCheck: "ok",
      mode,
      retentionLimit: maxRetainedBackups,
      removedBackups,
    };
  } catch (error) {
    const cleanupError = removeStagingDirectory(stagingDirectory);
    const cleanupSuffix = cleanupError === null ? "" : `；删除暂存目录失败：${cleanupError}`;
    throw new DomainError("invalid-state", `生成 SQLite 备份失败：${errorMessage(error)}${cleanupSuffix}`, {
      cause: error,
      details: { stagingPath },
    });
  } finally {
    // 成功发布后硬链接已保留内容，暂存目录必须清理；失败时由上面的清理分支处理。
    removeStagingDirectory(stagingDirectory);
  }
}
