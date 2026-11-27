/**
 * 核心职责：落定实验 run 的终态：完成时把评估报告的指标写入 `experiment_results`，失败、停止或宿主关闭时
 * 如实记录原因；释放实验分支与遗留沙盒的配额；并提供启动时的中断恢复与控制台进度读取。
 * 交互契约：报告由评估读取端口按与 `/runs/{runId}/report` 相同的口径计算；状态变更、指标写入、名册休眠与审计
 * 在同一事务提交，执行器被停止时以 run 当前状态为准，不覆盖研究员的停止操作。
 * 约束与禁忌：只写 run、分支、`experiment_results` 与审计；不改写探针结果与世界状态，也不编造缺失的指标。
 */
import { deactivateBranchAgentsInTransaction, recordedProbeIds } from "@world-prism/agent-runtime";
import type { HostServices, Json, RunReportResponse, StoragePort, StorageTransaction } from "@world-prism/contracts";
import { runSpecSchema } from "@world-prism/experiment";
import type { GameClockPort } from "@world-prism/module-sdk";
import { latestExperimentAudit, recordExperimentAuditIn } from "./experiment-audit";
import { scriptExtent } from "./experiment-script";
import type { HostStartup } from "./startup-types";

/** 进度读取结果；字段与契约 `runProgressResponseSchema` 一致。 */
export interface ExperimentRunProgress {
  readonly runId: string;
  readonly status: string;
  readonly branchId: string;
  readonly executing: boolean;
  readonly worldTick: number | null;
  readonly endTick: number | null;
  readonly probes: { readonly recorded: number; readonly total: number };
  readonly lastEvent: { readonly type: string; readonly payload: Json; readonly createdAt: string } | null;
}

/** 终态写入共用的依赖。 */
interface FinishInput {
  readonly storage: StoragePort;
  readonly host: HostServices;
  readonly clock: GameClockPort;
  readonly runId: string;
  readonly branchId: string;
}

/** 把实验分支时钟停在暂停态；时钟行缺失（从未启动）时无需处理。 */
function pauseRunClock(input: FinishInput): void {
  const exists = input.storage.transact((tx) => tx.branch(input.branchId).table("clock").get({}) !== null);
  if (exists) input.clock.pause(input.branchId);
}

/** 读取 run 当前状态；不存在时为 null。 */
function runStatusIn(tx: StorageTransaction, runId: string): string | null {
  const status = tx.rows("runs").get({ run_id: runId })?.["status"];
  return typeof status === "string" ? status : null;
}

/**
 * run 完成：写入每项指标的分子分母，标记 completed 并释放名册配额。
 * 研究员在最后一步之后停止了 run 时状态已不是 running：此时不改写为 completed，返回 false 交给停止路径收尾。
 */
export function finishCompleted(input: FinishInput & { readonly report: RunReportResponse }): boolean {
  const { report } = input;
  const completed = input.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: input.runId });
    if (run === null || run["status"] !== "running") return false;
    const results = tx.rows("experiment_results");
    for (const metric of report.metrics) {
      results.put({
        run_id: input.runId,
        metric: metric.metric,
        value: metric.value,
        numerator: metric.numerator,
        denominator: metric.denominator,
        details_json: {
          ...(metric.reason === undefined ? {} : { reason: metric.reason }),
          variant: report.variant,
          scriptId: report.scriptId,
          scriptBranch: report.scriptBranch,
          validity: { ...report.validity, invalidReasons: [...report.validity.invalidReasons] },
          invalidProbeCounts: { ...report.invalidProbeCounts },
        },
      });
    }
    const endedAt = input.host.nowIso();
    tx.rows("runs").put({ ...run, status: "completed", ended_at: endedAt });
    deactivateBranchAgentsInTransaction(tx, input.branchId, endedAt);
    recordExperimentAuditIn(tx, input.host, {
      runId: input.runId, branchId: input.branchId, type: "ExperimentRunCompleted", subjectId: null,
      payload: { metrics: report.metrics.length, valid: report.validity.valid, invalidProbeCounts: { ...report.invalidProbeCounts } },
    });
    return true;
  });
  if (completed) pauseRunClock(input);
  return completed;
}

