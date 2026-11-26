/**
 * 核心职责：把计分与报告组装暴露为 `platform.evaluation` 端口，供宿主与控制台查询调用。
 * 交互契约：只接收宿主注入的探针执行结果与 run 元数据；不读存储、不启动实验、不调用模型。
 * 约束与禁忌：禁止在此推进时钟、创建分支或写入世界状态。
 */
import { createStatelessModule } from "@world-prism/module-sdk";
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import {
  aggregateExperimentCells,
  buildRunReport,
  scoreProbeExecutions,
  type ExperimentCell,
  type RunReport,
  type RunReportInput,
} from "./report";
import type { ProbeLexicons } from "./scoring";

/** 评估端口：计分、报告组装与实验汇总的只读入口。 */
export interface EvaluationPort {
  /** 组装单个 run 的报告；探针计分、指标聚合与无效样本计数一并给出。 */
  report(input: RunReportInput): RunReport;
  /** 按「变体 × 脚本分支」汇总多个 run 的指标。 */
  experimentCells(
    reports: readonly { readonly report: RunReport; readonly scriptBranch: string; readonly variant: string }[],
  ): readonly ExperimentCell[];
  /** 对单个探针计分，供调试与单测直接使用。 */
  score(input: Parameters<typeof scoreProbeExecutions>[0][number], lexicons: ProbeLexicons): ReturnType<typeof scoreProbeExecutions>;
}

/** 创建无状态评估模块；端口只暴露纯计算，不持有跨调用状态。 */
export function createEvaluationModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, {
    report: (reportInput: RunReportInput) => buildRunReport(reportInput),
    experimentCells: (reports: Parameters<EvaluationPort["experimentCells"]>[0]) => aggregateExperimentCells(reports),
    score: (probe: Parameters<EvaluationPort["score"]>[0], lexicons: ProbeLexicons) => scoreProbeExecutions([probe], lexicons),
  } satisfies EvaluationPort);
}
