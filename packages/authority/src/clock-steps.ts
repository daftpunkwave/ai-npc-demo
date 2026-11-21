/**
 * 在分支当前 tick 上运行已注册的时钟步骤，每个命中步骤在各自事务内按注册顺序提交。
 * 依赖存储事务、时钟步骤注册、系统认证与 WorldTx；每日结算与章节评估由 world 模块自行注册。
 * 禁止在时钟外另起定时器、跳过未注册步骤，或把同一 tick 的多个步骤合并进一个事务；
 * 步骤处理器失败时回滚步骤事务，达到重试上限后记录死信并在本 tick 跳过该步骤；持久时钟停止点由步骤在自身事务内登记，宿主据此补做暂停并拒绝越过终局推进。
 */
import { DomainError, type StorageTransaction } from "@ai-npc/contracts";
import { readBranch, readClock, type BranchRecord } from "./branch-state";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
import type { RuleRegistry } from "./rule-registry";
import {
  RuleExecutionError,
  clearRuleFailure,
  readRuleFailure,
  recordRuleAttempt,
  type RuleFailureIdentity,
} from "./rule-failures";
import { createSystemAuth, systemPrincipalId } from "./system-auth";
import type { RuleRuntime, StoredClockStep } from "./types";
import { assertSynchronous, TransactionWorldTx } from "./world-tx";

/** 时钟步骤执行器依赖。 */
export interface ClockStepRunnerOptions extends RuleRuntime {
  readonly registry: RuleRegistry;
}

/** 时钟步骤执行结果：执行条数与此轮是否有步骤请求停止时钟。 */
export interface ClockStepRunResult {
  readonly executed: number;
  readonly stopRequested: boolean;
}

/** 步骤处理器可返回 { stopClock: true } 请求宿主在本次 tick 收尾后暂停时钟。 */
function requestsClockStop(outcome: unknown): boolean {
  return typeof outcome === "object" && outcome !== null && "stopClock" in outcome && outcome.stopClock === true;
}

/** 时钟步骤执行器；读取分支时钟，按注册顺序逐事务执行命中步骤。 */
export class ClockStepRunner {
  private readonly storage: RuleRuntime["storage"];
  private readonly host: RuleRuntime["host"];
  private readonly registry: RuleRegistry;
  private readonly modules: unknown;
  private readonly content: unknown;
  private readonly approvedSpeech: RuleRuntime["approvedSpeech"];
  private readonly moduleBinder: RuleRuntime["moduleBinder"];
  private readonly runSeed: RuleRuntime["runSeed"];

  constructor(options: ClockStepRunnerOptions) {
    this.storage = options.storage;
    this.host = options.host;
    this.registry = options.registry;
    this.modules = options.modules;
    this.content = options.content;
    this.approvedSpeech = options.approvedSpeech;
    this.moduleBinder = options.moduleBinder;
    this.runSeed = options.runSeed;
  }

  /** 在分支当前 worldTick 上执行全部命中步骤，每个步骤一个事务；返回执行条数。 */
  run(branchId: string): number {
    return this.runDetailed(branchId).executed;
  }

  /** 读取分支是否登记了持久时钟停止点；宿主据此拒绝继续推进或恢复。 */
  pendingStop(branchId: string): boolean {
    return this.storage.transact(
      (tx) => tx.branch(branchId).table("clock_stop_requests").count() > 0,
    );
  }