/** run 失败：仍在运行时标记 failed；无论状态如何都释放名册配额并记录原因码与说明。 */
export function finishFailed(input: FinishInput & { readonly code: string; readonly message: string }): void {
  input.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: input.runId });
    const endedAt = input.host.nowIso();
    if (run !== null && run["status"] === "running") tx.rows("runs").put({ ...run, status: "failed", ended_at: endedAt });
    deactivateBranchAgentsInTransaction(tx, input.branchId, endedAt);
    recordExperimentAuditIn(tx, input.host, {
      runId: input.runId, branchId: input.branchId, type: "ExperimentRunFailed", subjectId: null,
      payload: { code: input.code, message: input.message },
    });
  });
  pauseRunClock(input);
}

/**
 * run 被停止或宿主关闭：释放名册配额并暂停时钟。
 * 宿主关闭时 run 仍是 running，改为 paused：重启后不应在无人确认的情况下自动继续消耗模型预算，
 * 研究员重新调用启动接口即可从当前 tick 继续。
 */
export function finishHalted(input: FinishInput & { readonly reason: "stopped" | "interrupted" }): void {
  input.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: input.runId });
    if (input.reason === "interrupted" && run !== null && run["status"] === "running") {
      tx.rows("runs").put({ ...run, status: "paused" });
    }
    deactivateBranchAgentsInTransaction(tx, input.branchId, input.host.nowIso());
    recordExperimentAuditIn(tx, input.host, {
      runId: input.runId, branchId: input.branchId,
      type: input.reason === "stopped" ? "ExperimentRunStopped" : "ExperimentRunInterrupted", subjectId: null,
      payload: { status: runStatusIn(tx, input.runId) },
    });
  });
  pauseRunClock(input);
}

/** 实验 run 行是否由执行器驱动：闭环、带脚本、归属实验分支。 */
export function isScriptedExperimentRun(tx: StorageTransaction, run: Readonly<Record<string, unknown>>): boolean {
  if (run["mode"] !== "closed-loop") return false;
  const spec = runSpecSchema.safeParse(run["run_spec_json"]);
  if (!spec.success || spec.data.script === null) return false;
  return tx.rows("branches").get({ branch_id: String(run["branch_id"]) })?.["kind"] === "experiment";
}

/**
 * 启动时恢复上次进程遗留的执行：仍为 running 的实验 run 改为 paused，归档其未关闭的沙盒并释放配额。
 * 进程中断时内存里的执行状态已丢失，继续按 running 计会让 run 永远停在「运行中」而没有驱动者。
 */
export function recoverInterruptedRuns(core: HostStartup, worldId: string): readonly string[] {
  const { storage, host } = core;
  const interrupted = storage.transact((tx) => tx.rows("runs").list({ world_id: worldId, status: "running" })
    .filter((run) => isScriptedExperimentRun(tx, run))
    .map((run) => ({ runId: String(run["run_id"]), branchId: String(run["branch_id"]) })));
  for (const { runId, branchId } of interrupted) {
    storage.transact((tx) => {
      const branches = tx.rows("branches");
      for (const sandbox of branches.list({ parent_branch_id: branchId, kind: "sandbox", status: "active" })) {
        branches.put({ ...sandbox, status: "archived" });
        deactivateBranchAgentsInTransaction(tx, String(sandbox["branch_id"]), host.nowIso());
      }
    });
    finishHalted({ storage, host, clock: core.runtime.clock, runId, branchId, reason: "interrupted" });
  }
  return interrupted.map(({ runId }) => runId);
}

/** 读取 run 的执行进度；run 不存在或不属于本世界时为 null。 */
export function readExperimentProgress(
  core: HostStartup,
  worldId: string,
  runId: string,
  executing: boolean,
): ExperimentRunProgress | null {
  return core.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null || run["world_id"] !== worldId) return null;
    const branchId = String(run["branch_id"]);
    const spec = runSpecSchema.safeParse(run["run_spec_json"]);
    const script = spec.success && spec.data.script !== null ? core.content.index.scripts.get(spec.data.script.scriptRef) : undefined;
    const extent = script === undefined || !spec.success ? null : scriptExtent(script, spec.data.script?.branch ?? null);
    const hasClock = tx.branch(branchId).table("clock").get({}) !== null;
    return {
      runId,
      status: String(run["status"]),
      branchId,
      executing,
      worldTick: hasClock ? core.runtime.clock.readInTransaction(tx, branchId).worldTick : null,
      endTick: extent?.endTick ?? null,
      probes: { recorded: recordedProbeIds(tx, runId).size, total: extent?.probeCount ?? 0 },
      lastEvent: latestExperimentAudit(tx, branchId),
    };
  });
}
