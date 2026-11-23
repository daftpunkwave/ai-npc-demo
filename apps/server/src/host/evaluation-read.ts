/**
 * 核心职责：从存储读取 run、实验与探针记录，并组装为控制台评估接口的响应 DTO。
 * 交互契约：只读存储；计分与指标聚合委托给注入的评估端口，本文件只负责查询与字段映射。
 * 约束与禁忌：不写存储、不推进时钟、不创建实验；缺少数据时如实返回空集合或抛出可定位错误。
 */
import type {
  ExperimentDetailResponse,
  Json,
  RunReportResponse,
  RunSummary,
  StoragePort,
} from "@ai-npc/contracts";
import type {
  EvaluationPort,
  ProbeExecution,
  ReportBehavior,
  ReportCost,
  ReportLatency,
  ReportMemory,
  RunReport,
} from "./module-catalog";

/** 评估读取端口：控制台路由只经这里取数据。 */
export interface EvaluationReadPort {
  /** run 列表；可按状态过滤。 */
  runs(query: { readonly status?: string; readonly limit?: number }): readonly RunSummary[];
  /** 单个 run 的摘要与冻结 manifest（已去密钥）。 */
  run(runId: string): { readonly runId: string; readonly status: string; readonly manifest: Json; readonly manifestHash: string; readonly contaminated: boolean; readonly evidenceComplete: boolean } | null;
  /** 单个 run 的报告：指标、探针、行为、记忆、成本与延迟。 */
  report(runId: string): RunReportResponse;
  /** 实验详情：各 run 摘要与「变体 × 脚本分支」汇总。 */
  experiment(experimentId: string): ExperimentDetailResponse | null;
  /** 实验列表；从 run 的 RunSpec 反查已存在的实验标识。 */
  experiments(): readonly { readonly experimentId: string; readonly runCount: number }[];
}

/** 构造评估只读端口所需的依赖。 */
export interface EvaluationReadInput {
  readonly storage: StoragePort;
  readonly evaluation: EvaluationPort;
  /** 内容包脚本索引：探针的 kind 与 answerKey 只能从脚本冻结的检查点取得。 */
  readonly scripts: ReadonlyMap<string, {
    readonly checkpoints: readonly {
      readonly atTick: number;
      readonly probes: readonly {
        readonly probeId: string;
        readonly agentId: string;
        readonly kind: string;
        readonly answerKey: { readonly mustMention: readonly string[]; readonly mustNotMention: readonly string[] };
      }[];
    }[];
  }>;
  /** 内容包词表中的未知与遗忘标记，供计分使用。 */
  readonly lexicons: { readonly unknownMarkers: readonly string[]; readonly forgetMarkers: readonly string[] };
  /** 价目版本；缺失时报告里如实写「unknown」而不是编造一个日期。 */
  readonly pricingVersion: string;
}

/** 从 run 行读取字符串列；缺失时返回 null，避免把 undefined 当成合法值。 */
function stringCell(row: Readonly<Record<string, unknown>>, column: string): string | null {
  const value = row[column];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberCell(row: Readonly<Record<string, unknown>>, column: string, fallback: number): number {
  const value = row[column];
  return typeof value === "number" ? value : fallback;
}

function booleanCell(row: Readonly<Record<string, unknown>>, column: string): boolean {
  return numberCell(row, column, 0) !== 0;
}

/** JSON 列可能以字符串或已解析对象返回，统一解码；解码失败返回 null 而不是抛出。 */
function jsonCell(row: Readonly<Record<string, unknown>>, column: string): Json | null {
  const value = row[column];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Json;
    } catch {
      return null;
    }
  }
  return value === undefined ? null : (value as Json);
}

/** 把 run 行映射为控制台摘要；变体取自冻结 RunSpec 里的 variant.id。 */
function runSummary(row: Readonly<Record<string, unknown>>): RunSummary {
  const spec = jsonCell(row, "run_spec_json");
  const specObject = typeof spec === "object" && spec !== null && !Array.isArray(spec)
    ? (spec as Readonly<Record<string, Json>>)
    : {};
  const variantValue = specObject["variant"];
  const variant = typeof variantValue === "object" && variantValue !== null && !Array.isArray(variantValue)
    ? (variantValue as Readonly<Record<string, Json>>)["id"]
    : null;
  return {
    runId: stringCell(row, "run_id") ?? "",
    status: stringCell(row, "status") ?? "created",
    variant: typeof variant === "string" ? variant : null,
    contaminated: booleanCell(row, "contaminated"),
    createdAt: stringCell(row, "created_at") ?? "",
  };
}

