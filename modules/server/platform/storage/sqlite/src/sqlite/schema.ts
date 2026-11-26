/**
 * 从初始迁移推导存储表目录：表清单、主键列、JSON 列与分支级表清单，并在打开时校验二者一致。
 * 依赖 node:sqlite 的 PRAGMA 查询与公共契约的领域错误；不缓存跨库实例状态、不执行写操作。
 * 禁止用猜测的表清单替代迁移推导，也禁止把未登记的运行级表当作分支级表复制。
 */
import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "@world-prism/contracts";

/**
 * 分支级表清单与复制顺序：迁移之后新增分支级表时，必须同步更新本清单，
 * 打开时的校验会比对“主键包含 branch_id 的表”并拒绝遗漏或多余项。
 */
export const BRANCH_TABLES = [
  "clock",
  "aggregate_state",
  "domain_events",
  "command_receipts",
  "speech_commits",
  "jobs",
  "rule_failures",
  "clock_stop_requests",
  "consumer_offsets",
  "consumer_inbox",
  "agent_activations",
  "controller_leases",
  "observations",
  "perception_state",
  "memory_records",
  "memory_revisions",
  "memory_watermarks",
  "triggers",
  "operations",
] as const;

export type BranchTableName = (typeof BRANCH_TABLES)[number];

const BRANCH_TABLE_NAME_SET: ReadonlySet<string> = new Set(BRANCH_TABLES);

/**
 * 部署级表 branches 的主键列也叫 branch_id，但它登记分支本身而不是分支内数据；
 * 推导分支级表清单时必须排除，否则会把分支注册表当成可复制的分支数据。
 */
const REGISTRY_TABLES_WITH_BRANCH_KEY: ReadonlySet<string> = new Set(["branches"]);

/** 标识分支归属的列名；分支级表的第一主键列。 */
export const BRANCH_COLUMN = "branch_id";

/**
 * 运营操作幂等表：部署级表，按世界、认证主体与 operationId 保存首次结果。
 * 不含 branch_id，不参与分支复制；打开时校验迁移已创建该表，避免代码与表结构漂移。
 */
export const OPERATION_IDEMPOTENCY_TABLE = "operation_idempotency";

/** JSON 列的命名约定：迁移中以 _json 结尾的 TEXT 列存规范 JSON。 */
const JSON_COLUMN_SUFFIX = "_json";

/** 单列信息：名称、声明类型与主键序号（0 表示非主键）。 */
export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly primaryKeyIndex: number;
}

/** 单表信息：列、主键顺序、JSON 列与是否含 branch_id 列。 */
export interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  readonly primaryKey: readonly string[];
  readonly jsonColumns: ReadonlySet<string>;
  readonly hasBranchColumn: boolean;
}

/** 存储目录：全部表信息与分支级表清单。 */
export interface StorageCatalog {
  readonly tables: ReadonlyMap<string, TableInfo>;
  readonly branchTables: readonly TableInfo[];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function listTableNames(database: DatabaseSync): readonly string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return rows.map((row) => String(row["name"]));
}

function readTableInfo(database: DatabaseSync, name: string): TableInfo {
  const columnRows = database
    .prepare("SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid")
    .all(name);
  if (columnRows.length === 0) {
    throw new DomainError("invalid-state", `存储迁移缺少表 ${name} 的列信息`, {
      details: { table: name },
    });
  }
  const columns: ColumnInfo[] = columnRows.map((row) => ({
    name: String(row["name"]),
    type: String(row["type"]),
    primaryKeyIndex: Number(row["pk"]),
  }));
  const primaryKey = columns
    .filter((column) => column.primaryKeyIndex > 0)
    .sort((left, right) => left.primaryKeyIndex - right.primaryKeyIndex)
    .map((column) => column.name);
  if (primaryKey.length === 0) {
    throw new DomainError("invalid-state", `存储表 ${name} 没有主键，无法提供按主键读写`, {
      details: { table: name },
    });
  }
  return {
    name,
    columns,
    primaryKey,
    jsonColumns: new Set(
      columns.filter((column) => column.name.endsWith(JSON_COLUMN_SUFFIX)).map((column) => column.name),
    ),
    hasBranchColumn: columns.some((column) => column.name === BRANCH_COLUMN),
  };
}

function branchTableNamesOf(tables: readonly TableInfo[]): readonly string[] {
  return tables
    .filter(
      (table) =>
        table.primaryKey.includes(BRANCH_COLUMN) && !REGISTRY_TABLES_WITH_BRANCH_KEY.has(table.name),
    )
    .map((table) => table.name)
    .sort();
}

function assertBranchTableList(expected: readonly string[], actual: readonly string[]): void {
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }
  throw new DomainError("invalid-state", "分支级表清单与迁移不一致，分支复制可能遗漏或误拷数据", {
    details: { missing, unexpected },
  });
}

/** 读取全部表信息并校验分支级表清单；迁移变化导致清单漂移时启动失败。 */
export function resolveCatalog(database: DatabaseSync): StorageCatalog {
  const names = listTableNames(database);
  if (names.length === 0) {
    throw new DomainError("invalid-state", "存储迁移没有创建任何表");
  }
  const tables = new Map<string, TableInfo>();
  for (const name of names) {
    tables.set(name, readTableInfo(database, name));
  }
  const branchTables = BRANCH_TABLES.map((name) => {
    const table = tables.get(name);
    if (table === undefined) {
      throw new DomainError("invalid-state", `分支级表 ${name} 在迁移中不存在`, {
        details: { table: name },
      });
    }
    if (table.primaryKey[0] !== BRANCH_COLUMN) {
      throw new DomainError("invalid-state", `分支级表 ${name} 的首个主键列必须是 ${BRANCH_COLUMN}`, {
        details: { table: name },
      });
    }
    return table;
  });
  assertBranchTableList(BRANCH_TABLES, branchTableNamesOf([...tables.values()]));
  const idempotency = tables.get(OPERATION_IDEMPOTENCY_TABLE);
  if (idempotency === undefined || idempotency.hasBranchColumn) {
    throw new DomainError("invalid-state", "存储迁移缺少部署级运营幂等表或误将其登记为分支级表", {
      details: { table: OPERATION_IDEMPOTENCY_TABLE },
    });
  }
  return { tables, branchTables };
}

/** 取分支级表信息；调用方只能经 scoped 分支接口访问。 */
export function requireBranchTable(catalog: StorageCatalog, name: string): TableInfo {
  const table = catalog.tables.get(name);
  if (table === undefined) {
    throw new DomainError("validation", `未知存储表 ${name}`, { details: { table: name } });
  }
  if (!BRANCH_TABLE_NAME_SET.has(name)) {
    throw new DomainError("validation", `表 ${name} 不是分支级表，不能经分支 scope 访问`, {
      details: { table: name },
    });
  }
  return table;
}

/** 取部署级或运行级表信息；分支级表必须经 scoped 分支接口访问。 */
export function requireUnscopedTable(catalog: StorageCatalog, name: string): TableInfo {
  const table = catalog.tables.get(name);
  if (table === undefined) {
    throw new DomainError("validation", `未知存储表 ${name}`, { details: { table: name } });
  }
  if (BRANCH_TABLE_NAME_SET.has(name)) {
    throw new DomainError("validation", `表 ${name} 是分支级表，必须经 branch(branchId) 访问`, {
      details: { table: name },
    });
  }
  return table;
}

/** 生成带标识符引用的安全 SQL 片段；标识符只能来自迁移目录。 */
export function quoteSqlIdentifier(identifier: string): string {
  return quoteIdentifier(identifier);
}
