/**
 * 核心职责：打开数据目录、执行迁移，提供同步事务、分支复制、备份、artifact 大正文文件与后台占用测量的最近结果，并持有连接级预编译语句缓存。
 * 交互契约：依赖 node:fs 与 node:path 定位库文件，connection/migrations/schema/statement-cache/transaction/fork/backup/
 * artifact-files/footprint 实现与端口契约；语句缓存随连接创建，占用测量由模块启动后开始，二者在连接关闭时随之清空或停止；
 * artifact 正文文件按配置的 inlineArtifactMaxBytes 分流，与数据库连接的开关无关。
 * 约束与禁忌：禁止在事务内 await、向调用方暴露连接、跳过迁移失败、在同一连接上并发提交两个事务、
 * 跨越连接存活期复用缓存、在健康读取路径上统计行数，或在回滚失败后继续复用状态不可信的连接。
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  backupOptionsSchema,
  forkBranchRequestSchema,
  type ArtifactFileStore,
  type BackupOptions,
  type BackupResult,
  type ForkBranchRequest,
  type ForkBranchResult,
  type HostServices,
  type StorageFootprint,
  type StoragePort,
  type StorageTransaction,
  type StorageValue,
} from "@world-prism/contracts";
import type { StorageConfig } from "../definition";
import { SqliteArtifactFiles } from "./artifact-files";
import type { BackgroundPassSchedule } from "./background-pass";
import { backupDatabase, type PublishedBackup } from "./backup";
import { closeDatabase, openDatabase } from "./connection";
import { forkBranchDatabase } from "./fork-branch";
import { startFootprintSchedule } from "./footprint";
import { applyMigrations } from "./migrations";
import { resolveCatalog, type StorageCatalog } from "./schema";
import { StatementCache } from "./statement-cache";
import { SqliteTransaction, isThenable } from "./transaction";

/** 失败原因转成可安全记录的字符串，避免把任意对象塞进日志数据。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 单写 SQLite 存储端口实现；实例生命周期由模块 start/dispose 驱动。 */
export class SqliteStorage implements StoragePort {
  readonly artifactFiles: ArtifactFileStore;
  private readonly config: StorageConfig;
  private readonly host: HostServices;
  private database: DatabaseSync | null = null;
  private catalog: StorageCatalog | null = null;
  /** 与 database 同生共死的语句缓存；连接关闭后必须一并丢弃，避免语句指向已关闭的句柄。 */
  private statements: StatementCache | null = null;
  private inTransaction = false;
  /** 回滚失败后的连接根因；非空时所有数据访问立即失败，直到关闭并重新打开。 */
  private fatalFailure: { readonly rollbackError: unknown; readonly originalError: unknown } | null = null;
  private opening: Promise<void> | null = null;
  private lifecycleEpoch = 0;
  /** 后台占用测量调度；模块启动后创建，连接关闭时停止。 */
  private footprintSchedule: BackgroundPassSchedule | null = null;
  /** 最近一次完整测得的占用；首轮完成前与连接关闭后为 null。 */
  private latestFootprint: StorageFootprint | null = null;

  constructor(config: StorageConfig, host: HostServices) {
    this.config = config;
    this.host = host;
    this.artifactFiles = new SqliteArtifactFiles(config.dataDir, config.inlineArtifactMaxBytes);
  }

  /** 打开库文件并执行未应用的迁移；重复调用无副作用，失败时连接会被关闭后重新抛出。 */
  open(): Promise<void> {
    if (this.fatalFailure !== null) {
      return Promise.reject(this.unusableConnectionError());
    }
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
    const databasePath = join(dataDir, "world-prism.db");
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
      this.statements = new StatementCache(database);
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

  /** 关闭连接并清空语句缓存；重复调用安全。关闭失败时保留句柄与不可用标记以便重试。 */
  close(): void {
    this.lifecycleEpoch += 1;
    // 先停止后台测量：进行中的一轮在下一次读取之前结束，不会读到即将关闭的连接。
    this.footprintSchedule?.stop();
    this.footprintSchedule = null;
    const database = this.database;
    if (database === null) {
      return;
    }
    closeDatabase(database);
    // 连接成功关闭后缓存再无意义：语句绑定在已释放的句柄上，必须一并丢弃。
    // 关闭失败时保留句柄与缓存，与下面保留 database 以便重试的既有语义一致。
    this.statements?.clear();
    this.statements = null;
    this.database = null;
    this.catalog = null;
    this.fatalFailure = null;
    this.latestFootprint = null;
  }

  get isOpen(): boolean {
    return this.database !== null && this.fatalFailure === null;
  }

  /** 构造连接不可用的领域错误；根因保存在 cause，避免后续调用只看到模糊的 SQLite 事务错误。 */
  private unusableConnectionError(): DomainError {
    return new DomainError("invalid-state", "存储连接在事务回滚失败后不可用，需要重启服务端", {
      cause: this.fatalFailure,
    });
  }

  private requireDatabase(): DatabaseSync {
    if (this.fatalFailure !== null) {
      throw this.unusableConnectionError();
    }
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

  private requireStatements(): StatementCache {
    if (this.statements === null) {
      throw new DomainError("not-ready", "存储适配器尚未打开语句缓存");
    }
    return this.statements;
  }

  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  transact<T>(fn: (tx: StorageTransaction) => T): T {
    const database = this.requireDatabase();
    const catalog = this.requireCatalog();
    const statements = this.requireStatements();
    if (this.inTransaction) {
      throw new DomainError("invalid-state", "存储适配器不支持嵌套事务，请使用保存点");
    }
    database.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    const transaction = new SqliteTransaction(database, catalog, statements);
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
          // 回滚失败后连接可能仍停在事务里：显式标记不可用并保留根因，后续调用立即失败而不是发出模糊的 SQLite 错误。
          this.fatalFailure = { rollbackError, originalError: error };
          this.host.logger.error("存储事务回滚失败，连接已标记不可用", { message: errorMessage(rollbackError) });
          throw this.unusableConnectionError();
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

  /**
   * 开始后台占用测量：立即排入首轮，之后按固定间隔重测，直到连接关闭。由模块 start 在打开连接后调用，重复调用无副作用。
   */
  startFootprintMeasurement(): void {
    this.requireDatabase();
    this.footprintSchedule ??= startFootprintSchedule({
      read: (sql, params) => this.readOutsideTransaction(sql, params),
      host: this.host,
      retentionDays: this.config.retentionDays,
      onMeasured: (footprint) => {
        this.latestFootprint = footprint;
      },
    });
  }

  /**
   * 在事务外执行一条只读语句并返回首行，供后台占用测量逐块读取。
   * 不经 BEGIN IMMEDIATE：WAL 模式下自动提交的读语句只在执行期间持有本条语句的读快照，不取写锁，
   * 也不产生需要提交的事务；调用是同步的，不会与本连接上的事务交错。每条语句自身必须有界。
   */
  readOutsideTransaction(sql: string, params: readonly StorageValue[]): Readonly<Record<string, unknown>> | undefined {
    this.requireDatabase();
    return this.requireStatements().prepare(sql).get(...params);
  }

  /** 返回最近一次完整测得的占用；首轮测量完成前为 null。只读内存中的结果，不访问数据库，可在任何时刻调用。 */
  footprint(): StorageFootprint | null {
    return this.latestFootprint;
  }
}
