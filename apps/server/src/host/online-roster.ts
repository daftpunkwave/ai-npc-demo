/**
 * 核心职责：在线名册的休眠与唤醒。休眠先受控暂停在线时钟并补完当前 tick，再在一个事务内把在线身份置为 dormant，
 *   释放部署级名额；唤醒在一个事务内按同一配额裁决重新激活全部休眠身份，名额不足时整体拒绝。
 *   两者按 operationId 幂等，结果与审计随业务写入同事务提交。
 * 交互契约：依赖 agent-runtime 的激活计数与休眠/激活事务函数、时钟 provider、在线别名、运营幂等日志与基础操作；
 *   名册状态由在线分支的激活行派生（存在休眠身份即为已休眠），跨进程重启保持。
 * 约束与禁忌：禁止先激活再补记账、在时钟未暂停时休眠、在名额不足时留下部分激活的名册，或作用于在线分支以外的分支。
 */
import {
  agentDeploymentQuota,
  countDeploymentActiveIdentities,
  deactivateBranchAgentsInTransaction,
  reactivateBranchAgentsInTransaction,
  readBranchActivationCounts,
  type BranchActivationCounts,
} from "@world-prism/agent-runtime";
import { readBranch } from "@world-prism/authority";
import {
  DomainError,
  type HostServices,
  type OnlineRosterOperationResponse,
  type OnlineRosterState,
  type OnlineRosterView,
  type StoragePort,
  type StorageTransaction,
} from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import { clockView } from "./clock-view";
import type { LiveRunState } from "./live-state";
import type { OnlineRosterDriver, OperationRequest, ServerRuntime } from "./module-catalog";
import { decodeRosterOutcome, toJsonResult, type OperationJournal } from "./operation-journal";
import type { OperationsPrimitives } from "./operations-primitives";

export interface OnlineRosterInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly runtime: ServerRuntime;
  readonly active: LiveRunState;
  readonly journal: OperationJournal;
  readonly primitives: Pick<OperationsPrimitives, "operationKeyFor" | "prepareSnapshot">;
}

/** 名册状态只由激活行派生：存在休眠身份即为已休眠，否则有活动身份为活动，都没有为空。 */
function rosterStateOf(counts: BranchActivationCounts): OnlineRosterState {
  return counts.dormant > 0 ? "hibernated" : counts.active > 0 ? "active" : "empty";
}

/** 在线名册是否处于休眠；时钟控制据此拒绝在名额释放期间继续或单步。 */
export function onlineRosterHibernated(tx: StorageTransaction, branchId: string): boolean {
  return rosterStateOf(readBranchActivationCounts(tx, branchId)) === "hibernated";
}

/** 在调用方事务内读取在线名册视图；部署计数与激活配额裁决同一口径。 */
export function readOnlineRosterInTransaction(tx: StorageTransaction, branchId: string): OnlineRosterView {
  const counts = readBranchActivationCounts(tx, branchId);
  return {
    branchId,
    state: rosterStateOf(counts),
    activeAgents: counts.active,
    dormantAgents: counts.dormant,
    deploymentActiveAgents: countDeploymentActiveIdentities(tx),
    deploymentLimit: agentDeploymentQuota,
  };
}

