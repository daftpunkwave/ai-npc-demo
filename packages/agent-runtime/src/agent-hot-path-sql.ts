/**
 * 核心职责：集中 Agent 热路径的 SQL 文本，让生产调用与查询计划测试共用同一份语句。
 * 交互契约：只导出 SQL 字符串常量与状态词列表；不持有存储、不执行查询。
 * 约束与禁忌：状态词必须内联成字面量而不是绑定参数——SQLite 只有看到字面量才肯为
 *   部分索引判定谓词成立，绑定参数会让优化器退回全量索引；这些常量也不得承载外部输入。
 */
import { activeTurnStatuses } from "./turn-lease";

/** 内联进 SQL 的非终态字面量列表；值全部来自 activeTurnStatuses 常量。 */
export const activeTurnStatusesSql: string = activeTurnStatuses.map((status) => `'${status}'`).join(", ");

/**
 * 取消活跃 turn 的查询；状态词与 turn_runs_active 部分索引的谓词一致。
 * 导出给集成测试，让查询计划断言直接跑生产语句，而不是另写一份等价的字面量副本。
 */
export const cancelActiveTurnsSql = `SELECT * FROM turn_runs WHERE branch_id = ? AND status IN (${activeTurnStatusesSql})`;

/** 恢复过期租约的查询；状态词同样内联，否则部分索引不会被采用。 */
export const recoverExpiredTurnsSql = `SELECT * FROM turn_runs
          WHERE branch_id = ? AND status IN (${activeTurnStatusesSql}) AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`;

/** 调度器读取未消费触发的查询；过滤条件与 triggers_pending 部分索引一致。 */
export const pendingTriggersSql = "SELECT * FROM triggers WHERE branch_id = ? AND consumed_by_turn_id IS NULL ORDER BY rowid";

/** 取最近一次 DayPassed 观察；过滤与排序与 observations_day_passed 表达式部分索引一致。 */
export const latestDayPassedSql = `SELECT known_at_tick, observation_seq FROM observations
          WHERE branch_id = ? AND agent_id = ?
            AND json_extract(content_json, '$.eventType') = 'DayPassed'
          ORDER BY known_at_tick DESC, observation_seq DESC
          LIMIT 1`;
