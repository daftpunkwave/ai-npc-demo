/**
 * 核心职责：在实验分支上执行受控时钟的单 tick 处理：开局与名册激活、tick 0 提交预置知识、推进或补完 tick、按声明顺序注入脚本命令，
 * 并等待本 tick 收敛（规则 job 与事件消费者追平、感知与记忆摄入追平、到期整理完成、无进行中 turn、无可调度 trigger）。
 * 交互契约：依赖 run 级命令网关、时钟端口、分支 Agent 运行时、agent-runtime 的脚本控制与收敛读数；
 * 每次注入与时钟操作前按执行围栏（run 状态与实验分支时钟版本）检查，被停止、被停止后再次启动所取代
 * 或宿主关闭时抛出 `RunHalted`，失败与积压抛出 `ExperimentFailure`。
 * 约束与禁忌：玩家步骤以玩家身份、Agent 步骤以脚本控制下的该 Agent 身份走正常命令网关，都不授予系统权限或暂停豁免；
 * 只有预置知识以系统世界身份提交，且只在开局后的 tick 0；收敛前不推进下一 tick；
 * 事务内不等待，状态检查、脚本控制的取得与交还和命令注入之间不让出事件循环，避免停止请求或 Agent turn 插入其间。
 */
import {
  acquireScriptControl,
  activateAgentRosterInTransaction,
  readBranchSettlement,
  releaseLeftoverScriptControl,
  releaseScriptControl,
  type AgentRuntime,
  type ScriptControlRequest,
} from "@world-prism/agent-runtime";
import { createSystemAuth, latestEventSeq, listRuleFailures } from "@world-prism/authority";
import { DomainError, type AuthContext, type CommandReceipt, type StorageTransaction } from "@world-prism/contracts";
import { advanceWorldTick, catchUpWorldTick } from "../tick";
import { recordExperimentAudit } from "./experiment-audit";
import { ExperimentFailure, type ExperimentHostDeps, type ExperimentRunContext } from "./experiment-context";
import { stepsAt, type ScriptStepPlan } from "./experiment-script";

/** run 被停止或宿主关闭时中断执行；不是失败，状态由触发方或收尾逻辑负责。 */
export class RunHalted extends Error {
  constructor(readonly reason: "stopped" | "interrupted") {
    super(reason === "stopped" ? "run 已被停止" : "宿主正在关闭");
    this.name = "RunHalted";
  }
}

/**
 * 一次执行的可变状态：实验分支运行时、正在执行的探针沙盒，以及执行围栏。
 *
 * 围栏是实验分支时钟的 `run_version`：停止与启动都会递增它，执行器自己的暂停、单步与 tick 推进后
 * 立即采纳新版本。run 仍是 running 但版本不是本次执行最后采纳的值，说明期间发生过停止并再次启动，
 * 这次执行已被取代——单看 run 状态分不出这两次执行。
 */
export interface ExperimentExecution {
  readonly deps: ExperimentHostDeps;
  readonly ctx: ExperimentRunContext;
  readonly signal: AbortSignal;
  runtime: AgentRuntime | null;
  sandbox: { readonly branchId: string; runtime: AgentRuntime | null } | null;
  clockVersion: number | null;
}

/** 收敛判定所需的一个分支：分支 ID 与其 Agent 运行时。 */
export interface SettleTarget {
  readonly branchId: string;
  readonly runtime: AgentRuntime;
}

/** 执行围栏的读数：run 状态与实验分支时钟版本，在同一事务内读出；时钟缺失时版本为 null。 */
export function readExecutionFence(
  tx: StorageTransaction,
  runId: string,
  branchId: string,
): { readonly status: unknown; readonly clockVersion: number | null } {
  const version = tx.branch(branchId).table("clock").get({})?.["run_version"];
  return { status: tx.rows("runs").get({ run_id: runId })?.["status"], clockVersion: typeof version === "number" ? version : null };
}

/**
 * run 仍在运行、宿主未关闭，且没有被停止后再次启动；否则中断执行。
 * 被取代与被停止一样按 `stopped` 中断，收尾时再由终态写入按同一围栏区分二者。
 */
export function assertRunActive(exec: ExperimentExecution): void {
  if (exec.signal.aborted) throw new RunHalted("interrupted");
  const fence = exec.deps.core.storage.transact((tx) => readExecutionFence(tx, exec.ctx.runId, exec.ctx.branchId));
  if (fence.status !== "running" || fence.clockVersion !== exec.clockVersion) throw new RunHalted("stopped");
}

