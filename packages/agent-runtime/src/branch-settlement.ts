/**
 * 核心职责：读出受控推进判定「本 tick 已收敛」所需的分支读数：未终结 turn、turn 总数、感知待扫事件、
 *   未摄入观察的 Agent 与当前 tick 仍待完成的记忆整理。
 * 交互契约：在调用方事务内按分支读取 agent-runtime 拥有的表；感知前沿与领域事件序号比较，
 *   整理任务的可认领判据与整理队列共用同一实现。
 * 约束与禁忌：只读；不认领任务、不调度 turn，也不替调用方决定是否收敛。
 */
import type { StorageTransaction } from "@world-prism/contracts";
import { activeTurnStatusesSql } from "./agent-hot-path-sql";
import { perceptionConsumerId } from "./event-consumer";
import { claimableMaintenanceRows } from "./memory-maintenance-queue";
import { countCell } from "./runtime-query-cells";

/** 一次读数；调用方比较前后两次读数判断本轮是否仍有进展。 */
export interface BranchSettlement {
  /** 未到终态的 turn 数。 */
  readonly activeTurns: number;
  /** 分支内已创建的 turn 总数；与上一轮相比增加说明调度器又建了 turn。 */
  readonly turnCount: number;
  /** 感知消费者尚未扫描的领域事件数。 */
  readonly unperceivedEvents: number;
  /** 观察尚未全部被记忆摄入的 Agent 数。 */
  readonly agentsBehindIngestion: number;
  /** 当前 tick 仍待完成的整理任务：可认领的到期任务，加上租约未过期的进行中任务。 */
  readonly pendingMaintenance: number;
}

/**
 * 读取分支收敛读数。
 * 整理任务只计「此刻能推进或正在推进」的行：等待重排点或配额的任务属于后续 tick，
 * 失败次数耗尽的任务已是终态，二者都不阻塞本 tick；失败由 turn 的就绪判定显式暴露。
 */
export function readBranchSettlement(
  tx: StorageTransaction,
  input: { readonly branchId: string; readonly worldTick: number; readonly nowMs: number },
): BranchSettlement {
  const { branchId, worldTick, nowMs } = input;
  const counts = tx.get(
    `SELECT
       (SELECT COUNT(*) FROM turn_runs WHERE branch_id = ? AND status IN (${activeTurnStatusesSql})) AS active_turns,
       (SELECT COUNT(*) FROM turn_runs WHERE branch_id = ?) AS turn_count,
       COALESCE((SELECT MAX(world_seq) FROM domain_events WHERE branch_id = ?), 0) -
         COALESCE((SELECT last_world_seq FROM consumer_offsets WHERE branch_id = ? AND consumer_id = ?), 0) AS unperceived,
       (SELECT COUNT(*) FROM (
          SELECT agent_id, MAX(observation_seq) AS top FROM observations WHERE branch_id = ? GROUP BY agent_id
        ) AS o
        LEFT JOIN memory_watermarks AS w ON w.branch_id = ? AND w.agent_id = o.agent_id
        WHERE COALESCE(w.observation_seq_consumed, 0) < o.top) AS behind`,
    [branchId, branchId, branchId, branchId, perceptionConsumerId, branchId, branchId],
  );
  if (counts === null) throw new Error("分支收敛读数缺失");
  const inProgress = tx.rows("maintenance_runs").list({ branch_id: branchId, status: "leased" }).filter((row) => {
    const expires = row["lease_expires_at"];
    return typeof expires === "string" && Date.parse(expires) > nowMs && Number(row["due_tick"]) <= worldTick;
  }).length;
  return {
    activeTurns: countCell(counts, "turn_runs", "active_turns"),
    turnCount: countCell(counts, "turn_runs", "turn_count"),
    unperceivedEvents: Math.max(0, Number(counts["unperceived"])),
    agentsBehindIngestion: countCell(counts, "observations", "behind"),
    pendingMaintenance: claimableMaintenanceRows(tx, branchId, worldTick, nowMs).length + inProgress,
  };
}
