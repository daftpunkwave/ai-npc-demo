/**
 * 定义存储适配器的公共端口：同步事务、保存点、按分支 scope 的读写、分支复制、备份与占用测量。
 * 依赖 JSON 值与 Zod 校验；只声明宿主固定机制需要的存储边界，不暴露 SQLite 驱动类型或连接句柄。
 * 禁止跨分支读写分支级表、在事务内 await、把原始连接泄漏给业务模块或吞掉写入失败。
 */
/* eslint-disable no-unused-vars -- 本文件是存储端口契约，未使用参数只出现在接口方法签名中，名称用于表达调用契约。 */
import { z } from "zod";
import { type Json } from "./json";

/** 适配器可绑定的标量值；与 SQLite 驱动接受的参数类型一致，不泄漏驱动自身类型。 */
export type StorageValue = null | number | bigint | string | Uint8Array;

/** 原始查询返回的一行：列名到驱动值；JSON 列保持 TEXT，由调用方按 schema 解析。 */
export type StorageRawRow = Readonly<Record<string, StorageValue>>;

/** 表级读写接口解码后的值：JSON 列已解析为 JSON 值，BLOB 保持字节数组。 */
export type StorageCell = Json | Uint8Array;

/** 表级读写接口返回的一行；列名到解码后的值。 */
export type StorageRow = Readonly<Record<string, StorageCell>>;

/** 等值过滤条件：列名到标量值；不支持表达式或 SQL 片段。 */
export type StorageFilter = Readonly<Record<string, StorageValue>>;

/** 排序规则：列名与方向，方向缺省为升序。 */
export interface StorageOrder {
  readonly column: string;
  readonly direction?: "asc" | "desc";
}

/** 列表查询选项：前缀过滤、排他上界、排序、条数与偏移。 */
export interface StorageListOptions {
  /**
   * 前缀过滤：指定 TEXT 列的值必须以 value 开头，按 SQLite BINARY（UTF-8 字节序）比较。
   * 实现编译为索引范围查询而非 LIKE 扫描；value 必须为可打印 ASCII（0x20–0x7E），
   * 否则字节上界无法用合法 UTF-8 表达，直接拒绝。
   */
  readonly prefix?: { readonly column: string; readonly value: string };
  /** 排他上界：指定 TEXT 列的值必须小于 value；与 prefix 组合可表达有界区间，取值约束同 prefix。 */
  readonly before?: { readonly column: string; readonly value: string };
  readonly orderBy?: readonly StorageOrder[];
  readonly limit?: number;
  readonly offset?: number;
}

/** 写入结果：受影响行数。 */
export interface StorageWriteResult {
  readonly changes: number;
}

/** 分支类型：在线世界、实验 run、冻结快照与探针沙盒。 */
export const branchKindSchema = z.enum(["online", "experiment", "snapshot", "sandbox"]);

export type BranchKind = z.infer<typeof branchKindSchema>;

/** 分支状态：活动、暂停、冻结与归档。 */
export const branchStatusSchema = z.enum(["active", "paused", "frozen", "archived"]);

export type BranchStatus = z.infer<typeof branchStatusSchema>;

/**
 * 分支复制请求：源分支、新分支 ID 与分支类型。
 * 在线世界与实验分支必须给出归属 run；快照与沙盒分支不得携带 run。
 */
export const forkBranchRequestSchema = z
  .object({
    srcBranchId: z.string().min(1),
    dstBranchId: z.string().min(1),
    kind: branchKindSchema,
    runId: z.string().min(1).nullable().optional(),
    profileHash: z.string().min(1).nullable().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const needsRun = request.kind === "online" || request.kind === "experiment";
    if (needsRun && (request.runId === undefined || request.runId === null)) {
      context.addIssue({ code: "custom", path: ["runId"], message: "在线世界与实验分支必须绑定 run" });
    }
    if (!needsRun && request.runId !== undefined && request.runId !== null) {
      context.addIssue({ code: "custom", path: ["runId"], message: "快照与沙盒分支不能绑定 run" });
    }
  });

export type ForkBranchRequest = z.infer<typeof forkBranchRequestSchema>;

/** 分支复制结果：新分支行的关键字段与每张分支级表复制到的行数。 */
export interface ForkBranchResult {
  readonly branchId: string;
  readonly parentBranchId: string;
  readonly kind: BranchKind;
  readonly status: BranchStatus;
  readonly runId: string | null;
  readonly profileHash: string | null;
  readonly forkedAtWorldSeq: number | null;
  readonly copiedRows: Readonly<Record<string, number>>;
}

/** 备份文件名可选标签：只允许小写字母、数字与连字符，不能借此指定路径。 */
export const backupOptionsSchema = z
  .object({
    label: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "备份标签只能包含小写字母、数字与连字符")
      .optional(),
  })
  .strict();

export type BackupOptions = z.infer<typeof backupOptionsSchema>;

/** 备份结果：生成的整库一致副本路径与字节数。 */
export interface BackupResult {
  readonly path: string;
  readonly byteSize: number;
}

/**
 * 单张表的读写接口：键为完整主键（分支级表额外由 scope 注入 branch_id）。
 * 写入走 INSERT ... ON CONFLICT 更新；列名与表名必须存在于本适配器推导的目录中。
 */