/**
 * 采纳执行器自己的时钟写入产生的新版本（章节终点暂停、tick 推进中的时钟操作）。
 * 只能在围栏检查之后、未让出事件循环的同步段内调用：此时版本变化只可能来自本次执行。
 */
function adoptClockVersion(exec: ExperimentExecution): void {
  exec.clockVersion = exec.deps.core.storage.transact((tx) => readExecutionFence(tx, exec.ctx.runId, exec.ctx.branchId)).clockVersion;
}

/**
 * 以期望版本执行一次实验分支时钟控制并采纳结果版本。
 * 版本冲突说明在上一次围栏检查之后有人停止或启动过 run，本次执行不再拥有这个时钟，按停止中断。
 */
export function controlClock(
  exec: ExperimentExecution,
  action: "pause" | "step",
  ticks = 0,
): void {
  const clock = exec.deps.core.runtime.clock;
  const branchId = exec.ctx.branchId;
  const expected = exec.clockVersion ?? undefined;
  const result = action === "pause" ? clock.pause(branchId, expected) : clock.step(branchId, ticks, expected);
  if (!result.ok && result.reasonCode === "version-conflict") throw new RunHalted("stopped");
  if (!result.ok) {
    throw new ExperimentFailure("clock-control-failed", `实验分支时钟无法${action === "pause" ? "暂停" : "进入单步"}：${result.reasonCode}`);
  }
  exec.clockVersion = result.clock.runVersion;
}

