/**
 * 核心职责：在实验分支上执行受控时钟的单 tick 处理：开局与名册激活、推进或补完 tick、按声明顺序注入脚本命令，
 * 并等待本 tick 收敛（规则 job 与事件消费者追平、感知与记忆摄入追平、到期整理完成、无进行中 turn、无可调度 trigger）。
 * 交互契约：依赖 run 级命令网关、时钟端口、分支 Agent 运行时与 agent-runtime 的收敛读数；
 * 每次注入前读取 run 状态，被停止或宿主关闭时抛出 `RunHalted`，失败与积压抛出 `ExperimentFailure`。
 * 约束与禁忌：脚本命令以玩家身份走正常命令网关，不授予系统权限或暂停豁免；收敛前不推进下一 tick；
 * 事务内不等待，状态检查与命令注入之间不让出事件循环，避免停止请求插入其间。
 */
import {
  activateAgentRosterInTransaction,
  readBranchSettlement,
  type AgentRuntime,
} from "@world-prism/agent-runtime";
import { latestEventSeq, listRuleFailures } from "@world-prism/authority";
import type { AuthContext } from "@world-prism/contracts";
import { advanceWorldTick, catchUpWorldTick } from "../tick";
import { recordExperimentAudit } from "./experiment-audit";
import { ExperimentFailure, type ExperimentHostDeps, type ExperimentRunContext } from "./experiment-context";
import { stepsAt } from "./experiment-script";

/** run 被停止或宿主关闭时中断执行；不是失败，状态由触发方或收尾逻辑负责。 */
export class RunHalted extends Error {
  constructor(readonly reason: "stopped" | "interrupted") {
    super(reason === "stopped" ? "run 已被停止" : "宿主正在关闭");
    this.name = "RunHalted";
  }
}

/** 一次执行的可变状态：实验分支运行时与正在执行的探针沙盒。 */
export interface ExperimentExecution {
  readonly deps: ExperimentHostDeps;
  readonly ctx: ExperimentRunContext;
  readonly signal: AbortSignal;
  runtime: AgentRuntime | null;
  sandbox: { readonly branchId: string; runtime: AgentRuntime | null } | null;
}

/** 收敛判定所需的一个分支：分支 ID 与其 Agent 运行时。 */
export interface SettleTarget {
  readonly branchId: string;
  readonly runtime: AgentRuntime;
}

/** run 仍在运行且宿主未关闭；否则中断执行。 */
export function assertRunActive(exec: ExperimentExecution): void {
  if (exec.signal.aborted) throw new RunHalted("interrupted");
  const status = exec.deps.core.storage.transact((tx) => tx.rows("runs").get({ run_id: exec.ctx.runId })?.["status"]);
  if (status !== "running") throw new RunHalted("stopped");
}

