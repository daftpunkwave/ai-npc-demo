/**
 * 核心职责：宿主内的实验执行器：按启动顺序逐个驱动处于 running 的脚本化实验 run，经受控时钟走完脚本的外部命令
 * 与检查点探针，完成后汇总 `experiment_results`；响应停止、宿主关闭与重启恢复。
 * 交互契约：由组合根在 `POST /runs/{runId}/start` 成功后唤醒；停止由 run 状态表达，执行器在每个收敛轮与注入前读取；
 * 停止后再次启动由实验分支时钟版本区分，被取代的执行既不继续推进也不写终态；
 * 与在线世界共用存储写连接、游戏模块实例与部署级配额，每个 run 使用自己的命令网关、随机种子与 Agent 运行时。
 * 约束与禁忌：同一时刻只执行一个 run（配额与单写连接都按逐分支执行设计）；不读写在线分支；
 * 失败与积压显式落为 failed 并附原因码，不静默跳过检查点或伪造结果。
 */
import type { RunReportResponse } from "@world-prism/contracts";
import { settleWithin } from "./dispose";
import { openBranchAgentRuntime } from "./branch-agent-runtime";
import { recordExperimentAudit } from "./experiment-audit";
import {
  ExperimentFailure,
  prepareExperimentRun,
  type ExperimentHostDeps,
  type ExperimentRunRecord,
} from "./experiment-context";
import { closeSandbox, pendingProbesAt, runCheckpointProbes } from "./experiment-probes";
import {
  finishCompleted,
  finishFailed,
  finishHalted,
  finishSuperseded,
  isScriptedExperimentRun,
  readExperimentProgress,
  recoverInterruptedRuns,
  type ExperimentRunProgress,
  type HaltReason,
} from "./experiment-results";
import { nextStepTarget } from "./experiment-script";
import {
  activateExperimentRoster,
  advanceAndSettle,
  assertRunActive,
  controlClock,
  ensureCampaignStarted,
  readExecutionFence,
  RunHalted,
  settleCurrentTick,
  type ExperimentExecution,
} from "./experiment-ticks";

/** 一次执行的结局；终态写入按它分派。 */
type ExecutionOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "halted"; readonly reason: HaltReason; readonly message?: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

export class ExperimentRunner {
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private rewake = false;
  private executingRunId: string | null = null;

  constructor(private readonly deps: ExperimentHostDeps, private readonly worldId: string) {}

  /** 启动时调用：把上次进程遗留为 running 的实验 run 归位为 paused，并释放 paused run 未收尾的沙盒与激活。 */
  recoverInterrupted(): readonly string[] {
    return recoverInterruptedRuns(this.deps.core, this.worldId);
  }

