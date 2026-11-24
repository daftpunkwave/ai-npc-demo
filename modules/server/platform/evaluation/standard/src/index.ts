/**
 * 汇总评估模块的公开入口：模块定义、计分、报告组装与实验汇总。
 * 依赖定义、计分与报告文件；宿主只经组合根取用模块定义，其余以纯函数形式供测试直接调用。
 * 禁止在此启动运行时、读取环境变量或隐藏计分失败。
 */
export const packageName = "@ai-npc/mod-platform-evaluation-standard";

export { evaluationModuleDefinition } from "./definition";
export { createEvaluationModule } from "./plugin";
export type { EvaluationPort } from "./plugin";
export {
  aggregateMetrics,
  metricKeysFor,
  normalizeProbeText,
  probeInvalidReason,
  scoreProbe,
} from "./scoring";
export type {
  MetricAggregate,
  MetricKey,
  ProbeAnswerKey,
  ProbeInvalidReason,
  ProbeKind,
  ProbeLexicons,
  ProbeScore,
  ProbeValidityInput,
  ScoredProbe,
} from "./scoring";
export {
  aggregateExperimentCells,
  buildRunReport,
  minimumSamplesForMean,
  scoreProbeExecutions,
} from "./report";
export type {
  ExperimentCell,
  ProbeExecution,
  ReportBehavior,
  ReportCost,
  ReportLatency,
  ReportMemory,
  ReportProbe,
  ReportValidity,
  RunReport,
  RunReportInput,
} from "./report";