/** 实验分支上的玩家认证上下文；与在线玩家同一主体，作用域限定在实验分支。 */
function playerAuth(ctx: ExperimentRunContext, principalId: string): AuthContext {
  return {
    principalId, kind: "player", roles: ["player"], worldId: ctx.worldId, branchId: ctx.branchId,
    actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
}

/**
 * 冷启动开局：以玩家身份提交 `campaign.start`，名册激活与开局同事务；已开局时不重复提交。
 * 配额不足时命令被整体拒绝，按配额不可用失败——实验不能在名册不完整时开跑。
 */
export async function ensureCampaignStarted(exec: ExperimentExecution): Promise<void> {
  const { core, reads } = exec.deps;
  const { ctx } = exec;
  const scope = { worldId: ctx.worldId, branchId: ctx.branchId };
  const started = core.storage.transact((tx) => reads.portsIn(tx, scope)["game.world"].campaign() !== null);
  if (started) return;
  const digest = await core.host.hash([ctx.runId, "campaign-start"]);
  assertRunActive(exec);
  const receipt = ctx.authority.commands.execute(playerAuth(ctx, core.content.index.playerPrincipalId), {
    commandId: `cmd-${digest.slice(0, 12)}`, type: "campaign.start", schemaVersion: 1,
    payload: { factionId: ctx.plan.startFactionId },
  });
  if (receipt.commandStatus !== "accepted") {
    throw new ExperimentFailure(
      receipt.reasonCode === "budget-exhausted" ? "quota-unavailable" : "campaign-start-rejected",
      `实验分支开局被拒绝：${String(receipt.reasonCode)}`,
    );
  }
}

/** 按冻结名册在实验分支上重新预留配额并激活；停止或探针期间休眠的身份在继续前恢复。 */
export function activateExperimentRoster(exec: ExperimentExecution): void {
  const { core } = exec.deps;
  const outcome = core.storage.transact((tx) => activateAgentRosterInTransaction({
    tx, branchId: exec.ctx.branchId, agentIds: exec.ctx.rosterAgentIds, nowIso: core.host.nowIso(),
  }));
  if (outcome.kind === "rejected") {
    throw new ExperimentFailure("quota-unavailable", `部署级 Agent 配额不足：${outcome.requested} > ${outcome.limit}`);
  }
}

/**
 * 注入 tick 的脚本命令。已有回执的步骤（停止后恢复时重放的同一 tick）跳过，不重复下令也不重复记审计。
 * 因暂停被拒说明执行器在时钟未处于单步时注入，属于执行器缺陷而非实验结果，按失败处理。
 */
function injectSteps(exec: ExperimentExecution, tick: number): void {
  const { core, reads } = exec.deps;
  const { ctx } = exec;
  const steps = stepsAt(ctx.plan, tick).filter((step) => reads.receipts.read(step.as, ctx.branchId, step.commandId) === null);
  if (steps.length === 0) return;
  assertRunActive(exec);
  for (const step of steps) {
    const receipt = ctx.authority.commands.execute(playerAuth(ctx, step.as), {
      commandId: step.commandId, type: step.command.type, schemaVersion: 1, payload: step.command.payload,
    });
    if (receipt.commandStatus === "rejected" && receipt.reasonCode === "paused") {
      throw new ExperimentFailure("script-step-paused", `脚本步骤 ${step.declarationIndex} 在时钟暂停时注入`);
    }
    recordExperimentAudit(core.storage, core.host, {
      runId: ctx.runId, branchId: ctx.branchId, type: "ExperimentStepSubmitted", subjectId: step.as,
      payload: {
        declarationIndex: step.declarationIndex, atTick: step.atTick, commandId: step.commandId,
        commandType: step.command.type, commandStatus: receipt.commandStatus, reasonCode: receipt.reasonCode,
      },
    });
  }
  exec.runtime?.notifyWorldChanged();
}

/** 章节终点已登记时脚本无法继续推进，按失败处理而不是静默停在原地。 */
function assertNoChapterStop(exec: ExperimentExecution): void {
  if (exec.ctx.authority.clock.pendingStop(exec.ctx.branchId)) {
    throw new ExperimentFailure("chapter-ended", "实验分支已到章节终点，脚本无法继续推进");
  }
}

function tickContext(exec: ExperimentExecution) {
  return { storage: exec.deps.core.storage, clock: exec.deps.core.runtime.clock, authority: exec.ctx.authority, branchId: exec.ctx.branchId };
}

/** 补完当前 tick：幂等重跑到期 job、时钟步骤与消费者，注入未提交的脚本命令并等待收敛。 */
export async function settleCurrentTick(exec: ExperimentExecution, runtime: AgentRuntime, tick: number): Promise<void> {
  catchUpWorldTick(tickContext(exec));
  assertNoChapterStop(exec);
  injectSteps(exec, tick);
  await settleBranch(exec, { branchId: exec.ctx.branchId, runtime }, tick);
}

/** 推进到下一 tick（时钟须处于 stepping），注入该 tick 的脚本命令并等待收敛。 */
export async function advanceAndSettle(exec: ExperimentExecution, runtime: AgentRuntime, tick: number): Promise<void> {
  assertRunActive(exec);
  advanceWorldTick({ ...tickContext(exec), targetTick: tick });
  assertNoChapterStop(exec);
  runtime.notifyWorldChanged();
  injectSteps(exec, tick);
  await settleBranch(exec, { branchId: exec.ctx.branchId, runtime }, tick);
}

/** 追平规则 job 与事件消费者：命令与 turn 新产生的事件和到期 job 在这里结算，直到一轮没有新工作。 */
function drainRules(exec: ExperimentExecution, branchId: string, tick: number): void {
  const { authority } = exec.ctx;
  for (;;) {
    const jobs = authority.jobs.runDue(branchId, tick);
    const consumers = authority.consumers.run(branchId);
    if (jobs === 0 && consumers.scanned === 0) return;
  }
}

/**
 * 等待分支在当前 tick 收敛。
 *
 * 一轮依次追平规则、跑一次 Agent 运行时周期，再读收敛读数；只有在没有进行中 turn、感知与摄入追平、
 * 无到期整理，且事件前沿与 turn 总数与上一轮相同（说明这一轮没有新事件也没有新建 turn）时才算收敛。
 * 只因冷却未到而不能调度的 trigger 不会产生 turn，因此不阻塞收敛。死信的规则失败与超时积压都显式失败。
 */
export async function settleBranch(exec: ExperimentExecution, target: SettleTarget, tick: number): Promise<void> {
  const { core, settleTimeoutMs, pollIntervalMs } = exec.deps;
  const deadline = core.host.monotonicMs() + settleTimeoutMs;
  let previous: string | null = null;
  for (;;) {
    assertRunActive(exec);
    drainRules(exec, target.branchId, tick);
    const deadLettered = listRuleFailures(core.storage, target.branchId).find(({ status }) => status === "failed");
    if (deadLettered !== undefined) {
      throw new ExperimentFailure("rule-failure", `${deadLettered.phase} ${deadLettered.subjectId} 已停止重试：${deadLettered.reasonCode}`);
    }
    try {
      await target.runtime.pump();
    } catch (error) {
      throw new ExperimentFailure("agent-runtime-failed", error instanceof Error ? error.message : String(error), { cause: error });
    }
    const nowMs = Date.parse(core.host.nowIso());
    const reading = core.storage.transact((tx) => ({
      settlement: readBranchSettlement(tx, { branchId: target.branchId, worldTick: tick, nowMs }),
      eventSeq: latestEventSeq(tx, target.branchId) ?? 0,
    }));
    const { settlement } = reading;
    const idle = settlement.activeTurns === 0 && settlement.unperceivedEvents === 0 &&
      settlement.agentsBehindIngestion === 0 && settlement.pendingMaintenance === 0;
    const fingerprint = `${reading.eventSeq}:${settlement.turnCount}`;
    if (idle && fingerprint === previous) return;
    if (core.host.monotonicMs() > deadline) {
      throw new ExperimentFailure("settle-timeout", `分支 ${target.branchId} 在 tick ${tick} 超过 ${settleTimeoutMs} 毫秒未收敛：${JSON.stringify(settlement)}`);
    }
    previous = fingerprint;
    if (!idle) await pause(exec, pollIntervalMs);
  }
}

/** 收敛等待中的轮询间隔；宿主关闭时立即中断。 */
async function pause(exec: ExperimentExecution, ms: number): Promise<void> {
  try {
    await exec.deps.core.host.sleep(ms, exec.signal);
  } catch (error) {
    if (exec.signal.aborted) throw new RunHalted("interrupted");
    throw error;
  }
}
