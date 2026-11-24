/**
 * 核心职责：把已计分的探针、run 有效性与成本记录组装为 run 报告，并提供实验汇总的分组口径。
 * 交互契约：输入由宿主注入（探针记录、run 有效性、记忆与成本快照）；只做聚合，不读存储。
 * 约束与禁忌：禁止伪造分子分母、禁止用另写的摘要替代原始计分；无法计算的指标写 null 并标注原因。
 */
import type { ProbeKind } from "./scoring";
import type { MetricAggregate, ProbeInvalidReason, ProbeScore } from "./scoring";
import {
  aggregateMetrics,
  probeInvalidReason,
  probeInvalidReasons,
  scoreProbe,
  type MetricKey,
  type ProbeAnswerKey,
  type ProbeLexicons,
} from "./scoring";

/** 报告中的一个探针条目。 */
export interface ReportProbe {
  readonly probeId: string;
  readonly agentId: string;
  readonly answer: string;
  readonly score: {
    readonly kind: ProbeKind;
    readonly correct: boolean;
  };
  readonly valid: boolean;
  readonly invalidReason?: string;
}

/** 报告中的行为记录：某个外部输入触发该 Agent 决策时的立场与理由类别。 */
export interface ReportBehavior {
  readonly atTick: number;
  readonly agentId: string;
  readonly trigger: string;
  readonly stance: string;
  readonly reasonCode: string;
  readonly commands: readonly string[];
}

/** 报告中的记忆快照。 */
export interface ReportMemory {
  readonly recordsByTier: Readonly<Record<string, number>>;
  readonly maintenanceRuns: number;
  readonly maintenanceFailures: number;
}

/** 报告中的成本快照。 */
export interface ReportCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly unknownUsageAttempts: number;
  readonly costEstimate: number;
  readonly currency: string;
  readonly pricingVersion: string;
}

/** 报告中的延迟快照。 */
export interface ReportLatency {
  readonly turnP50Ms: number | null;
  readonly turnP95Ms: number | null;
}

/** run 的有效性判定。 */
export interface ReportValidity {
  readonly valid: boolean;
  readonly contaminated: boolean;
  readonly evidenceComplete: boolean;
  readonly invalidReasons: readonly string[];
}

/** 一个探针的原始执行结果；由宿主从 `probe_results` 读出后传入。 */
export interface ProbeExecution {
  readonly probeId: string;
  readonly agentId: string;
  readonly answer: string;
  readonly kind: ProbeKind;
  readonly answerKey: ProbeAnswerKey;
  readonly validity: {
    readonly turnCompleted: boolean;
    readonly dialogueIntentKind: string;
    readonly speechFallback: boolean;
    readonly modelSubstituted: boolean;
    readonly evidenceComplete: boolean;
    readonly deterministicDecision: boolean;
  };
}
/** 组装 run 报告所需的全部输入。 */
export interface RunReportInput {
  readonly runId: string;
  readonly variant: string;
  readonly scriptId: string;
  readonly scriptBranch: string;
  readonly validity: ReportValidity;
  readonly probes: readonly ProbeExecution[];
  readonly behavior: readonly ReportBehavior[];
  readonly memory: ReportMemory;
  readonly cost: ReportCost;
  readonly latency: ReportLatency;
  readonly lexicons: ProbeLexicons;
}

/** 组装后的 run 报告；指标与探针都保留分子分母与无效原因。 */
export interface RunReport {
  readonly runId: string;
  readonly variant: string;
  readonly scriptId: string;
  readonly scriptBranch: string;
  readonly validity: ReportValidity;
  readonly metrics: readonly MetricAggregate[];
  readonly probes: readonly ReportProbe[];
  readonly behavior: readonly ReportBehavior[];
  readonly memory: ReportMemory;
  readonly cost: ReportCost;
  readonly latency: ReportLatency;
  /** 无效样本数量按原因分类，计入分母说明但不进正确率分母。 */
  readonly invalidProbeCounts: Readonly<Record<ProbeInvalidReason, number>>;
}

/** 每个原因都给一个计数，缺失即为 0。 */
function emptyInvalidCounts(): Record<ProbeInvalidReason, number> {
  return Object.fromEntries(probeInvalidReasons.map((reason) => [reason, 0])) as Record<ProbeInvalidReason, number>;
}

/** 对探针逐个计分与判定有效性；两项判定都是纯函数，组装只做汇合。 */
export function scoreProbeExecutions(
  probes: readonly ProbeExecution[],
  lexicons: ProbeLexicons,
): {
  readonly scored: readonly { readonly probe: ProbeExecution; readonly score: ProbeScore; readonly invalidReason: ProbeInvalidReason | null }[];
} {
  return {
    scored: probes.map((probe) => ({
      probe,
      score: scoreProbe({ kind: probe.kind, answer: probe.answer, answerKey: probe.answerKey, lexicons }),
      // 有效性判定需要正文：规范化后为空的回答没有可判定内容，判为无效而不是按词面放行。
      invalidReason: probeInvalidReason({ ...probe.validity, answer: probe.answer }),
    })),
  };
}

