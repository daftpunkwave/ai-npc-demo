/**
 * 按 (dueTick, seq) 执行到期的规则 job，并在每个 job 的独立事务内提交状态、事件与完成标记。
 * 依赖存储事务、job 注册表、系统认证与 WorldTx；job 处理器必须同步且不等待外部 I/O。
 * 禁止重复执行已完成 job、跳过幂等键、在分支冻结后继续推进，或吞掉 handler 异常只标完成。
 */
import { DomainError, type StorageTransaction } from "@ai-npc/contracts";
import { readBranch, readClock } from "./branch-state";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
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

  constructor(options: JobRunnerOptions) {
    this.storage = options.storage;
    this.host = options.host;
    this.registry = options.registry;
    this.modules = options.modules;
    this.content = options.content;
    this.approvedSpeech = options.approvedSpeech;
    this.moduleBinder = options.moduleBinder;
  }

  /** 执行所有 due_tick 不大于 tick 的 scheduled job，返回实际执行条数。 */
  runDue(branchId: string, tick: number): number {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new DomainError("validation", "job 推进 tick 必须是非负安全整数", { details: { tick } });
    }
    let executed = 0;
    while (this.storage.transact((tx) => this.executeNext(tx, branchId, tick))) {
      executed += 1;
      if (executed > maxJobsPerRun) {
        throw new DomainError("invalid-state", "单次 job 推进超过安全上限，可能存在自我调度循环", {
          details: { branchId, tick, maxJobsPerRun },
        });
      }
    }
    return executed;
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
    const scheduled = jobsTable.list(
      { status: "scheduled" },
      { orderBy: [{ column: "due_tick" }, { column: "seq" }] },
    );
    const row = scheduled.find((candidate) => {
      const dueTick = requireStorageNumber(candidate, "jobs", "due_tick");
      return dueTick <= tick;
    });
    if (row === undefined) {
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
    });
    const outcome = registration.handler(context, dueJob);
    assertSynchronous(outcome, `job ${kind} 处理器`);
    jobsTable.put({
      ...row,
      status: "done",
      attempts: requireStorageNumber(row, "jobs", "attempts") + 1,
    });
    return true;
  }
}