export interface StorageTable {
  readonly table: string;
  get(key: StorageFilter): StorageRow | null;
  list(filter?: StorageFilter, options?: StorageListOptions): readonly StorageRow[];
  put(row: StorageRow): StorageWriteResult;
  delete(key: StorageFilter): StorageWriteResult;
  count(filter?: StorageFilter): number;
  max(column: string, filter?: StorageFilter): StorageValue;
}

/** 绑定一个分支的 scoped 读写接口：只能访问分支级表，读写自动限定并写入该 branch_id。 */
export interface ScopedBranchStorage {
  readonly branchId: string;
  table(name: string): StorageTable;
}

/**
 * 一个同步事务内的存储视图。
 * 原始查询用于固定机制的跨分支/范围查询；表级接口用于常规读写并强制分支 scope。
 */
export interface StorageTransaction {
  get(sql: string, params?: readonly StorageValue[]): StorageRawRow | null;
  all(sql: string, params?: readonly StorageValue[]): readonly StorageRawRow[];
  run(sql: string, params?: readonly StorageValue[]): StorageWriteResult;
  /** 部署级与运行级表：不含 branch_id 主键列的表。 */
  rows(table: string): StorageTable;
  /** 分支级表：必须经该接口访问，自动限定 branch_id。 */
  branch(branchId: string): ScopedBranchStorage;
  /** 在当前事务内建立 SAVEPOINT；回调抛错时回滚到保存点并重新抛出。 */
  savepoint<T>(name: string, fn: () => T): T;
}

/**
 * artifact 大正文的文件存放：不超过 inlineMaxBytes 的正文内联进 artifacts.body，更大的正文写到数据目录下的独立文件。
 * 全部方法都必须在事务外调用：存储只有一条写连接，事务内的文件 I/O 会延长写锁占用。
 */
export interface ArtifactFileStore {
  /** 正文内联上限（字节，含边界）；超过即写文件。 */
  readonly inlineMaxBytes: number;
  /** 以独占方式写入正文并返回登记到 artifacts.file_path 的相对路径；同名文件已存在时抛错。 */
  write(artifactId: string, body: Uint8Array): string;
  /** 按 artifacts.file_path 读取正文；路径不在 artifact 目录内时拒绝。 */
  read(filePath: string): Uint8Array;
  /** 删除尚未登记成功的正文文件；用于登记事务失败后的清理，文件不存在时不报错。 */
  remove(filePath: string): void;
}

const byteCountSchema = z.number().int().nonnegative();

/**
 * 保留天数上限，约 100 年：更长的保留期与永久保留没有区别，应直接省略。
 * 部署配置解析与存储适配器的配置 schema 共用这一上限，两处对同一取值给出相同结论。
 */
export const maxRetentionDays = 36_500;

/**
 * 存储占用测量：主库页面与空闲页字节、artifact 正文字节、只追加表的行数与生效的保留天数。
 * 测量结果带完成时刻；适配器在后台按固定间隔重测，读取方拿到的可能是数分钟前的值。
 */
export const storageFootprintSchema = z
  .object({
    measuredAt: z.string().min(1),
    /** 主库页面总字节（page_count × page_size），不含 WAL 文件。 */
    databaseBytes: byteCountSchema,
    /** 空闲页字节：删除行后释放、等待复用的页；执行 VACUUM 之前文件不会因此变小。 */
    freeBytes: byteCountSchema,
    /** artifact 正文字节，按内联 BLOB 与数据目录下的独立文件分开计。 */
    artifactBytes: z.object({ inline: byteCountSchema, file: byteCountSchema }).strict(),
    tables: z.array(z.object({ table: z.string().min(1), rows: byteCountSchema }).strict()),
    /** 生效的保留天数；空数组表示全部永久保留。 */
    retention: z.array(z.object({ table: z.string().min(1), days: z.number().int().positive() }).strict()),
  })
  .strict();

export type StorageFootprint = z.infer<typeof storageFootprintSchema>;

/** 存储适配器端口：唯一写连接上的同步事务、分支复制、整库备份与 artifact 大正文文件。 */
export interface StoragePort {
  /** 在 BEGIN IMMEDIATE 事务内同步执行；回调返回 Promise 时回滚并抛错。 */
  transact<T>(fn: (tx: StorageTransaction) => T): T;
  /** 在调用方事务内复制源分支的全部分支级数据并写入新 branches 行。 */
  forkBranch(tx: StorageTransaction, request: ForkBranchRequest): ForkBranchResult;
  /** 用 VACUUM INTO 生成整库一致副本；不能与事务并发执行。 */
  backup(options?: BackupOptions): BackupResult;
  /** 超过内联上限的 artifact 正文所在的文件存放；只在事务外使用。 */
  readonly artifactFiles: ArtifactFileStore;
  /**
   * 最近一次完整测得的存储占用；首轮测量完成前为 null。
   * 测量由适配器在后台分块执行，本方法只返回内存中的结果，不触发测量、不访问数据库，可在任何时刻调用。
   * 可选能力：不提供测量的存储实现省略该方法，读取方据此不展示占用数据。
   */
  footprint?(): StorageFootprint | null;
}
