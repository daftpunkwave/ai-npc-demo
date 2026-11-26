/**
 * 提供仅在生命周期审计 SQL 写入时抛错的存储包装，用于注入审计写入失败。
 * 依赖真实 StoragePort 透传其余读写与备份；不改变表结构或事务语义。
 * 禁止用该包装模拟审计路径之外的故障，或在包装内吞掉错误。
 */
import type { StoragePort, StorageTransaction } from "@world-prism/contracts";

/**
 * 包装存储端口：事务内 tx.run 命中 lifecycle_events 表时抛出指定错误，
 * 其余 SQL、分支复制与整库备份原样透传，事务回滚语义由底层适配器保证。
 */
export function storageFailingOnLifecycleAudit(inner: StoragePort, message: string): StoragePort {
  return {
    transact: (fn) => inner.transact((tx) => fn(delegateTransaction(tx, message))),
    forkBranch: (tx, request) => inner.forkBranch(tx, request),
    backup: (options) => inner.backup(options),
  };
}

/** 逐方法委托存储事务视图；仅拦截写入 lifecycle_events 的 INSERT。 */
function delegateTransaction(tx: StorageTransaction, message: string): StorageTransaction {
  return {
    get: (sql, params) => tx.get(sql, params),
    all: (sql, params) => tx.all(sql, params),
    run: (sql, params) => {
      if (sql.includes("lifecycle_events")) {
        throw new Error(message);
      }
      return tx.run(sql, params);
    },
    rows: (table) => tx.rows(table),
    branch: (branchId) => tx.branch(branchId),
    savepoint: (name, fn) => tx.savepoint(name, fn),
  };
}
