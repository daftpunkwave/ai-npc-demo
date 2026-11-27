/**
 * 核心职责：在检查点执行探针：释放实验名册配额，为每个探针复制一个沙盒分支并只激活被问 Agent，
 * 以 `system:world` 提交 `probe.ask`，等待探针 turn 结束后补齐 `probe_results` 的无效原因，归档沙盒，
 * 全部探针结束后重新预留配额并激活实验名册。
 * 交互契约：依赖存储的分支复制、agent-runtime 的激活/休眠与探针结果读写、run 级命令网关与分支运行时构造；
 * 探针 turn 自己把回答（或无对白）写入 `probe_results`，这里只补写没有产生记录的失败情形，
 * 并以 `ExperimentProbeCompleted` 标记结果已按 turn 终态落定。
 * 约束与禁忌：沙盒不推进逻辑时间、不写回实验分支；同一时刻只有一个沙盒；已写入结果的探针不重复提问，
 * 未落定的按原沙盒 turn 的终态补判。
 */
import {
  activateAgentRosterInTransaction,
  deactivateBranchAgentsInTransaction,
  insertProbeResult,
  invalidateProbeResult,
  readLatestTurnOutcome,
  readProbeResult,
} from "@world-prism/agent-runtime";
import { createSystemAuth } from "@world-prism/authority";
import type { StorageTransaction } from "@world-prism/contracts";
import { finalizedProbeIds, recordExperimentAudit, recordExperimentAuditIn } from "./experiment-audit";
import { openBranchAgentRuntime } from "./branch-agent-runtime";
import { ExperimentFailure } from "./experiment-context";
import type { ScriptProbePlan } from "./experiment-script";
import { activateExperimentRoster, assertRunActive, settleBranch, type ExperimentExecution } from "./experiment-ticks";

/**
 * 当前 tick 结果尚未落定的探针。落定以 `ExperimentProbeCompleted` 审计为准，而不是有没有 `probe_results` 行：
 * 探针 turn 在作答阶段就写下回答，之后仍可能在结算阶段失败；执行在两者之间被停止或进程退出时，
 * 只有回答行的探针还不能算完成，恢复执行时要按它当时 turn 的终态补齐判定。
 */
export function pendingProbesAt(exec: ExperimentExecution, tick: number): readonly ScriptProbePlan[] {
  const probes = exec.ctx.plan.checkpoints.get(tick) ?? [];
  if (probes.length === 0) return [];
  const finalized = exec.deps.core.storage.transact((tx) => finalizedProbeIds(tx, exec.ctx.branchId));
  return probes.filter(({ probeId }) => !finalized.has(probeId));
}

/**
 * 执行检查点探针；调用前实验分支时钟已暂停且本 tick 已收敛。
 * 先休眠实验名册再逐个创建沙盒：标准名册满员时，沙盒里被问的那个 Agent 只能用实验名册让出的名额。
 */
export async function runCheckpointProbes(exec: ExperimentExecution, tick: number, probes: readonly ScriptProbePlan[]): Promise<void> {
  const { core } = exec.deps;
  const { ctx } = exec;
  recordExperimentAudit(core.storage, core.host, {
    runId: ctx.runId, branchId: ctx.branchId, type: "ExperimentCheckpointReached", subjectId: null,
    payload: { atTick: tick, probeIds: probes.map(({ probeId }) => probeId) },
  });
  core.storage.transact((tx) => deactivateBranchAgentsInTransaction(tx, ctx.branchId, core.host.nowIso()));
  for (const probe of probes) {
    // 已有回答行但未落定：不重新提问（结果表只追加，重问会让同一探针出现两条样本），按原沙盒 turn 的终态判定。
    const answered = core.storage.transact((tx) => readProbeResult(tx, ctx.runId, probe.probeId) !== null);
    if (answered) {
      assertRunActive(exec);
      recordProbeOutcome(exec, probe, core.storage.transact((tx) => sandboxOfProbe(tx, ctx.branchId, probe.probeId)), true);
    } else {
      await runProbe(exec, probe);
    }
  }
  // 最后一个沙盒关闭时让出过事件循环：被停止的 run 不能再把名册激活回来占用配额。
  assertRunActive(exec);
  activateExperimentRoster(exec);
}