  /** run 启动或恢复后调用；执行器空闲时开始按启动顺序执行，忙碌时在当前 run 结束后接着处理。 */
  wake(): void {
    if (this.abort.signal.aborted) return;
    if (this.loop !== null) {
      this.rewake = true;
      return;
    }
    this.loop = this.drainQueue()
      .catch((error: unknown) => {
        this.deps.core.host.logger.error("实验执行器循环异常", { message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.loop = null;
        if (this.rewake) {
          this.rewake = false;
          this.wake();
        }
      });
  }

  /** run 的执行进度；run 不存在或不属于本世界时为 null。 */
  progress(runId: string): ExperimentRunProgress | null {
    return readExperimentProgress(this.deps.core, this.worldId, runId, this.executingRunId === runId);
  }

  /** 停止接受新执行并在预算内结束当前执行；当前 run 改为 paused，重启后由研究员显式继续。 */
  async close(deadlineMs: number): Promise<void> {
    this.abort.abort();
    const loop = this.loop;
    if (loop === null) return;
    const outcome = await settleWithin(() => loop, deadlineMs);
    if (outcome === "timed-out") {
      this.deps.core.host.logger.warn("实验执行器未在关闭预算内结束", { deadlineMs: Math.max(0, deadlineMs) });
    }
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      this.rewake = false;
      if (this.abort.signal.aborted) return;
      const next = this.nextRun();
      if (next === null) return;
      this.executingRunId = next.runId;
      try {
        await this.execute(next);
      } finally {
        this.executingRunId = null;
      }
    }
  }

  /** 最早启动、仍为 running 的脚本化实验 run。 */
  private nextRun(): ExperimentRunRecord | null {
    return this.deps.core.storage.transact((tx) => {
      const candidates = tx.rows("runs").list({ world_id: this.worldId, status: "running" })
        .filter((run) => isScriptedExperimentRun(tx, run))
        .sort((left, right) => String(left["started_at"]).localeCompare(String(right["started_at"])) ||
          String(left["run_id"]).localeCompare(String(right["run_id"])));
      const run = candidates[0];
      if (run === undefined) return null;
      const runId = String(run["run_id"]);
      const branchId = String(run["branch_id"]);
      return {
        runId,
        worldId: this.worldId,
        branchId,
        runSpec: run["run_spec_json"],
        manifestHash: typeof run["manifest_hash"] === "string" ? run["manifest_hash"] : null,
        // 与选中时的 running 状态同一事务读取：这次执行只拥有这一版本起的时钟。
        clockVersion: readExecutionFence(tx, runId, branchId).clockVersion,
      };
    });
  }

  /** 执行一个 run 并落定终态；准备、驱动与收尾中的任何失败都落为该 run 的失败，不影响后续 run。 */
  private async execute(record: ExperimentRunRecord): Promise<void> {
    let execution: ExperimentExecution | null = null;
    let outcome: ExecutionOutcome;
    try {
      const ctx = await prepareExperimentRun(this.deps, record);
      execution = { deps: this.deps, ctx, signal: this.abort.signal, runtime: null, sandbox: null, clockVersion: record.clockVersion };
      await this.drive(execution);
      outcome = { kind: "completed" };
    } catch (error) {
      outcome = classify(error);
    }
    if (execution !== null) {
      try {
        await release(execution);
      } catch (error) {
        outcome = outcome.kind === "completed" ? classify(error) : outcome;
      }
    }
    this.finish(record, execution?.clockVersion ?? record.clockVersion, outcome);
  }

  /**
   * 驱动脚本：每一段从暂停进入 stepping，先补完当前 tick（恢复执行与开局后的 tick 0 都经这一步），
   * 当前 tick 有未作答探针时暂停并执行探针，否则逐 tick 推进到本段目标并在每个 tick 收敛后再前进。
   */
  private async drive(exec: ExperimentExecution): Promise<void> {
    const { ctx } = exec;
    const clock = this.deps.core.runtime.clock;
    const tickNow = (): number => clock.read(ctx.branchId).worldTick;
    // 准备阶段让出过事件循环：期间被停止或被再次启动取代时不再记开始。
    assertRunActive(exec);
    recordExperimentAudit(this.deps.core.storage, this.deps.core.host, {
      runId: ctx.runId, branchId: ctx.branchId, type: "ExperimentRunStarted", subjectId: null,
      payload: { worldTick: tickNow(), endTick: ctx.plan.endTick, scriptBranch: ctx.plan.branch },
    });
    controlClock(exec, "pause");
    ensureCampaignStarted(exec);
    activateExperimentRoster(exec);
    const runtime = await openBranchAgentRuntime({
      core: this.deps.core, reads: this.deps.reads, authority: ctx.authority, approvals: ctx.approvals,
      agents: ctx.agents, modules: ctx.modules, scope: { worldId: ctx.worldId, branchId: ctx.branchId },
      runId: ctx.runId, runSeed: ctx.runSpec.seed, onStateChange: () => undefined,
    });
    exec.runtime = runtime;
    for (;;) {
      assertRunActive(exec);
      const tick = tickNow();
      const target = nextStepTarget(ctx.plan, tick, ctx.maxStepTicks);
      controlClock(exec, "step", Math.max(1, target - tick));
      await settleCurrentTick(exec, runtime, tick);
      const probes = pendingProbesAt(exec, tick);
      if (probes.length > 0) {
        controlClock(exec, "pause");
        await runCheckpointProbes(exec, tick, probes);
        continue;
      }
      if (tick >= ctx.plan.endTick) {
        controlClock(exec, "pause");
        return;
      }
      for (let next = tick + 1; next <= target; next += 1) {
        await advanceAndSettle(exec, runtime, next);
      }
      controlClock(exec, "pause");
    }
  }

  /**
   * 落定终态。先按执行围栏判断这次执行是否已被「停止后再次启动」取代：被取代时只记审计，run 状态、名册与时钟
   * 都留给接手的执行，执行队列随后会按 running 再次选中该 run。整个收尾是同步的，围栏判断与终态写入之间
   * 不会插入新的控制请求。
   */
  private finish(record: ExperimentRunRecord, clockVersion: number | null, outcome: ExecutionOutcome): void {
    const { core } = this.deps;
    const input = { storage: core.storage, host: core.host, clock: core.runtime.clock, runId: record.runId, branchId: record.branchId };
    try {
      if (finishSuperseded({ ...input, clockVersion, outcome: outcome.kind === "failed" ? `failed:${outcome.code}` : outcome.kind })) return;
      if (outcome.kind === "completed") {
        let report: RunReportResponse | null;
        try {
          report = this.deps.report?.(record.runId) ?? null;
        } catch (error) {
          finishFailed({ ...input, code: "report-failed", message: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (report === null) {
          finishFailed({ ...input, code: "report-failed", message: "run 完成后评估报告读取不到该 run" });
        } else if (!finishCompleted({ ...input, report })) {
          finishHalted({ ...input, reason: "stopped" });
        }
      } else if (outcome.kind === "halted") {
        finishHalted({ ...input, reason: outcome.reason, ...(outcome.message === undefined ? {} : { message: outcome.message }) });
      } else {
        finishFailed({ ...input, code: outcome.code, message: outcome.message });
      }
    } catch (error) {
      core.host.logger.error("实验 run 终态写入失败", {
        runId: record.runId, message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 把执行中的异常归为停止、关闭、配额不足或带错误码的失败。 */
function classify(error: unknown): ExecutionOutcome {
  if (error instanceof RunHalted) return { kind: "halted", reason: error.reason };
  if (error instanceof ExperimentFailure && error.code === "quota-unavailable") {
    return { kind: "halted", reason: "quota-unavailable", message: error.message };
  }
  if (error instanceof ExperimentFailure) return { kind: "failed", code: error.code, message: error.message };
  return { kind: "failed", code: "execution-failed", message: error instanceof Error ? error.message : String(error) };
}

/** 释放一次执行持有的沙盒、实验分支运行时与 run 级模块；先停 turn 再释放模块。 */
async function release(exec: ExperimentExecution): Promise<void> {
  try {
    await closeSandbox(exec);
  } finally {
    try {
      await exec.runtime?.dispose();
      exec.runtime = null;
    } finally {
      await exec.ctx.modules.started.dispose();
    }
  }
}