/** 组装 run 报告：探针计分、指标聚合、无效样本计数与原始记录一并给出。 */
export function buildRunReport(input: RunReportInput): RunReport {
  const scored = scoreProbeExecutions(input.probes, input.lexicons).scored;
  const probes: ReportProbe[] = scored.map(({ probe, score, invalidReason }) => ({
    probeId: probe.probeId,
    agentId: probe.agentId,
    answer: probe.answer,
    score: { kind: score.kind, correct: score.correct },
    valid: invalidReason === null,
    ...(invalidReason === null ? {} : { invalidReason }),
  }));
  const invalidProbeCounts = emptyInvalidCounts();
  for (const entry of scored) {
    if (entry.invalidReason !== null) {
      invalidProbeCounts[entry.invalidReason] += 1;
    }
  }
  const metrics = aggregateMetrics(scored.map(({ probe, score, invalidReason }) => ({
    probeId: probe.probeId, agentId: probe.agentId, score, invalidReason,
  })));
  // 全部探针都无效时，run 级有效性也要如实反映：否则该 run 会被当成
  // 「有效但全部无执行机会」，其失败样本不会进入任何无效统计。
  const allProbesInvalid = probes.length > 0 && probes.every((probe) => !probe.valid);
  const validity: ReportValidity = allProbesInvalid
    ? {
        ...input.validity,
        valid: false,
        invalidReasons: [...input.validity.invalidReasons, "all-probes-invalid"],
      }
    : input.validity;
  return {
    runId: input.runId,
    variant: input.variant,
    scriptId: input.scriptId,
    scriptBranch: input.scriptBranch,
    validity,
    metrics,
    probes,
    behavior: input.behavior,
    memory: input.memory,
    cost: input.cost,
    latency: input.latency,
    invalidProbeCounts,
  };
}

/** 实验汇总中的一个格子：变体 × 脚本分支。 */
export interface ExperimentCell {
  readonly variant: string;
  readonly scriptBranch: string;
  readonly runIds: readonly string[];
  readonly metrics: readonly {
    readonly metric: MetricKey;
    readonly validSamples: number;
    readonly invalidSamples: number;
    /** 指标分母为 0 的样本数：没有执行机会，既非有效也非无效。 */
    readonly noOpportunitySamples: number;
    readonly mean: number | null;
  }[];
}

/** 汇总时每个格子的最少样本数；少于该数要标注「样本不足」。 */
export const minimumSamplesForMean = 3;

/** 一个指标在一个格子里的样本口径。 */
interface MetricSamples {
  /** 有值且 run 有效：进入均值。 */
  readonly valid: number[];
  /** 本应产生值但因为探针或 run 无效而没有进入均值的样本数。 */
  invalid: number;
  /** 探针没有执行机会（分母为 0）的样本数；既非有效也非无效。 */
  noOpportunity: number;
}

/**
 * 按「变体 × 脚本分支」汇总各 run 的指标。
 *
 * 三种样本口径必须分开，否则失败会被低估：
 * - **有效样本**：run 有效且指标有值，进入均值；
 * - **无效样本**：探针判定为无效（如无对白、turn 失败、模型替换）或 run 级无效，
 *   该指标因此没有进入均值。这类样本要么值缺失（`value === null`），要么 run 本身已被判无效。
 * - **无机会**：指标分母为 0，例如该 run 根本没有需要 ``secret`` 探针的检查点。
 *   它既不是有效也不是无效，按规格记 `N/A`。
 *
 * 区分方式：指标 `value === null` 时看 run 是否有效——run 有效说明是「无机会」，
 * run 无效说明这次执行没产出可用证据，计入无效。
 */
export function aggregateExperimentCells(
  reports: readonly { readonly report: RunReport; readonly scriptBranch: string; readonly variant: string }[],
): readonly ExperimentCell[] {
  const cells = new Map<string, {
    variant: string;
    scriptBranch: string;
    runIds: string[];
    samples: Map<MetricKey, MetricSamples>;
  }>();
  for (const { report, scriptBranch, variant } of reports) {
    const key = `${variant}\u0000${scriptBranch}`;
    const cell = cells.get(key) ?? {
      variant, scriptBranch, runIds: [], samples: new Map<MetricKey, MetricSamples>(),
    };
    cell.runIds.push(report.runId);
    for (const metric of report.metrics) {
      const entry = cell.samples.get(metric.metric) ?? { valid: [], invalid: 0, noOpportunity: 0 };
      if (!report.validity.valid) {
        // run 级无效：无论该指标有没有值都不进均值。有值说明执行过但结论不可采信，
        // 无值说明连执行都没完成；两种都记为无效样本。
        entry.invalid += 1;
      } else if (metric.value === null) {
        // run 有效但没有分母：该组探针没有执行机会，按 N/A 记录，不算失败。
        entry.noOpportunity += 1;
      } else {
        entry.valid.push(metric.value);
      }
      cell.samples.set(metric.metric, entry);
    }
    cells.set(key, cell);
  }
  return [...cells.values()].map((cell) => ({
    variant: cell.variant,
    scriptBranch: cell.scriptBranch,
    runIds: [...cell.runIds],
    metrics: [...cell.samples.entries()].map(([metric, sample]) => ({
      metric,
      validSamples: sample.valid.length,
      invalidSamples: sample.invalid,
      noOpportunitySamples: sample.noOpportunity,
      mean: sample.valid.length === 0
        ? null
        : sample.valid.reduce((sum, value) => sum + value, 0) / sample.valid.length,
    })),
  }));
}
