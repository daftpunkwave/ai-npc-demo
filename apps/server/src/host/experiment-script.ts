/**
 * 核心职责：把实验脚本与 RunSpec 的分支选择展开为执行计划：开局后的预置知识、按 tick 排好的外部命令、
 * 检查点探针、终点 tick，以及受控单步每一段的目标 tick。
 * 交互契约：输入内容包脚本、冻结 RunSpec 与 run 标识；命令 ID 由 run 与预置或步骤序号确定性派生，
 * 停止后恢复时同一条预置或步骤重放得到原回执，不会重复下令。
 * 约束与禁忌：不执行命令、不读存储；执行器不支持的脚本形态直接报出，不静默跳过或改写。
 */
import type { CommandRequest, ContentScript, HostServices } from "@world-prism/contracts";
import type { RunSpec } from "@world-prism/experiment";

/** 一条外部命令：脚本声明顺序决定同一 tick 内的注入顺序。 */
export interface ScriptStepPlan {
  readonly declarationIndex: number;
  readonly atTick: number;
  readonly as: string;
  readonly command: CommandRequest;
  readonly commandId: string;
}

/** 一条预置知识：开局后、首个 tick 推进前以 `knowledge.seed` 提交，脚本声明顺序即提交顺序。 */
export interface ScriptSetupPlan {
  readonly declarationIndex: number;
  readonly evidenceId: string;
  readonly principalId: string;
  readonly commandId: string;
}

/** 一条检查点探针。 */
export interface ScriptProbePlan {
  readonly probeId: string;
  readonly agentId: string;
  readonly askedBy: string;
  readonly question: string;
  readonly atTick: number;
}

/** 一个 run 的脚本执行计划。 */
export interface ExperimentScriptPlan {
  readonly scriptId: string;
  readonly branch: string | null;
  readonly startFactionId: string;
  readonly setup: readonly ScriptSetupPlan[];
  readonly steps: readonly ScriptStepPlan[];
  readonly checkpoints: ReadonlyMap<number, readonly ScriptProbePlan[]>;
  /** 最后一个外部命令或检查点所在 tick；处理完该 tick 即完成脚本。 */
  readonly endTick: number;
  readonly probeCount: number;
}

/** 执行器无法按文档语义执行的脚本形态；错误码进入失败记录。 */
export class UnsupportedScriptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UnsupportedScriptError";
  }
}

/**
 * 展开脚本。
 *
 * - `setup` 每一条展开为一条 `knowledge.seed`，由执行器在开局后、首个 tick 推进前经命令网关提交，
 *   不由宿主直接改写知识聚合，预置与其他输入一样留下回执与事件。
 * - 外部命令只以玩家身份注入：脚本冒充玩家时走正常认证与权限校验。Agent 身份的命令必须持有该身份的
 *   turn 租约，或经真人席位接管后的控制代次，执行器两者都没有，因此其他主体的步骤整体拒绝。
 * - RunSpec 已指定玩家派系时必须与脚本开局一致，否则两份冻结输入互相矛盾。
 */
export async function planExperimentScript(input: {
  readonly script: ContentScript;
  readonly runSpec: RunSpec;
  readonly runId: string;
  readonly playerPrincipalId: string;
  readonly hash: HostServices["hash"];
}): Promise<ExperimentScriptPlan> {
  const { script, runSpec } = input;
  if (runSpec.player.factionId !== null && runSpec.player.factionId !== script.start.factionId) {
    throw new UnsupportedScriptError(
      "script-start-mismatch",
      `RunSpec 玩家派系 ${runSpec.player.factionId} 与脚本开局派系 ${script.start.factionId} 不一致`,
    );
  }
  const branchName = runSpec.script?.branch ?? null;
  const branchSteps = branchName === null ? [] : script.branches?.find((branch) => branch.name === branchName)?.addSteps;
  if (branchSteps === undefined) {
    throw new UnsupportedScriptError("script-branch-missing", `脚本 ${script.scriptId} 没有分支 ${String(branchName)}`);
  }
  const setup: ScriptSetupPlan[] = [];
  for (const [declarationIndex, entry] of (script.setup ?? []).entries()) {
    const digest = await input.hash([input.runId, "script-setup", declarationIndex]);
    setup.push({ declarationIndex, evidenceId: entry.grantEvidence, principalId: entry.to, commandId: `cmd-${digest.slice(0, 12)}` });
  }
  const declared = [...script.steps, ...branchSteps];
  const steps: ScriptStepPlan[] = [];
  for (const [declarationIndex, step] of declared.entries()) {
    if (step.as !== input.playerPrincipalId) {
      throw new UnsupportedScriptError("script-principal-unsupported", `脚本步骤 ${declarationIndex} 以 ${step.as} 身份提交，执行器只支持玩家身份`);
    }
    const digest = await input.hash([input.runId, "script-step", declarationIndex]);
    steps.push({ declarationIndex, atTick: step.atTick, as: step.as, command: step.command, commandId: `cmd-${digest.slice(0, 12)}` });
  }
  // 同一 tick 内保持声明顺序（主线步骤在前、分支追加在后），稳定排序只按 tick 重排。
  steps.sort((left, right) => left.atTick - right.atTick || left.declarationIndex - right.declarationIndex);
  const checkpoints = new Map<number, ScriptProbePlan[]>();
  for (const checkpoint of script.checkpoints) {
    const probes = checkpoints.get(checkpoint.atTick) ?? [];
    for (const probe of checkpoint.probes) {
      probes.push({ probeId: probe.probeId, agentId: probe.agentId, askedBy: probe.askedBy, question: probe.question, atTick: checkpoint.atTick });
    }
    checkpoints.set(checkpoint.atTick, probes);
  }
  const { endTick, probeCount } = scriptExtent(script, branchName);
  return { scriptId: script.scriptId, branch: branchName, startFactionId: script.start.factionId, setup, steps, checkpoints, endTick, probeCount };
}

/** 脚本在某个分支下的终点 tick 与探针总数；执行计划与进度读取共用，二者不会对终点给出不同结论。 */
export function scriptExtent(script: ContentScript, branch: string | null): { readonly endTick: number; readonly probeCount: number } {
  const branchSteps = branch === null ? [] : script.branches?.find(({ name }) => name === branch)?.addSteps ?? [];
  const ticks = [
    ...[...script.steps, ...branchSteps].map(({ atTick }) => atTick),
    ...script.checkpoints.map(({ atTick }) => atTick),
  ];
  return {
    endTick: Math.max(0, ...ticks),
    probeCount: script.checkpoints.reduce((sum, { probes }) => sum + probes.length, 0),
  };
}

/**
 * 下一段受控单步的目标 tick：不越过下一个检查点与脚本终点，也不超过时钟允许的单步上限。
 * 已到终点时返回当前 tick，调用方据此只补完当前 tick 而不再推进。
 */
export function nextStepTarget(plan: ExperimentScriptPlan, worldTick: number, maxStepTicks: number): number {
  if (worldTick >= plan.endTick) return worldTick;
  const nextCheckpoint = [...plan.checkpoints.keys()].filter((tick) => tick > worldTick).sort((left, right) => left - right)[0];
  return Math.min(worldTick + maxStepTicks, plan.endTick, nextCheckpoint ?? plan.endTick);
}

/** 某个 tick 要注入的外部命令，已按声明顺序排列。 */
export function stepsAt(plan: ExperimentScriptPlan, worldTick: number): readonly ScriptStepPlan[] {
  return plan.steps.filter(({ atTick }) => atTick === worldTick);
}