/** 从 run 的 RunSpec 中读出脚本章节与分支；实验规格未写脚本时返回 null。 */
function scriptSelectionOf(row: Readonly<Record<string, unknown>>): { readonly scriptRef: string; readonly branch: string | null } | null {
  const spec = jsonCell(row, "run_spec_json");
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return null;
  const script = (spec as Readonly<Record<string, Json>>)["script"];
  if (typeof script !== "object" || script === null || Array.isArray(script)) return null;
  const record = script as Readonly<Record<string, Json>>;
  const scriptRef = record["scriptRef"];
  const branch = record["branch"];
  if (typeof scriptRef !== "string") return null;
  return { scriptRef, branch: typeof branch === "string" ? branch : null };
}

/**
 * 读取探针执行结果并还原为计分输入。
 * `probe_results` 只保存对白与决策原文；脚本声明的 kind 与 answerKey 需要从内容包的脚本里按 probeId 反查，
 * 因此这里把内容脚本的检查点一并传入。
 */
function probeExecutionsOf(input: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly checkpoints: readonly {
    readonly atTick: number;
    readonly probes: readonly {
      readonly probeId: string;
      readonly agentId: string;
      readonly kind: string;
      readonly answerKey: { readonly mustMention: readonly string[]; readonly mustNotMention: readonly string[] };
    }[];
  }[];
  readonly deterministicDecision: boolean;
}): readonly ProbeExecution[] {
  const declared = new Map<string, { readonly kind: string; readonly answerKey: { readonly mustMention: readonly string[]; readonly mustNotMention: readonly string[] } }>();
  for (const checkpoint of input.checkpoints) {
    for (const probe of checkpoint.probes) {
      declared.set(probe.probeId, { kind: probe.kind, answerKey: probe.answerKey });
    }
  }
  return input.rows.flatMap((row) => {
    const probeId = stringCell(row, "probe_id");
    const agentId = stringCell(row, "agent_id");
    const spec = probeId === null ? undefined : declared.get(probeId);
    // 找不到脚本声明时跳过：没有 answerKey 就没有判定依据，不能猜一个 kind。
    if (probeId === null || agentId === null || spec === undefined) return [];
    const answer = stringCell(row, "answer_text") ?? "";
    const valid = booleanCell(row, "valid");
    return [{
      probeId,
      agentId,
      answer,
      kind: spec.kind as ProbeExecution["kind"],
      answerKey: spec.answerKey,
      validity: {
        turnCompleted: valid,
        dialogueIntentKind: answer.length === 0 ? "none" : "answer",
        speechFallback: false,
        modelSubstituted: false,
        evidenceComplete: valid,
        deterministicDecision: input.deterministicDecision,
      },
    }];
  });
}

/** 成本快照：从预算账本聚合；未知 usage 的尝试数一并给出。 */
function costOf(input: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly pricingVersion: string;
}): ReportCost {
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownUsageAttempts = 0;
  let costEstimate = 0;
  for (const row of input.rows) {
    inputTokens += numberCell(row, "input_tokens", 0);
    outputTokens += numberCell(row, "output_tokens", 0);
    if (row["usage_known"] !== undefined && numberCell(row, "usage_known", 1) === 0) unknownUsageAttempts += 1;
    costEstimate += numberCell(row, "cost_estimate", 0);
  }
  return { inputTokens, outputTokens, unknownUsageAttempts, costEstimate, currency: "USD", pricingVersion: input.pricingVersion };
}

/** 延迟快照：按 turn 时长取 p50 与 p95；没有样本时为 null。 */
function latencyOf(durationsMs: readonly number[]): ReportLatency {
  if (durationsMs.length === 0) return { turnP50Ms: null, turnP95Ms: null };
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const percentile = (ratio: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
    return sorted[index] ?? 0;
  };
  return { turnP50Ms: percentile(0.5), turnP95Ms: percentile(0.95) };
}

/** 记忆快照：按层级统计活动记录数与维护运行次数。 */
function memoryOf(input: {
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly maintenance: readonly Readonly<Record<string, unknown>>[];
}): ReportMemory {
  const recordsByTier: Record<string, number> = {};
  for (const row of input.records) {
    const tier = stringCell(row, "tier");
    if (tier === null) continue;
    recordsByTier[tier] = (recordsByTier[tier] ?? 0) + 1;
  }
  let maintenanceRuns = 0;
  let maintenanceFailures = 0;
  for (const row of input.maintenance) {
    maintenanceRuns += 1;
    if (stringCell(row, "status") === "failed") maintenanceFailures += 1;
  }
  return { recordsByTier, maintenanceRuns, maintenanceFailures };
}