/** 在一个新沙盒里执行单个探针；无论成功、失败还是被停止，沙盒都会被归档。 */
async function runProbe(exec: ExperimentExecution, probe: ScriptProbePlan): Promise<void> {
  const { core, reads } = exec.deps;
  const { ctx } = exec;
  assertRunActive(exec);
  const sandboxBranchId = core.host.ids("br");
  core.storage.transact((tx) => {
    core.storage.forkBranch(tx, { srcBranchId: ctx.branchId, dstBranchId: sandboxBranchId, kind: "sandbox" });
    const outcome = activateAgentRosterInTransaction({
      tx, branchId: sandboxBranchId, agentIds: [probe.agentId], nowIso: core.host.nowIso(),
    });
    // 抛错让复制与激活一起回滚：配额不足时不留下无人提问的沙盒。
    if (outcome.kind === "rejected") {
      throw new ExperimentFailure("quota-unavailable", `探针沙盒激活超过部署级配额：${outcome.requested} > ${outcome.limit}`);
    }
  });
  exec.sandbox = { branchId: sandboxBranchId, runtime: null };
  try {
    const runtime = await openBranchAgentRuntime({
      core, reads, authority: ctx.authority, approvals: ctx.approvals, agents: ctx.agents, modules: ctx.modules,
      scope: { worldId: ctx.worldId, branchId: sandboxBranchId }, runId: ctx.runId, runSeed: ctx.runSpec.seed,
      probeScriptId: ctx.plan.scriptId, onStateChange: () => undefined,
    });
    exec.sandbox.runtime = runtime;
    assertRunActive(exec);
    const receipt = ctx.authority.commands.execute(createSystemAuth(ctx.worldId, sandboxBranchId), {
      commandId: core.host.ids("cmd"), type: "probe.ask", schemaVersion: 1,
      payload: { probeId: probe.probeId, agentId: probe.agentId, askedBy: probe.askedBy, question: probe.question },
    });
    if (receipt.commandStatus !== "accepted") {
      throw new ExperimentFailure("probe-rejected", `探针 ${probe.probeId} 被拒绝：${String(receipt.reasonCode)}`);
    }
    runtime.notifyWorldChanged();
    await settleBranch(exec, { branchId: sandboxBranchId, runtime }, probe.atTick);
    recordProbeOutcome(exec, probe, sandboxBranchId, false);
  } finally {
    await closeSandbox(exec);
  }
}

/**
 * 曾对该探针提问的最近一个沙盒：按沙盒里的 `ProbeAsked` 事件定位。
 * 每个探针每次提问一个新沙盒，已有回答行后不再提问，因此最近一个就是写下回答的那个；找不到时为 null。
 */
function sandboxOfProbe(tx: StorageTransaction, branchId: string, probeId: string): string | null {
  const row = tx.get(
    `SELECT b.branch_id AS branch_id FROM branches AS b
       JOIN domain_events AS d ON d.branch_id = b.branch_id
      WHERE b.parent_branch_id = ? AND b.kind = 'sandbox' AND d.type = 'ProbeAsked'
        AND json_extract(d.payload_json, '$.probeId') = ?
      ORDER BY b.created_at DESC, d.world_seq DESC LIMIT 1`,
    [branchId, probeId],
  );
  return typeof row?.["branch_id"] === "string" ? row["branch_id"] : null;
}

/**
 * 按探针 turn 的终态补齐结果，并写入表示结果已落定的 `ExperimentProbeCompleted`。
 * - 没有记录且 turn 完成：决定里没有对白意图以外的原因不会走到这里，按 no-dialogue 记；
 * - 没有记录且 turn 未完成或从未被调度：记 turn-failed；
 * - 已有有效记录但 turn 之后失败（对白写入后结算失败）：改判 turn-failed，回答不算完整 turn 的产物；
 * - 恢复执行时补判（`recovered`）：沙盒已归档、运行时已释放，turn 停在哪个状态就按哪个状态判定，
 *   没有到达 completed（被取消、停在中间状态或找不到沙盒）一律记 turn-failed，结论确定、不随重试变化。
 */
function recordProbeOutcome(
  exec: ExperimentExecution,
  probe: ScriptProbePlan,
  sandboxBranchId: string | null,
  recovered: boolean,
): void {
  const { core } = exec.deps;
  const { ctx } = exec;
  core.storage.transact((tx) => {
    const turn = sandboxBranchId === null ? null : readLatestTurnOutcome(tx, sandboxBranchId, probe.agentId);
    const completed = turn?.status === "completed";
    const existing = readProbeResult(tx, ctx.runId, probe.probeId);
    if (existing === null) {
      insertProbeResult(tx, {
        probeResultId: core.host.ids("prb"), runId: ctx.runId, scriptId: ctx.plan.scriptId, probeId: probe.probeId,
        agentId: probe.agentId, askedAtTick: probe.atTick, answerText: null, decision: null,
        invalidReason: completed ? "no-dialogue" : "turn-failed", createdAt: core.host.nowIso(),
      });
    } else if (!completed && existing.valid) {
      invalidateProbeResult(tx, existing.probeResultId, "turn-failed");
    }
    const result = readProbeResult(tx, ctx.runId, probe.probeId);
    recordExperimentAuditIn(tx, core.host, {
      runId: ctx.runId, branchId: ctx.branchId, type: "ExperimentProbeCompleted", subjectId: probe.agentId,
      payload: {
        probeId: probe.probeId, atTick: probe.atTick, sandboxBranchId, recovered,
        turnId: turn?.turnId ?? null, turnStatus: turn?.status ?? null, terminalReason: turn?.terminalReason ?? null,
        probeResultId: result?.probeResultId ?? null, valid: result?.valid ?? false, invalidReason: result?.invalidReason ?? null,
      },
    });
  });
}

/** 释放沙盒运行时并归档沙盒；归档后该分支不再计入配额，也不再接受写入。 */
export async function closeSandbox(exec: ExperimentExecution): Promise<void> {
  const sandbox = exec.sandbox;
  if (sandbox === null) return;
  exec.sandbox = null;
  const { core } = exec.deps;
  try {
    await sandbox.runtime?.dispose();
  } finally {
    core.storage.transact((tx) => {
      const branches = tx.rows("branches");
      const row = branches.get({ branch_id: sandbox.branchId });
      if (row !== null) branches.put({ ...row, status: "archived" });
      deactivateBranchAgentsInTransaction(tx, sandbox.branchId, core.host.nowIso());
    });
  }
}
