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

/** 无效原因的全集；汇总时每个原因都给一个计数，缺失即为 0。 */
const invalidReasons: readonly ProbeInvalidReason[] = [
  "turn-failed",
  "no-dialogue",
  "speech-fallback",
  "model-substituted",
  "evidence-incomplete",
];

function emptyInvalidCounts(): Record<ProbeInvalidReason, number> {
  return Object.fromEntries(invalidReasons.map((reason) => [reason, 0])) as Record<ProbeInvalidReason, number>;
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
      invalidReason: probeInvalidReason(probe.validity),
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
  return {
    runId: input.runId,
    variant: input.variant,
    scriptId: input.scriptId,
    scriptBranch: input.scriptBranch,
    validity: input.validity,
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
    readonly mean: number | null;
  }[];
}

/** 汇总时每个格子的最少样本数；少于该数要标注「样本不足」。 */
export const minimumSamplesForMean = 3;

/**
 * 按「变体 × 脚本分支」汇总各 run 的指标。
 *
 * 每格统计有效样本数、无效样本数与均值；无效样本来自探针级无效与 run 级无效两种情况，
 * 都计入 invalidSamples，避免把失败样本从分母里悄悄删掉。
 * 有效样本少于 `minimumSamplesForMean` 时仍给均值，但 `mean` 保持数值以便调用方标注，
 * 由控制台页面按 `validSamples` 判断是否显示「样本不足」。
 */
export function aggregateExperimentCells(
  reports: readonly { readonly report: RunReport; readonly scriptBranch: string; readonly variant: string }[],
): readonly ExperimentCell[] {
  const cells = new Map<string, {
    variant: string;
    scriptBranch: string;
    runIds: string[];
    samples: Map<MetricKey, { valid: number[]; invalid: number }>;
  }>();
  for (const { report, scriptBranch, variant } of reports) {
    const key = `${variant}\u0000${scriptBranch}`;
    const cell = cells.get(key) ?? {
      variant, scriptBranch, runIds: [], samples: new Map<MetricKey, { valid: number[]; invalid: number }>(),
    };
    cell.runIds.push(report.runId);
    const runInvalid = report.validity.valid ? 0 : 1;
    for (const metric of report.metrics) {
      const entry = cell.samples.get(metric.metric) ?? { valid: [], invalid: 0 };
      // 指标无法计算（分母为 0）时既不算有效也不算无效样本：它没有机会产生值。
      if (metric.value === null) {
        cell.samples.set(metric.metric, entry);
        continue;
      }
      if (report.validity.valid) {
        entry.valid.push(metric.value);
      } else {
        entry.invalid += runInvalid;
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
      mean: sample.valid.length === 0
        ? null
        : sample.valid.reduce((sum, value) => sum + value, 0) / sample.valid.length,
    })),
  }));
}
