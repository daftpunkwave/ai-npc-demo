/**
 * 为 turn 的各个阶段保存观测 span 与实际生效记录。
 * span 只包含状态、配置引用和证据 ID，原始输入与决定正文归 artifact。
 * 观测写入失败时保留运行证据不完整的标记。
 */
import type { AgentStageEffective, HostServices, Json, StoragePort } from "@ai-npc/contracts";
import { arrayValue } from "./runtime-records";
import { TurnStopped, type ClaimedTurn } from "./turn-lease";

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
  private readonly traceId: string;

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
        effective: null,
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
        const turns = tx.rows("turn_runs");
        const row = turns.get({ turn_id: auth.turnId });
        if (row?.["turn_lease_epoch"] !== auth.turnLeaseEpoch) return;
        turns.put({ ...row, effective_json: [...arrayValue(row["effective_json"]), entry as unknown as Json] });
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
