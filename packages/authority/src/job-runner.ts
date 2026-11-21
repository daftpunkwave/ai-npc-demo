/**
 * 按 (dueTick, seq) 执行到期的规则 job，并在每个 job 的独立事务内提交状态、事件与完成标记。
 * 依赖存储事务、job 注册表、系统认证与 WorldTx；job 处理器必须同步且不等待外部 I/O。
 * 禁止重复执行已完成 job、跳过幂等键、在分支冻结后继续推进，或吞掉 handler 异常只标完成；
 * 处理器失败时回滚事务、记录尝试次数与最后错误，达到上限后标记 failed 并继续后续 job。
 */
import { DomainError, type StorageTransaction } from "@ai-npc/contracts";
import { readBranch, readClock } from "./branch-state";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
import {
  MAX_RULE_ATTEMPTS,
  RuleExecutionError,
  clearRuleFailure,
  failureMessage,
  writeRuleFailure,
} from "./rule-failures";
import { requireStorageNumber, requireStorageString, readJsonCell } from "./storage-values";
import { createSystemAuth, systemPrincipalId } from "./system-auth";
import type { RuleRuntime, DueJob } from "./types";
import { assertSynchronous, TransactionWorldTx } from "./world-tx";
import type { RuleRegistry } from "./rule-registry";

/** job 单次 runDue 的防护上限，避免同一个 handler 无限自我调度。 */
const maxJobsPerRun = 1000;

/** JobRunner 依赖：与命令网关共享 registry 和宿主端口。 */
export interface JobRunnerOptions extends RuleRuntime {
  readonly registry: RuleRegistry;
}

/** 到期 job 执行器；一个 job 一个事务，handler 成功后标记 done。 */
export class JobRunner {
  private readonly storage: RuleRuntime["storage"];
  private readonly host: RuleRuntime["host"];
  private readonly registry: RuleRegistry;
  private readonly modules: unknown;
  private readonly content: unknown;
  private readonly approvedSpeech: RuleRuntime["approvedSpeech"];
  private readonly moduleBinder: RuleRuntime["moduleBinder"];
  private readonly runSeed: RuleRuntime["runSeed"];

  constructor(options: JobRunnerOptions) {
    this.storage = options.storage;
    this.host = options.host;
    this.registry = options.registry;
    this.modules = options.modules;
    this.content = options.content;
    this.approvedSpeech = options.approvedSpeech;
    this.moduleBinder = options.moduleBinder;
    this.runSeed = options.runSeed;
  }

