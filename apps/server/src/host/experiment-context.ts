/**
 * 核心职责：为一个实验 run 准备执行上下文：复算冻结配置并核对 manifest 与宿主装配、展开脚本计划、
 * 启动 run 级调度与工具模块，并构造只服务该 run 的命令网关与对白批准索引。
 * 交互契约：依赖宿主启动聚合、run 配置解析与脚本计划；失败一律抛出带错误码的 `ExperimentFailure`，
 * 由执行器写入失败记录。
 * 约束与禁忌：不写世界状态、不推进时钟；装配或冻结配置与宿主不一致时拒绝执行，不按当前入参重建 run。
 */
import { SpeechApprovalIndex } from "@world-prism/agent-runtime";
import type { Authority } from "@world-prism/authority";
import type { RunReportResponse } from "@world-prism/contracts";
import { runSpecSchema, type RunSpec } from "@world-prism/experiment";
import type { AgentConfiguration } from "./agent-configuration";
import { startAgentRunModules, type AgentRunModules } from "./agent-run-modules";
import { planExperimentScript, UnsupportedScriptError, type ExperimentScriptPlan } from "./experiment-script";
import { clockConfigOf } from "./module-catalog";
import type { HostReadPorts } from "./reads";
import { resolveRunConfiguration, type RunConfigurationInput } from "./run-configuration";
import type { HostStartup } from "./startup-types";
import { createWorldAuthority } from "./world-authority";

/** 执行器依赖的宿主能力；由组合根注入。 */
export interface ExperimentHostDeps {
  readonly core: HostStartup;
  readonly reads: HostReadPorts;
  readonly runConfiguration: RunConfigurationInput;
  /** 评估报告；装配未绑定评估模块时为 null，执行器据此拒绝运行。 */
  readonly report: ((runId: string) => RunReportResponse | null) | null;
  /** 单个 tick 或单个探针等待收敛的上限；超过即按积压显式失败。 */
  readonly settleTimeoutMs: number;
  /** 收敛等待期间的轮询间隔。 */
  readonly pollIntervalMs: number;
}

/** 执行器的可定位失败：错误码进入失败审计与进度接口。 */
export class ExperimentFailure extends Error {
  constructor(readonly code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ExperimentFailure";
  }
}

/** 一个实验 run 的执行上下文。 */
export interface ExperimentRunContext {
  readonly runId: string;
  readonly worldId: string;
  readonly branchId: string;
  readonly runSpec: RunSpec;
  readonly plan: ExperimentScriptPlan;
  readonly agents: AgentConfiguration;
  readonly modules: AgentRunModules;
  readonly authority: Authority;
  readonly approvals: SpeechApprovalIndex;
  readonly rosterAgentIds: readonly string[];
  readonly maxStepTicks: number;
}

/** run 行里执行器需要的字段。 */
export interface ExperimentRunRecord {
  readonly runId: string;
  readonly worldId: string;
  readonly branchId: string;
  readonly runSpec: unknown;
  readonly manifestHash: string | null;
}

/**
 * 准备执行上下文。
 *
 * 冻结配置按创建时的同一实现复算并比对 manifest_hash：环境变量、profile 或模型布局在创建后被改动时，
 * 继续执行会让报告声称的冻结输入与实际输入不一致。宿主只启动了自己装配的游戏模块，
 * 因此 run 的装配摘要必须与宿主一致，否则规则模块与 run 冻结的不是同一套。
 */
export async function prepareExperimentRun(deps: ExperimentHostDeps, record: ExperimentRunRecord): Promise<ExperimentRunContext> {
  const { core } = deps;
  const parsed = runSpecSchema.safeParse(record.runSpec);
  if (!parsed.success) throw new ExperimentFailure("run-spec-invalid", "run 的 RunSpec 无法按 schema 解析");
  const runSpec = parsed.data;
  const scriptRef = runSpec.script?.scriptRef;
  const script = scriptRef === undefined ? undefined : core.content.index.scripts.get(scriptRef);
  if (script === undefined) throw new ExperimentFailure("script-missing", `run 引用的脚本 ${String(scriptRef)} 不在内容包中`);
  let plan: ExperimentScriptPlan;
  try {
    plan = await planExperimentScript({
      script, runSpec, runId: record.runId, playerPrincipalId: core.content.index.playerPrincipalId, hash: core.host.hash,
    });
  } catch (error) {
    if (error instanceof UnsupportedScriptError) throw new ExperimentFailure(error.code, error.message);
    throw error;
  }
  const resolved = await resolveRunConfiguration(deps.runConfiguration, runSpec);
  if ("failures" in resolved) {
    throw new ExperimentFailure("run-configuration-invalid", resolved.failures.map(({ code, message }) => `${code}: ${message}`).join("; "));
  }
  const { configuration } = resolved;
  if (record.manifestHash !== configuration.manifestHash) {
    throw new ExperimentFailure("manifest-mismatch", "按当前配置复算的 manifest 与 run 冻结的 manifest_hash 不一致");
  }
  if (configuration.resolved.assemblyHash !== core.active.resolved.assemblyHash) {
    throw new ExperimentFailure(
      "assembly-mismatch",
      `run 装配 ${runSpec.moduleAssemblyRef} 与宿主当前装配 ${core.active.assembly.assemblyId} 的解析摘要不一致，需以相同装配启动宿主`,
    );
  }
  const agents = configuration.agents;
  if (agents === null) throw new ExperimentFailure("agent-runtime-unavailable", "run 装配没有 Agent 槽位，无法执行探针");
  if (deps.report === null) throw new ExperimentFailure("evaluation-unavailable", "宿主装配未绑定评估模块，无法汇总 experiment_results");
  const scope = { worldId: record.worldId, branchId: record.branchId };
  const modules = await startAgentRunModules({
    plan: core.activeStartup.plan, configuration: agents, content: core.content, host: core.host, scope,
    running: [...core.storageStarted.instances, ...core.startedModules.instances],
  });
  const approvals = new SpeechApprovalIndex();
  const rosterAgentIds = agents.roster.agents.map(({ agentId }) => agentId);
  return {
    runId: record.runId,
    worldId: record.worldId,
    branchId: record.branchId,
    runSpec,
    plan,
    agents,
    modules,
    authority: createWorldAuthority({ core, runSeed: runSpec.seed, approvals, rosterAgentIds }),
    approvals,
    rosterAgentIds,
    maxStepTicks: clockConfigOf(core.activeStartup.plan).maxStepTicks,
  };
}