  /** 与 run 相同，但额外返回是否有步骤请求停止时钟，供 tick 收尾后暂停。 */
  runDetailed(branchId: string): ClockStepRunResult {
    const worldTick = this.storage.transact((tx) => {
      this.requireWritableBranch(tx, branchId);
      return readClock(tx, branchId).worldTick;
    });
    let stopRequested = false;
    let executed = 0;
    for (const step of this.registry.clockStepList()) {
      const identity: RuleFailureIdentity = {
        phase: "clock-step",
        subjectId: step.stepId,
        detail: String(worldTick),
      };
      const previous = this.storage.transact((tx) => readRuleFailure(tx, branchId, identity));
      if (previous?.status === "failed") {
        // 同一 tick 的步骤达到重试上限后不再执行，避免毒丸永久阻塞后续步骤与 tick 收尾。
        continue;
      }
      let matches: boolean;
      try {
        matches = step.when(worldTick);
      } catch (error) {
        // 命中判定本身失败也按步骤与 tick 计入重试，避免每次恢复都卡在筛选阶段。
        if (this.recordFailure(branchId, identity, error)) {
          continue;
        }
        throw error;
      }
      if (!matches) {
        continue;
      }
      executed += 1;
      try {
        const stop = this.storage.transact((tx) => this.runStep(tx, branchId, step));
        if (stop) {
          stopRequested = true;
        }
        if (previous !== null) {
          this.storage.transact((tx) => clearRuleFailure(tx, branchId, identity));
        }
      } catch (error) {
        if (!(error instanceof RuleExecutionError)) {
          throw error;
        }
        // 处理器失败时步骤事务已回滚；记录尝试次数，未达上限仍向宿主传播以停止推进。
        if (!this.recordFailure(branchId, identity, error.cause)) {
          throw error.cause ?? error;
        }
      }
    }
    return { executed, stopRequested };
  }

  /** 记录一次时钟步骤失败；返回 true 表示达到死信上限。 */
  private recordFailure(
    branchId: string,
    identity: RuleFailureIdentity,
    error: unknown,
  ): boolean {
    return this.storage.transact((tx) =>
      recordRuleAttempt(tx, branchId, identity, error, this.host.nowIso()),
    );
  }

  /** 读取分支并确认其状态允许时钟步骤；不存在或不可写时明确失败。 */
  private requireWritableBranch(tx: StorageTransaction, branchId: string): BranchRecord {
    const branch = readBranch(tx, branchId);
    if (branch === null) {
      throw new DomainError("not-found", `分支 ${branchId} 不存在`, { details: { branchId } });
    }
    if (branch.status !== "active" && branch.status !== "paused") {
      throw new DomainError("forbidden", `分支 ${branchId} 当前状态不接受时钟步骤`, {
        details: { branchId, status: branch.status },
      });
    }
    return branch;
  }

  /** 在一个独立事务内执行单个时钟步骤；异常由存储事务回滚并向上传播。 */
  private runStep(tx: StorageTransaction, branchId: string, step: StoredClockStep): boolean {
    const branch = this.requireWritableBranch(tx, branchId);
    const clock = readClock(tx, branchId);
    const worldTx = new TransactionWorldTx({
      storageTx: tx,
      worldId: branch.worldId,
      branchId,
      worldTick: clock.worldTick,
      principalId: systemPrincipalId,
      correlationId: `clock:${clock.worldTick}`,
      scope: step.owner,
      host: this.host,
    });
    const context = createHandlerContext({
      auth: createSystemAuth(branch.worldId, branchId),
      tx: worldTx,
      modules: bindModulePorts({
        binder: this.moduleBinder,
        fallback: this.modules,
        moduleId: step.owner.moduleId,
        registry: this.registry,
        storageTx: tx,
        worldId: branch.worldId,
        branchId,
        worldTick: clock.worldTick,
        principalId: systemPrincipalId,
        correlationId: `clock:${clock.worldTick}`,
        host: this.host,
      }),
      content: this.content,
      approvedSpeech: this.approvedSpeech,
      host: this.host,
      runSeed: this.runSeed,
    });
    let outcome: unknown;
    try {
      outcome = step.handler(context, clock.worldTick);
      assertSynchronous(outcome, `时钟步骤 ${step.stepId}`);
    } catch (error) {
      throw new RuleExecutionError("clock-step", step.stepId, String(clock.worldTick), error);
    }
    return requestsClockStop(outcome);
  }
}
