/**
 * 定义存储适配器的公共端口：同步事务、保存点、按分支 scope 的读写、分支复制与备份。
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

/** 列表查询选项：排序、条数与偏移。 */
export interface StorageListOptions {
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

/** 存储适配器端口：唯一写连接上的同步事务、分支复制与整库备份。 */
export interface StoragePort {
  /** 在 BEGIN IMMEDIATE 事务内同步执行；回调返回 Promise 时回滚并抛错。 */
  transact<T>(fn: (tx: StorageTransaction) => T): T;
  /** 在调用方事务内复制源分支的全部分支级数据并写入新 branches 行。 */
  forkBranch(tx: StorageTransaction, request: ForkBranchRequest): ForkBranchResult;
  /** 用 VACUUM INTO 生成整库一致副本；不能与事务并发执行。 */
  backup(options?: BackupOptions): BackupResult;
}
