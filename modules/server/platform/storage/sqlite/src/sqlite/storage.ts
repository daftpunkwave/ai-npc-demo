/**
 * 单写 SQLite 存储适配器实现：打开数据目录、执行迁移，提供同步事务、分支复制与备份。
 * 依赖 node:fs 与 node:path 定位库文件，connection/migrations/schema/transaction/fork/backup 实现与端口契约。
 * 禁止在事务内 await、向调用方暴露连接、跳过迁移失败，或在同一连接上并发提交两个事务。
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  backupOptionsSchema,
  forkBranchRequestSchema,
  type BackupOptions,
  type BackupResult,
  type ForkBranchRequest,
  type ForkBranchResult,
  type HostServices,
  type StoragePort,
  type StorageTransaction,
} from "@ai-npc/contracts";
import type { StorageConfig } from "../definition";
import { backupDatabase, type PublishedBackup } from "./backup";
import { closeDatabase, openDatabase } from "./connection";
import { forkBranchDatabase } from "./fork-branch";
import { applyMigrations } from "./migrations";
import { resolveCatalog, type StorageCatalog } from "./schema";
import { SqliteTransaction, isThenable } from "./transaction";

/** 失败原因转成可安全记录的字符串，避免把任意对象塞进日志数据。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 单写 SQLite 存储端口实现；实例生命周期由模块 start/dispose 驱动。 */
export class SqliteStorage implements StoragePort {
  private readonly config: StorageConfig;
  private readonly host: HostServices;
  private database: DatabaseSync | null = null;
  private catalog: StorageCatalog | null = null;
  private inTransaction = false;
  private opening: Promise<void> | null = null;
  private lifecycleEpoch = 0;

  constructor(config: StorageConfig, host: HostServices) {
    this.config = config;
    this.host = host;
  }

  /** 打开库文件并执行未应用的迁移；重复调用无副作用，失败时连接会被关闭后重新抛出。 */
  open(): Promise<void> {
    if (this.database !== null) {
      return Promise.resolve();
    }
    if (this.opening !== null) {
      return this.opening;
    }
    const epoch = this.lifecycleEpoch;
    const opening = this.openInternal(epoch);
    this.opening = opening;
    void opening.then(
      () => {
        if (this.opening === opening) {
          this.opening = null;
        }
      },
      () => {
        if (this.opening === opening) {
          this.opening = null;
        }
      },
    );
    return opening;
  }

  private async openInternal(epoch: number): Promise<void> {
    const dataDir = resolve(this.config.dataDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 数据库路径由宿主注入的 dataDir 推导，不是请求入参。
    mkdirSync(dataDir, { recursive: true });
    const databasePath = join(dataDir, "ai-npc.db");
    const database = openDatabase(databasePath);
    try {
      const applied = await applyMigrations(
        database,
        this.host.nowIso(),
        this.host.logger,
        this.host.hash,
      );
      if (epoch !== this.lifecycleEpoch) {
        throw new DomainError("cancelled", "存储适配器打开已取消");
      }
      const catalog = resolveCatalog(database);
      this.database = database;
      this.catalog = catalog;
      this.host.logger.info("存储适配器已打开", { databasePath, appliedMigrations: applied.length });
    } catch (error) {
      try {
        closeDatabase(database);
      } catch (closeError) {
        this.host.logger.error("打开失败后关闭存储连接失败", { message: errorMessage(closeError) });
      }
      throw error;
    }
  }

  /** 关闭连接；重复调用安全。关闭失败时保留句柄以便重试。 */
  close(): void {
    this.lifecycleEpoch += 1;
    const database = this.database;
    if (database === null) {
      return;
    }
    closeDatabase(database);
    this.database = null;
    this.catalog = null;
  }

  get isOpen(): boolean {
    return this.database !== null;
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === null) {
      throw new DomainError("not-ready", "存储适配器尚未打开");
    }
    return this.database;
  }

  private requireCatalog(): StorageCatalog {
    if (this.catalog === null) {
      throw new DomainError("not-ready", "存储适配器尚未完成迁移与目录校验");
    }
    return this.catalog;
  }

  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  transact<T>(fn: (tx: StorageTransaction) => T): T {
    const database = this.requireDatabase();
    const catalog = this.requireCatalog();
    if (this.inTransaction) {
      throw new DomainError("invalid-state", "存储适配器不支持嵌套事务，请使用保存点");
    }
    database.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    const transaction = new SqliteTransaction(database, catalog);
    let committed = false;
    try {
      const result = fn(transaction);
      if (isThenable(result)) {
        (result as PromiseLike<unknown>).then(undefined, () => {
          // 同步事务内的异步回调属于编程错误：拒绝结果，异步后续失败不再向上抛出。
        });
        throw new DomainError("invalid-state", "存储事务回调必须是同步函数，不能返回 Promise");
      }
      transaction.close();
      database.exec("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      transaction.close();
      if (!committed) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackError) {
          this.host.logger.error("存储事务回滚失败", { message: errorMessage(rollbackError) });
          throw new DomainError("invalid-state", "存储事务回滚失败，连接状态不再可信", {
            cause: { rollbackError, originalError: error },
          });
        }
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  forkBranch(tx: StorageTransaction, request: ForkBranchRequest): ForkBranchResult {
    const database = this.requireDatabase();
    const catalog = this.requireCatalog();
    if (!this.inTransaction) {
      throw new DomainError("invalid-state", "分支复制必须在存储事务内执行");
    }
    if (!(tx instanceof SqliteTransaction) || !tx.isOpen) {
      throw new DomainError("invalid-state", "分支复制的事务对象不属于当前存储适配器或已结束");
    }
    const parsed = forkBranchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new DomainError("validation", "分支复制请求不合法", {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
          })),
        },
      });
    }
    return forkBranchDatabase(database, catalog, this.host.nowIso(), parsed.data);
  }

  backup(options: BackupOptions = {}): BackupResult {
    const database = this.requireDatabase();
    if (this.inTransaction) {
      throw new DomainError("invalid-state", "整库备份不能在存储事务内执行");
    }
    const parsed = backupOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new DomainError("validation", "备份选项不合法", {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((segment) => String(segment)).join("."),
            message: issue.message,
          })),
        },
      });
    }
    const result: PublishedBackup = backupDatabase(database, this.config.dataDir, this.host, parsed.data);
    // 记录完整性校验与实际权限位，作为备份可恢复性的运行证据；Windows 的权限位不完全对应 POSIX 语义。
    this.host.logger.info("SQLite 备份已生成", {
      path: result.path,
      byteSize: result.byteSize,
      integrityCheck: result.integrityCheck,
      mode: result.mode,
      retentionLimit: result.retentionLimit,
      removedBackups: result.removedBackups,
    });
    return result;
  }
}
