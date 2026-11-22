/**
 * 原子预留与结算 run、角色游戏日、单个工作的模型预算。
 * 每次尝试占用一条账本记录，缺失 usage 按预留估价。
 * 禁止在事务内等待模型、把未知计费记为零或覆盖已结算条目。
 */
import { DomainError, type ModuleCreateInput, type StoragePort, type StorageTransaction } from "@ai-npc/contracts";
import { createStatelessModule, type AgentBudgetPort, type ModelBudgetReservation, type ModelRoute } from "@ai-npc/module-sdk";

function estimateCost(price: ModelRoute["price"], input: number, output: number): number {
  return (price.inputPerMTok * input + price.outputPerMTok * output) / 1_000_000;
}

function assertBudget(
  tx: StorageTransaction,
  { scope, limits, route, reservedInput, reservedOutput }: ModelBudgetReservation,
): { day: number; estimate: number } {
  const day = Math.floor(scope.worldTick / 24) + 1;
  const estimate = estimateCost(route.price, reservedInput, reservedOutput);
  if (!Number.isFinite(estimate)) throw new DomainError("budget-exhausted", "模型费用估算超过支持范围");
  const work = tx.get("SELECT COUNT(*) AS attempts FROM budget_ledger WHERE run_id = ? AND work_ref = ?",
    [scope.runId, scope.workRef]);
  if (Number(work?.["attempts"] ?? 0) >= scope.maxModelCalls) {
    throw new DomainError("budget-exhausted", "当前工作的模型调用次数已用尽");
  }
  const chargedTokens = "COALESCE(actual_input, reserved_input) + COALESCE(actual_output, reserved_output)";
  const daily = tx.get(
    `SELECT SUM(${chargedTokens}) AS tokens FROM budget_ledger WHERE run_id = ? AND agent_id = ? AND world_day = ?`,
    [scope.runId, scope.agentId, day],
  );
  const reserved = reservedInput + reservedOutput;
  if (Number(daily?.["tokens"] ?? 0) + reserved > scope.maxDailyTokens) {
    throw new DomainError("budget-exhausted", "角色当日的模型额度已用尽");
  }
  if (limits.maxTokens !== null || limits.maxCost !== null) {
    const run = tx.get(`SELECT SUM(${chargedTokens}) AS tokens, SUM(cost_estimate) AS cost
      FROM budget_ledger WHERE run_id = ?`, [scope.runId]);
    if ((limits.maxTokens !== null && Number(run?.["tokens"] ?? 0) + reserved > limits.maxTokens) ||
      (limits.maxCost !== null && Number(run?.["cost"] ?? 0) + estimate > limits.maxCost)) {
      throw new DomainError("budget-exhausted", "运行的模型额度已用尽");
    }
  }
  return { day, estimate };
}

export function createModelBudgetModule(input: ModuleCreateInput) {
  const storage = input.ports["platform.storage"] as StoragePort;
  const now = input.host.nowIso;
  // 宿主启动时先关闭进程崩溃遗留的预留，费用继续按发送前的保守估值计入。
  storage.transact((tx) => tx.run(
    `UPDATE budget_ledger SET actual_input = reserved_input, actual_output = reserved_output,
       usage_unknown = 1, settled_at = ? WHERE settled_at IS NULL`,
    [now()],
  ));
  const port: AgentBudgetPort = {
    check(reservation) {
      storage.transact((tx) => { assertBudget(tx, reservation); });
    },
    reserve(reservation) {
      const { entryId, scope, route, reservedInput, reservedOutput } = reservation;
      storage.transact((tx) => {
        const entries = tx.rows("budget_ledger");
        if (entries.get({ entry_id: entryId }) !== null) throw new Error("Model attempt already reserved");
        const { day, estimate } = assertBudget(tx, reservation);
        entries.put({
          entry_id: entryId, run_id: scope.runId, agent_id: scope.agentId, work_ref: scope.workRef,
          purpose: route.purpose, model_id: route.modelId, world_day: day, reserved_input: reservedInput,
          reserved_output: reservedOutput, actual_input: null, actual_output: null, usage_unknown: 1,
          cost_estimate: estimate, currency: route.price.currency, created_at: now(), settled_at: null,
        });
      });
    },
    settle({ entryId, actualInput, actualOutput, sent, price }) {
      storage.transact((tx) => {
        const entries = tx.rows("budget_ledger");
        const row = entries.get({ entry_id: entryId });
        if (row === null) throw new Error("Model attempt has no budget reservation");
        if (row["settled_at"] !== null) return;
        if (!sent) {
          entries.delete({ entry_id: entryId });
          return;
        }
        const chargeIn = actualInput ?? Number(row["reserved_input"]);
        const chargeOut = actualOutput ?? Number(row["reserved_output"]);
        entries.put({
          ...row, actual_input: chargeIn, actual_output: chargeOut,
          usage_unknown: actualInput === null || actualOutput === null ? 1 : 0,
          cost_estimate: estimateCost(price, chargeIn, chargeOut), settled_at: now(),
        });
      });
    },
  };
  return createStatelessModule(input, port);
}