  /** 执行所有 due_tick 不大于 tick 的 scheduled job，返回实际结算条数。 */
  runDue(branchId: string, tick: number): number {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new DomainError("validation", "job 推进 tick 必须是非负安全整数", { details: { tick } });
    }
    let executed = 0;
    for (;;) {
      let hasWork: boolean;
      try {
        hasWork = this.storage.transact((tx) => this.executeNext(tx, branchId, tick));
      } catch (error) {
        if (!(error instanceof RuleExecutionError)) {
          throw error;
        }
        // 处理器失败时事务已回滚；单独提交尝试次数与最后错误，达到上限后隔离该 job。
        if (!this.recordFailure(branchId, error)) {
          throw error.cause ?? error;
        }
        executed += 1;
        if (executed > maxJobsPerRun) {
          throw new DomainError("invalid-state", "单次 job 推进超过安全上限，可能存在自我调度循环", {
            details: { branchId, tick, maxJobsPerRun },
          });
        }
        continue;
      }
      if (!hasWork) {
        break;
      }
      executed += 1;
      if (executed > maxJobsPerRun) {
        throw new DomainError("invalid-state", "单次 job 推进超过安全上限，可能存在自我调度循环", {
          details: { branchId, tick, maxJobsPerRun },
        });
      }
    }
    return executed;
  }

  /**
   * 记录一次 job 处理器失败并判断是否达到死信上限。
   * 返回 false 表示仍可重试，由 runDue 把原始错误交给宿主停止推进。
   */
  private recordFailure(branchId: string, error: RuleExecutionError): boolean {
    return this.storage.transact((tx) => {
      const jobsTable = tx.branch(branchId).table("jobs");
      const row = jobsTable.get({ job_id: error.subjectId });
      if (row === null) {
        throw new DomainError("invalid-state", `失败 job ${error.subjectId} 在事务回滚后不存在`, {
          details: { jobId: error.subjectId },
        });
      }
      const attempts = requireStorageNumber(row, "jobs", "attempts") + 1;
      const deadLettered = attempts >= MAX_RULE_ATTEMPTS;
      writeRuleFailure(
        tx,
        branchId,
        { phase: "job", subjectId: error.subjectId, detail: "" },
        { attempts, error: error.cause, deadLettered, nowIso: this.host.nowIso() },
      );
      jobsTable.put({
        ...row,
        status: deadLettered ? "failed" : "scheduled",
        attempts,
        last_error: failureMessage(error.cause),
      });
      return deadLettered;
    });
  }

  private executeNext(tx: StorageTransaction, branchId: string, tick: number): boolean {
    const branch = readBranch(tx, branchId);
    if (branch === null) {
      throw new DomainError("not-found", `分支 ${branchId} 不存在`, { details: { branchId } });
    }
    if (branch.status !== "active" && branch.status !== "paused") {
      throw new DomainError("forbidden", `分支 ${branchId} 当前状态不接受 job 推进`, {
        details: { branchId, status: branch.status },
      });
    }
    const clock = readClock(tx, branchId);
    if (tick > clock.worldTick) {
      throw new DomainError("invalid-state", "job 推进 tick 不能超过分支当前 worldTick", {
        details: { branchId, tick, worldTick: clock.worldTick },
      });
    }
    const jobsTable = tx.branch(branchId).table("jobs");
    // 迁移 0003 的 jobs_status_due_seq 按 (branch_id, status, due_tick, seq) 排序；
    // 每次只取最早一条候选，避免按 job 数重复读取并排序全部 scheduled 行。
    const scheduled = jobsTable.list(
      { status: "scheduled" },
      { orderBy: [{ column: "due_tick" }, { column: "seq" }], limit: 1 },
    );
    const row = scheduled[0];
    if (row === undefined) {
      return false;
    }
    // 最早候选仍晚于本次 tick 时，其余 scheduled job 都未到期。
    if (requireStorageNumber(row, "jobs", "due_tick") > tick) {
      return false;
    }
    const jobId = requireStorageString(row, "jobs", "job_id");
    const kind = requireStorageString(row, "jobs", "kind");
    const registration = this.registry.job(kind);
    if (registration === undefined) {
      throw new DomainError("module-missing", `job 类型 ${kind} 尚未注册处理器`, {
        details: { kind, jobId },
      });
    }
    const dueJob: DueJob = {
      jobId,
      kind,
      dueTick: requireStorageNumber(row, "jobs", "due_tick"),
      seq: requireStorageNumber(row, "jobs", "seq"),
      idempotencyKey: requireStorageString(row, "jobs", "idempotency_key"),
      payload: readJsonCell(row["payload_json"], "jobs", "payload_json"),
    };
    const worldTx = new TransactionWorldTx({
      storageTx: tx,
      worldId: branch.worldId,
      branchId,
      worldTick: clock.worldTick,
      principalId: systemPrincipalId,
      correlationId: `job:${jobId}`,
      scope: registration.owner,
      host: this.host,
    });
    const context = createHandlerContext({
      auth: createSystemAuth(branch.worldId, branchId),
      tx: worldTx,
      modules: bindModulePorts({
        binder: this.moduleBinder,
        fallback: this.modules,
        registry: this.registry,
        storageTx: tx,
        worldId: branch.worldId,
        branchId,
        worldTick: clock.worldTick,
        principalId: systemPrincipalId,
        correlationId: `job:${jobId}`,
        host: this.host,
      }),
      content: this.content,
      approvedSpeech: this.approvedSpeech,
      host: this.host,
      runSeed: this.runSeed,
    });
    try {
      const outcome = registration.handler(context, dueJob);
      assertSynchronous(outcome, `job ${kind} 处理器`);
    } catch (error) {
      throw new RuleExecutionError("job", jobId, "", error);
    }
    jobsTable.put({
      ...row,
      status: "done",
      attempts: requireStorageNumber(row, "jobs", "attempts") + 1,
      last_error: null,
    });
    clearRuleFailure(tx, branchId, { phase: "job", subjectId: jobId, detail: "" });
    return true;
  }
}