/**
 * 行为记录：从脚本声明的决策检查点与 turn 的决策产物中提取立场与理由类别。
 * 只读已归档的 decision 原文，不重新推理。
 */
function behaviorOf(input: {
  readonly turns: readonly Readonly<Record<string, unknown>>[];
}): readonly ReportBehavior[] {
  const behavior: ReportBehavior[] = [];
  for (const turn of input.turns) {
    const stages = jsonCell(turn, "effective_json");
    if (!Array.isArray(stages)) continue;
    const decisionStage = stages.find((stage) =>
      typeof stage === "object" && stage !== null && !Array.isArray(stage) &&
      (stage as Readonly<Record<string, Json>>)["stage"] === "turn.decision");
    if (decisionStage === undefined) continue;
    behavior.push({
      atTick: numberCell(turn, "created_tick", 0),
      agentId: stringCell(turn, "agent_id") ?? "",
      trigger: "player-dialogue",
      stance: stringCell(turn, "status") ?? "unknown",
      reasonCode: stringCell(turn, "terminal_reason") ?? "none",
      commands: [],
    });
  }
  return behavior;
}

/** 构造评估只读端口。 */
export function createEvaluationReadPort(input: EvaluationReadInput): EvaluationReadPort {
  const { storage, evaluation } = input;
  const runRows = (): readonly Readonly<Record<string, unknown>>[] =>
    storage.transact((tx) => tx.rows("runs").list({}));

  const summaryOf = (row: Readonly<Record<string, unknown>>): RunSummary => runSummary(row);

  /**
   * 在一个只读事务里为单个 run 组装报告。
   * `report` 与 `experiment` 共用这一份实现，避免实验汇总与单 run 报告出现两套口径。
   */
  const reportFor = (tx: Parameters<Parameters<StoragePort["transact"]>[0]>[0], runId: string): RunReport | null => {
    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null) return null;
    const branchId = stringCell(run, "branch_id") ?? "";
    const selection = scriptSelectionOf(run);
    const spec = jsonCell(run, "run_spec_json");
    // 确定性决策路径下的模板对白不算降级；依据是冻结 RunSpec 的变体补丁列表。
    const variantObject = typeof spec === "object" && spec !== null && !Array.isArray(spec)
      ? (spec as Readonly<Record<string, Json>>)["variant"]
      : null;
    const patchRefs = typeof variantObject === "object" && variantObject !== null && !Array.isArray(variantObject)
      ? (variantObject as Readonly<Record<string, Json>>)["profilePatchRefs"]
      : null;
    const deterministic = Array.isArray(patchRefs) && patchRefs.includes("decision-deterministic");
    const probes = probeExecutionsOf({
      rows: tx.rows("probe_results").list({ run_id: runId }),
      // 探针的 kind 与 answerKey 只能来自脚本检查点；脚本不在索引里就没有判定依据。
      checkpoints: selection === null ? [] : (input.scripts.get(selection.scriptRef)?.checkpoints ?? []),
      deterministicDecision: deterministic,
    });
    return evaluation.report({
      runId,
      variant: runSummary(run).variant ?? "unknown",
      scriptId: selection?.scriptRef ?? "unknown",
      scriptBranch: selection?.branch ?? "none",
      validity: {
        valid: booleanCell(run, "evidence_complete") && !booleanCell(run, "contaminated"),
        contaminated: booleanCell(run, "contaminated"),
        evidenceComplete: booleanCell(run, "evidence_complete"),
        invalidReasons: booleanCell(run, "contaminated") ? ["contaminated"] : [],
      },
      probes,
      behavior: behaviorOf({ turns: tx.rows("turn_runs").list({ run_id: runId }) }),
      memory: memoryOf({
        records: branchId.length === 0 ? [] : tx.branch(branchId).table("memory_records").list(),
        // maintenance_runs 是部署级表（主键为 maintenance_id），只能经非分支接口按 run 读取。
        maintenance: tx.rows("maintenance_runs").list({ run_id: runId }),
      }),
      cost: costOf({ rows: tx.rows("model_attempts").list({ work_ref: runId }), pricingVersion: input.pricingVersion }),
      latency: latencyOf([]),
      lexicons: input.lexicons,
    });
  };

  return {
    runs(query) {
      const all = runRows().map(summaryOf);
      const filtered = query.status === undefined ? all : all.filter((run) => run.status === query.status);
      return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
    },
    run(runId) {
      const row = storage.transact((tx) => tx.rows("runs").get({ run_id: runId }));
      if (row === null) return null;
      return {
        runId,
        status: stringCell(row, "status") ?? "created",
        manifest: jsonCell(row, "manifest_json") ?? {},
        manifestHash: stringCell(row, "manifest_hash") ?? "",
        contaminated: booleanCell(row, "contaminated"),
        evidenceComplete: booleanCell(row, "evidence_complete"),
      };
    },
    report(runId) {
      const report = storage.transact((tx) => reportFor(tx, runId));
      if (report === null) {
        throw new Error(`run ${runId} 不存在`);
      }
      return toReportResponse(report);
    },
    experiment(experimentId) {
      const rows = runRows();
      // 实验标识来自 run seed 的 `<experimentId>:rep<n>` 约定。
      const matched = rows.filter((row) => {
        const spec = jsonCell(row, "run_spec_json");
        if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return false;
        const seed = (spec as Readonly<Record<string, Json>>)["seed"];
        return typeof seed === "string" && seed.startsWith(`${experimentId}:`);
      });
      if (matched.length === 0) return null;
      const runIds = matched
        .map((row) => stringCell(row, "run_id"))
        .filter((runId): runId is string => runId !== null);
      // 每个 run 的报告与单 run 报告共用同一实现，汇总口径因此不会分叉。
      const reports = storage.transact((tx) => runIds.flatMap((runId) => {
        const report = reportFor(tx, runId);
        return report === null ? [] : [report];
      }));
      const cells = evaluation.experimentCells(reports.map((report) => ({
        report,
        variant: report.variant,
        scriptBranch: report.scriptBranch,
      })));
      const cellSummaries: ExperimentDetailResponse["cells"] = cells.map((cell) => ({
        variant: cell.variant,
        scriptBranch: cell.scriptBranch,
        runIds: [...cell.runIds],
        metrics: cell.metrics.map((metric) => ({
          metric: metric.metric,
          validSamples: metric.validSamples,
          invalidSamples: metric.invalidSamples,
          mean: metric.mean,
        })),
      }));
      return { experimentId, runs: matched.map(summaryOf), cells: cellSummaries };
    },
    experiments() {
      const counts = new Map<string, number>();
      for (const row of runRows()) {
        const spec = jsonCell(row, "run_spec_json");
        if (typeof spec !== "object" || spec === null || Array.isArray(spec)) continue;
        const seed = (spec as Readonly<Record<string, Json>>)["seed"];
        if (typeof seed !== "string") continue;
        const separator = seed.indexOf(":");
        if (separator <= 0) continue;
        const experimentId = seed.slice(0, separator);
        counts.set(experimentId, (counts.get(experimentId) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([experimentId, runCount]) => ({ experimentId, runCount }));
    },
  };
}

/** 把内部报告映射为公共 DTO；字段名与契约一致，无效样本计数单独保留在报告内。 */
function toReportResponse(report: RunReport): RunReportResponse {
  return {
    runId: report.runId as RunReportResponse["runId"],
    variant: report.variant,
    scriptId: report.scriptId,
    scriptBranch: report.scriptBranch,
    validity: {
      valid: report.validity.valid,
      contaminated: report.validity.contaminated,
      evidenceComplete: report.validity.evidenceComplete,
      invalidReasons: [...report.validity.invalidReasons],
    },
    metrics: report.metrics.map((metric) => ({
      metric: metric.metric,
      numerator: metric.numerator,
      denominator: metric.denominator,
      value: metric.value,
      ...(metric.reason === undefined ? {} : { reason: metric.reason }),
    })),
    probes: report.probes.map((probe) => ({
      probeId: probe.probeId,
      agentId: probe.agentId as RunReportResponse["probes"][number]["agentId"],
      answer: probe.answer,
      score: { kind: probe.score.kind, correct: probe.score.correct },
      valid: probe.valid,
      ...(probe.invalidReason === undefined ? {} : { invalidReason: probe.invalidReason }),
    })),
    behavior: report.behavior.map((entry) => ({ ...entry, commands: [...entry.commands] })),
    memory: report.memory,
    cost: report.cost,
    latency: report.latency,
  };
}