/** 实验分支上的玩家认证上下文；与在线玩家同一主体，作用域限定在实验分支。 */
function playerAuth(ctx: ExperimentRunContext, principalId: string): AuthContext {
  return {
    principalId, kind: "player", roles: ["player"], worldId: ctx.worldId, branchId: ctx.branchId,
    actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
}

/** 脚本控制下代某个 Agent 提交的认证上下文：按该 Agent 裁决、记在该 Agent 名下，代次取本次窗口的脚本控制代次。 */
function scriptedAgentAuth(ctx: ExperimentRunContext, agentId: string, controllerEpoch: number): AuthContext {
  return {
    principalId: agentId, kind: "system", roles: [], worldId: ctx.worldId, branchId: ctx.branchId,
    actingAsAgentId: agentId, controllerEpoch, turnId: null, turnLeaseEpoch: null,
  };
}

/**
 * 交还上一次执行遗留的脚本控制。窗口在单个同步段内开合，只有进程在取得与交还之间退出才会留下 script 租约；
 * 新一次执行在推进任何 tick、打开 Agent 运行时或复制探针沙盒之前先把控制交还 Agent，审计标记 `recovered`。
 */
export function releaseInterruptedScriptControl(exec: ExperimentExecution): void {
  const { core } = exec.deps;
  core.storage.transact((tx) => releaseLeftoverScriptControl(tx, {
    branchId: exec.ctx.branchId, runId: exec.ctx.runId, nowIso: core.host.nowIso(),
  }));
}

/**
 * 冷启动开局：以玩家身份提交 `campaign.start`，名册激活与开局同事务；已开局时不重复提交。
 * 配额不足时命令被整体拒绝，按配额不可用中断——实验不能在名册不完整时开跑。
 * 开局是否已发生以世界状态为准，因此每次尝试用新的命令 ID：沿用固定 ID 会让腾出名额后的重试
 * 重放上一次的拒绝回执，run 永远无法开局。
 */
export function ensureCampaignStarted(exec: ExperimentExecution): void {
  const { core, reads } = exec.deps;
  const { ctx } = exec;
  const scope = { worldId: ctx.worldId, branchId: ctx.branchId };
  const started = core.storage.transact((tx) => reads.portsIn(tx, scope)["game.world"].campaign() !== null);
  if (started) return;
  assertRunActive(exec);
  const receipt = ctx.authority.commands.execute(playerAuth(ctx, core.content.index.playerPrincipalId), {
    commandId: core.host.ids("cmd"), type: "campaign.start", schemaVersion: 1,
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
 * 以系统世界身份提交脚本预置知识，只在开局后的 tick 0 调用，网关与处理器再按实验分支与首个 tick 前裁决。
 * 停止后恢复时每条预置以原命令 ID 重放，取回原回执而不重复授权；被拒绝的预置重放仍是拒绝，
 * 因此不能像脚本步骤那样按「已有回执」跳过，否则恢复后的 run 会带着缺失的初始条件继续。
 * 预置是每个变体共同的起点，任何一条被拒绝都按失败处理。
 */
function injectSetup(exec: ExperimentExecution): void {
  const { ctx } = exec;
  if (ctx.plan.setup.length === 0) return;
  assertRunActive(exec);
  const auth = createSystemAuth(ctx.worldId, ctx.branchId);
  for (const entry of ctx.plan.setup) {
    const receipt = ctx.authority.commands.execute(auth, {
      commandId: entry.commandId, type: "knowledge.seed", schemaVersion: 1,
      payload: { evidenceId: entry.evidenceId, principalId: entry.principalId },
    });
    if (receipt.commandStatus !== "accepted") {
      throw new ExperimentFailure("script-setup-rejected", `脚本预置 ${entry.declarationIndex} 被拒绝：${String(receipt.reasonCode)}`);
    }
  }
  exec.runtime?.notifyWorldChanged();
}

/**
 * 以脚本控制代 Agent 提交一步：取得该 Agent 的脚本控制（代次 +1）→ 经命令网关以该 Agent 身份与脚本代次提交 →
 * 立即交还 Agent（代次再 +1）。三步在同一同步段内完成，Agent 运行时没有机会在窗口内调度该身份，
 * 窗口前领到旧代次的 turn 之后提交或认领都按过期控制拒绝。提交抛错时同样交还；进程在窗口内退出时由下次执行开始时交还。
 */
function submitUnderScriptControl(exec: ExperimentExecution, step: ScriptStepPlan): CommandReceipt {
  const { core } = exec.deps;
  const { ctx } = exec;
  const controlRequest = (): ScriptControlRequest => ({
    branchId: ctx.branchId, agentId: step.as, runId: ctx.runId, nowIso: core.host.nowIso(),
    context: { declarationIndex: step.declarationIndex, atTick: step.atTick, commandId: step.commandId },
  });
  let controllerEpoch: number;
  try {
    controllerEpoch = core.storage.transact((tx) => acquireScriptControl(tx, controlRequest())).toEpoch;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw new ExperimentFailure("script-control-rejected", `脚本步骤 ${step.declarationIndex} 无法取得 ${step.as} 的控制：${error.safeMessage}`);
  }
  try {
    return ctx.authority.commands.execute(scriptedAgentAuth(ctx, step.as, controllerEpoch), {
      commandId: step.commandId, type: step.command.type, schemaVersion: 1, payload: step.command.payload,
    });
  } finally {
    core.storage.transact((tx) => releaseScriptControl(tx, controlRequest()));
  }
}

/**
 * 注入 tick 的脚本命令。已有回执的步骤（停止后恢复时重放的同一 tick）跳过，不重复下令也不重复记审计。
 * 两种步骤的回执都记在 `as` 名下：玩家步骤以玩家为主体，Agent 步骤以被控 Agent 为主体。
 * 因暂停被拒说明执行器在时钟未处于单步时注入，属于执行器缺陷而非实验结果，按失败处理。
 */
function injectSteps(exec: ExperimentExecution, tick: number): void {
  const { core, reads } = exec.deps;
  const { ctx } = exec;
  const steps = stepsAt(ctx.plan, tick).filter((step) => reads.receipts.read(step.as, ctx.branchId, step.commandId) === null);
  if (steps.length === 0) return;
  assertRunActive(exec);
  for (const step of steps) {
    const receipt = step.controller === "script"
      ? submitUnderScriptControl(exec, step)
      : ctx.authority.commands.execute(playerAuth(ctx, step.as), {
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

/**
 * 补完当前 tick：幂等重跑到期 job、时钟步骤与消费者，注入未提交的脚本命令并等待收敛。
 * tick 0 先提交预置知识再注入脚本步骤，Agent 在首次感知之前就已持有预置条目。
 */
export async function settleCurrentTick(exec: ExperimentExecution, runtime: AgentRuntime, tick: number): Promise<void> {
  assertRunActive(exec);
  try {
    catchUpWorldTick(tickContext(exec));
  } finally {
    adoptClockVersion(exec);
  }
  assertNoChapterStop(exec);
  if (tick === 0) injectSetup(exec);
  injectSteps(exec, tick);
  await settleBranch(exec, { branchId: exec.ctx.branchId, runtime }, tick);
}

/** 推进到下一 tick（时钟须处于 stepping），注入该 tick 的脚本命令并等待收敛。 */
export async function advanceAndSettle(exec: ExperimentExecution, runtime: AgentRuntime, tick: number): Promise<void> {
  assertRunActive(exec);
  try {
    advanceWorldTick({ ...tickContext(exec), targetTick: tick });
  } finally {
    adoptClockVersion(exec);
  }
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
