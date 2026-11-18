/**
 * 在分支当前 tick 上运行已注册的时钟步骤，并把同一 tick 的所有步骤放在一个事务内。
 * 依赖存储事务、时钟步骤注册、系统认证与 WorldTx；每日结算与章节评估由 world 模块自行注册。
 * 禁止在时钟外另起定时器、跳过未注册步骤或让某一步失败后留下半个 tick 的世界结果。
 */
import { DomainError, type StorageTransaction } from "@ai-npc/contracts";
import { readBranch, readClock } from "./branch-state";
import { createHandlerContext } from "./handler-context";
import type { RuleRegistry } from "./rule-registry";
import { createSystemAuth, systemPrincipalId } from "./system-auth";
import type { RuleRuntime } from "./types";
import { assertSynchronous, TransactionWorldTx } from "./world-tx";

/** 时钟步骤执行器依赖。 */
export interface ClockStepRunnerOptions extends RuleRuntime {
  readonly registry: RuleRegistry;
}

/** 时钟步骤执行器；读取分支时钟，按注册顺序执行命中步骤。 */
export class ClockStepRunner {
  private readonly storage: RuleRuntime["storage"];
  private readonly host: RuleRuntime["host"];
  private readonly registry: RuleRegistry;
  private readonly modules: unknown;
  private readonly content: unknown;
  private readonly approvedSpeech: RuleRuntime["approvedSpeech"];

  constructor(options: ClockStepRunnerOptions) {
    this.storage = options.storage;
    this.host = options.host;
    this.registry = options.registry;
    this.modules = options.modules;
    this.content = options.content;
    this.approvedSpeech = options.approvedSpeech;
  }

  /** 在分支当前 worldTick 上执行全部命中步骤，返回执行条数。 */
  run(branchId: string): number {
    return this.storage.transact((tx) => this.runInTransaction(tx, branchId));
  }

  private runInTransaction(tx: StorageTransaction, branchId: string): number {
    const branch = readBranch(tx, branchId);
    if (branch === null) {
      throw new DomainError("not-found", `分支 ${branchId} 不存在`, { details: { branchId } });
    }
    if (branch.status !== "active" && branch.status !== "paused") {
      throw new DomainError("forbidden", `分支 ${branchId} 当前状态不接受时钟步骤`, {
        details: { branchId, status: branch.status },
      });
    }
    const clock = readClock(tx, branchId);
    const matching = this.registry.clockStepList().filter((step) => step.when(clock.worldTick));
    let executed = 0;
    for (const step of matching) {
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
        modules: this.modules,
        content: this.content,
        approvedSpeech: this.approvedSpeech,
        host: this.host,
      });
      // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- Codacy 无法解析索引访问返回的 unknown，保留同步检查。
      const outcome = step.handler(context, clock.worldTick);
      assertSynchronous(outcome, `时钟步骤 ${step.stepId}`);      executed += 1;
    }
    return executed;
  }
}
