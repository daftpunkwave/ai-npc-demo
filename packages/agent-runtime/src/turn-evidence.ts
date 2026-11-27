/**
 * 为 turn 的各个阶段保存观测 span 与实际生效记录。
 * span 只包含状态、配置引用和证据 ID，原始输入与决定正文归 artifact；生效记录以单条 SQL 追加到 turn_runs.effective_json。
 * 观测写入失败时保留运行证据不完整的标记。
 */
import { canonicalJson, type AgentStageEffective, type HostServices, type Json, type StoragePort } from "@world-prism/contracts";
import { TurnStopped, type ClaimedTurn } from "./turn-lease";

/**
 * 把一条阶段记录接到 effective_json 数组末尾：由 SQLite 在语句内追加，不把整行读出再整行改写，
 * 第 N 个阶段不再重新序列化前 N-1 条记录。WHERE 条件即租约校验：turn 不存在或租约代次已变化时不写入。
 * effective_json 为 NULL 或不是数组时从空数组起算。
 */
const appendStageEffectiveSql = `UPDATE turn_runs
   SET effective_json = json_insert(
     CASE WHEN json_type(effective_json) = 'array' THEN effective_json ELSE '[]' END,
     '$[#]', json(?))
 WHERE turn_id = ? AND turn_lease_epoch = ?`;

/**
 * turn 阶段经注入的 recordSpan 写入观测的 span 声明：runId、branchId、agentId、turnId 与
 * endMs 非空，parentSpanId、moduleId 与 moduleVersion 允许为空；
 * 与 SDK 的 RunSpan 是结构对齐的独立声明，宿主把它映射到同一 trace_spans 写入边界。
 */
export interface TurnSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly runId: string;
  readonly branchId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly moduleId: string | null;
  readonly moduleVersion: string | null;
  readonly name: string;
  readonly status: "ok" | "error" | "skipped";
  readonly startMs: number;
  readonly endMs: number;
  readonly attrs: Json;
}

export interface StageOutcome {
  readonly status: AgentStageEffective["status"];
  readonly reason: string | null;
  readonly effective: Json;
}

export interface StageSelection {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly config: Json;
}

export class TurnEvidence {
  readonly traceId: string;

  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
    private readonly turn: ClaimedTurn,
    private readonly recordSpan: (span: TurnSpan) => void,
  ) {
    this.traceId = host.ids("trc");
  }

  start(): number {
    return this.host.monotonicMs();
  }

  async stage<T>(
    name: string,
    work: () => T | Promise<T>,
    outcome: (result: T) => StageOutcome = () => ({ status: "applied", reason: null, effective: null }),
    selection: StageSelection | null = null,
  ): Promise<T> {
    const start = this.start();
    let result: T;
    try {
      result = await work();
    } catch (error) {
      this.record(name, start, {
        status: "failed",
        reason: error instanceof TurnStopped ? error.reason : "stage-error",
        effective: error instanceof TurnStopped ? error.effective : null,
      }, selection);
      throw error;
    }
    this.record(name, start, outcome(result), selection);
    return result;
  }

  record(name: string, startMs: number, outcome: StageOutcome, selection: StageSelection | null = null): void {
    const { auth, runId } = this.turn;
    const spanId = this.host.ids("spn") as AgentStageEffective["spanId"];
    const entry: AgentStageEffective = {
      stage: name,
      spanId,
      requested: selection === null ? null : selection.moduleId,
      resolved: selection === null ? null : { ...selection },
      ...outcome,
    };
    try {
      this.recordSpan({
        spanId, traceId: this.traceId, parentSpanId: null,
        runId, branchId: auth.branchId, agentId: auth.principalId, turnId: auth.turnId,
        moduleId: selection?.moduleId ?? null, moduleVersion: selection?.moduleVersion ?? null,
        name, status: outcome.status === "applied" ? "ok" : outcome.status === "failed" ? "error" : "skipped",
        startMs, endMs: this.host.monotonicMs(), attrs: entry as unknown as Json,
      });
      this.storage.transact((tx) => {
        tx.run(appendStageEffectiveSql, [canonicalJson(entry as unknown as Json), auth.turnId, auth.turnLeaseEpoch]);
      });
    } catch (error) {
      this.storage.transact((tx) => {
        const runs = tx.rows("runs");
        const run = runs.get({ run_id: runId });
        if (run !== null) runs.put({ ...run, evidence_complete: 0 });
      });
      throw new Error(`Could not record Agent turn stage "${name}"`, { cause: error });
    }
  }
}