/** 构造在线名册驱动：休眠、唤醒与只读状态都只作用于当前在线分支。 */
export function createOnlineRoster(input: OnlineRosterInput): OnlineRosterDriver {
  const { host, storage, runtime, active, journal, primitives } = input;

  /** 在线别名必须仍指向宿主当前分支；别名漂移时拒绝，避免把休眠或唤醒写到已让位的分支。 */
  const requireOnlineBranch = (tx: StorageTransaction): string => {
    const branchId = tx.rows("world_aliases").get({ alias: "online" })?.["branch_id"];
    if (branchId !== active.branchId) {
      throw new DomainError("invalid-state", "在线别名与宿主在线分支不一致，拒绝变更名册", {
        details: { branchId: active.branchId },
      });
    }
    return active.branchId;
  };

  const requireState = (view: OnlineRosterView, expected: OnlineRosterView["state"]): void => {
    if (view.state === expected) return;
    const message = view.state === "empty"
      ? "在线世界尚未开局，名册没有占用名额"
      : view.state === "hibernated"
        ? "在线名册已休眠，名额已释放"
        : "在线名册未休眠，无需恢复名额";
    throw new DomainError("invalid-state", message, { details: { branchId: view.branchId, state: view.state } });
  };

  /** 名册变更与审计、幂等结果同事务写入；返回提交后的名册视图与时钟。 */
  const commitChange = (
    tx: StorageTransaction,
    branchId: string,
    type: "OnlineRosterHibernated" | "OnlineRosterWoken",
    operation: OperationRequest,
    agentIds: readonly string[],
  ): OnlineRosterOperationResponse => {
    const clock = runtime.clock.readInTransaction(tx, branchId);
    insertLifecycleAuditEvent(tx, {
      runId: readBranch(tx, branchId)?.runId ?? null,
      branchId,
      type,
      subjectId: operation.principalId,
      payload: { operationId: operation.operationId, agentIds: [...agentIds], worldTick: clock.worldTick },
      createdAt: host.nowIso(),
    });
    return { roster: readOnlineRosterInTransaction(tx, branchId), clock: clockView(clock) };
  };

  const hibernate = (operation: OperationRequest): OnlineRosterOperationResponse => {
    const key = primitives.operationKeyFor("hibernate", operation.principalId, operation.operationId, {});
    const replayed = journal.replay(key, decodeRosterOutcome);
    if (replayed !== null) return replayed;
    try {
      // 先在只读事务里确认可以休眠，再暂停时钟：未开局或已休眠的请求不应留下暂停时钟的副作用。
      storage.transact((tx) => requireState(readOnlineRosterInTransaction(tx, requireOnlineBranch(tx)), "active"));
      primitives.prepareSnapshot();
      const committed = storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) return journal.materialize(stored, decodeRosterOutcome);
        const branchId = requireOnlineBranch(tx);
        requireState(readOnlineRosterInTransaction(tx, branchId), "active");
        if (runtime.clock.readInTransaction(tx, branchId).mode !== "paused") {
          throw new DomainError("invalid-state", "在线时钟未处于暂停，拒绝休眠名册", { details: { branchId } });
        }
        const released = deactivateBranchAgentsInTransaction(tx, branchId, host.nowIso());
        const outcome = commitChange(tx, branchId, "OnlineRosterHibernated", operation, released);
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return outcome;
      });
      return committed;
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  const wake = (operation: OperationRequest): OnlineRosterOperationResponse => {
    const key = primitives.operationKeyFor("wake", operation.principalId, operation.operationId, {});
    const replayed = journal.replay(key, decodeRosterOutcome);
    if (replayed !== null) return replayed;
    try {
      const committed = storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) return journal.materialize(stored, decodeRosterOutcome);
        const branchId = requireOnlineBranch(tx);
        requireState(readOnlineRosterInTransaction(tx, branchId), "hibernated");
        const activation = reactivateBranchAgentsInTransaction(tx, branchId, host.nowIso());
        if (activation.kind === "rejected") {
          // 名额被实验占用是暂时条件：可重试失败不锁定 operationId，名额腾出后同一请求可以重新执行。
          throw new DomainError(
            "budget-exhausted",
            `部署级 Agent 名额不足，无法恢复在线名册：需要 ${activation.requested}，上限 ${activation.limit}`,
            { retryable: true, details: { branchId, requested: activation.requested, limit: activation.limit } },
          );
        }
        const outcome = commitChange(tx, branchId, "OnlineRosterWoken", operation, activation.activated);
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return outcome;
      });
      return committed;
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  return {
    state: () => storage.transact((tx) => readOnlineRosterInTransaction(tx, active.branchId)),
    hibernate,
    wake,
  };
}
