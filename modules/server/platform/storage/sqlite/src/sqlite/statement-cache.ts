/**
 * 核心职责：为一条 SQLite 连接维护有上界的预编译语句缓存，供事务视图与表级读写共用。
 * 交互契约：由存储适配器在 openDatabase 之后构造并持有，调用方按 SQL 文本取语句；连接关闭前调用 clear()。
 * 约束与禁忌：达到条目上界时整体清空后重新装入，不做 LRU 或逐条淘汰；禁止跨连接共享实例、
 * 在连接关闭后继续使用，或把 SQL 文本以外的值当作缓存键。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * 缓存条目上界。真实 SQL 的重复分布未知，按容量取舍：256 条覆盖固定机制的跨分支查询与表级读写模板，
 * 按列表长度拼接占位符的动态 IN 查询只会让缓存整体重置一次，不会造成无界增长。
 */
export const STATEMENT_CACHE_LIMIT = 256;

/**
 * 单连接预编译语句缓存；实例与连接同生共死，语句复用跨越单次事务。
 * node:sqlite 每次执行都会重置语句状态，因此同一语句可在多个同步事务中重复执行。
 */
export class StatementCache {
  private readonly database: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  /** 取缓存中的语句；未命中时预编译并放入缓存。 */
  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    // 有界缓存而非 LRU：达到上界即整体清空再装入。逐条淘汰要维护访问顺序，
    // 而收益只体现在重复 SQL 上；这里用一次整体重置换取确定的内存上界与简单实现。
    if (this.statements.size >= STATEMENT_CACHE_LIMIT) {
      this.statements.clear();
    }
    const prepared = this.database.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** 当前缓存的语句条目数；用于生命周期与上界断言。 */
  get size(): number {
    return this.statements.size;
  }

  /** 清空缓存；存储适配器在关闭连接前调用，重复调用安全。 */
  clear(): void {
    this.statements.clear();
  }
}
