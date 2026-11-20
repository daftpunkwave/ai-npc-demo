/**
 * 在分支当前 tick 上运行已注册的时钟步骤，每个命中步骤在各自事务内按注册顺序提交。
 * 依赖存储事务、时钟步骤注册、系统认证与 WorldTx；每日结算与章节评估由 world 模块自行注册。
 * 禁止在时钟外另起定时器、跳过未注册步骤，或把同一 tick 的多个步骤合并进一个事务。
 */
import { DomainError, type StorageTransaction } from "@ai-npc/contracts";
import { readBranch, readClock, type BranchRecord } from "./branch-state";
import { createHandlerContext } from "./handler-context";
import { bindModulePorts } from "./module-binding";
import type { RuleRegistry } from "./rule-registry";
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

  /** 与 run 相同，但额外返回是否有步骤请求停止时钟，供 tick 收尾后暂停。 */
  runDetailed(branchId: string): ClockStepRunResult {
    const worldTick = this.storage.transact((tx) => {
      this.requireWritableBranch(tx, branchId);
      return readClock(tx, branchId).worldTick;
    });
    const matching = this.registry.clockStepList().filter((step) => step.when(worldTick));
    let stopRequested = false;
    for (const step of matching) {
      this.storage.transact((tx) => {
        if (this.runStep(tx, branchId, step)) {
          stopRequested = true;
        }
      });
    }
    return { executed: matching.length, stopRequested };
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
    const outcome = step.handler(context, clock.worldTick);
    assertSynchronous(outcome, `时钟步骤 ${step.stepId}`);
    return requestsClockStop(outcome);
  }
}
