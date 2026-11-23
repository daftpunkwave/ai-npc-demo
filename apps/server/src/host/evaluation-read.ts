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
  /** 单个 run 的报告；run 不存在时返回 null，由路由按 not-found 处理。 */
  report(runId: string): RunReportResponse | null;
  /** 实验详情：各 run 摘要与「变体 × 脚本分支」汇总。 */
  experiment(experimentId: string): ExperimentDetailResponse | null;
  /** 实验列表；从 run 的 RunSpec 反查已存在的实验标识。 */
  experiments(): readonly { readonly experimentId: string; readonly runCount: number }[];
}

/** 脚本检查点里一条探针声明的判定依据；kind 与 answerKey 只在声明处出现一次。 */
interface DeclaredProbe {
  readonly kind: string;
  readonly answerKey: { readonly mustMention: readonly string[]; readonly mustNotMention: readonly string[] };
}

/** 脚本检查点：同一 tick 上对若干 Agent 的探针提问声明。 */
interface ScriptCheckpoint {
  readonly atTick: number;
  readonly probes: readonly (DeclaredProbe & {
    readonly probeId: string;
    readonly agentId: string;
  })[];
}

/** 构造评估只读端口所需的依赖。 */
export interface EvaluationReadInput {
  readonly storage: StoragePort;
  readonly evaluation: EvaluationPort;
  /** 内容包脚本索引：探针的 kind 与 answerKey 只能从脚本冻结的检查点取得。 */
  readonly scripts: ReadonlyMap<string, { readonly checkpoints: readonly ScriptCheckpoint[] }>;
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
 *
 * 判定依据的顺序是明确的：`probe_results.valid` 与 `invalid_reason` 是执行时就地写入的归档结论，
 * 必须直接采用，不能凭当前对白文本再推一遍——否则一次读空的 ``answer_text`` 会把已经判定的
 * 有效样本改判成 ``no-dialogue``，让历史报告随读取时机漂移。
 *
 * 只有 ``probe_results`` 尚未写入有效性（旧记录）时，才退回按 answer 是否存在做最小推断。
 * 脚本声明的 ``kind`` 与 ``answerKey`` 来自 run 冻结的脚本引用；取不到声明时该探针不参与计分，
 * 由调用方把 run 标记为证据不完整。
 */
function probeExecutionsOf(input: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly checkpoints: readonly ScriptCheckpoint[];
  readonly deterministicDecision: boolean;
}): {
  readonly probes: readonly ProbeExecution[];
  /** 有探针记录但因缺少脚本声明而无法计分的数量；非 0 说明证据不完整。 */
  readonly undeclaredProbeCount: number;
} {
  const declared = new Map<string, DeclaredProbe>();
  for (const checkpoint of input.checkpoints) {
    for (const probe of checkpoint.probes) {
      declared.set(probe.probeId, { kind: probe.kind, answerKey: probe.answerKey });
    }
  }
  const probes: ProbeExecution[] = [];
  let undeclaredProbeCount = 0;
  for (const row of input.rows) {
    const probeId = stringCell(row, "probe_id");
    const agentId = stringCell(row, "agent_id");
    const spec = probeId === null ? undefined : declared.get(probeId);
    // 找不到脚本声明时不能猜一个 kind：计入证据不完整，而不是悄悄丢掉这条记录。
    if (probeId === null || agentId === null || spec === undefined) {
      undeclaredProbeCount += 1;
      continue;
    }
    const answer = stringCell(row, "answer_text") ?? "";
    // 归档的有效性判定优先；没有归档结论时才退回最小推断。
    const archivedValid = row["valid"] === undefined ? null : booleanCell(row, "valid");
    const archivedReason = stringCell(row, "invalid_reason");
    const turnCompleted = archivedValid ?? answer.length > 0;
    probes.push({
      probeId,
      agentId,
      answer,
      kind: spec.kind as ProbeExecution["kind"],
      answerKey: spec.answerKey,
      validity: {
        turnCompleted,
        dialogueIntentKind: answer.length === 0 ? "none" : "answer",
        speechFallback: archivedReason === "speech-fallback",
        modelSubstituted: archivedReason === "model-substituted",
        evidenceComplete: turnCompleted && archivedReason !== "evidence-incomplete",
        deterministicDecision: input.deterministicDecision,
      },
    });
  }
  return { probes, undeclaredProbeCount };
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

/**
 * 从 turn 的 `started_at` 与 `ended_at` 计算每次 turn 的时长（毫秒）。
 *
 * 只有两列都存在且能解析成时间、且结束不早于开始的 turn 才计入样本；
 * 未开始、未结束或时间戳异常时跳过，而不是用 0 充数——0 会把延迟曲线压低。
 */
function turnDurationsOf(turns: readonly Readonly<Record<string, unknown>>[]): readonly number[] {
  const durations: number[] = [];
  for (const turn of turns) {
    const started = Date.parse(stringCell(turn, "started_at") ?? "");
    const ended = Date.parse(stringCell(turn, "ended_at") ?? "");
    if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) continue;
    durations.push(ended - started);
  }
  return durations;
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
 * 行为记录：只从 turn 归档的决策产物与其真实触发器提取立场、理由类别与提交的命令。
 *
 * 三个字段都不允许填默认值：
 * - `trigger` 取 `trigger_ids_json` 中第一条触发器 ID 的前缀（如 `dialogue`、`summon`）；
 * - `stance` 与 `reasonCode` 取 decision 阶段产物里归档的字段；
 * - `commands` 取 decision 阶段产出的命令类型列表。
 * 任一必需字段缺失就整条跳过：编造一个 `player-dialogue` 触发器会让报告声称发生过没发生的事情。
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
    const stage = decisionStage as Readonly<Record<string, Json>>;
    // 只在归档产物里确有该字段时取值，不从 turn 的通用状态代替决策结果。
    const stance = typeof stage["stance"] === "string" ? stage["stance"] : null;
    const reasonCode = typeof stage["reasonCode"] === "string" ? stage["reasonCode"] : null;
    const triggerId = firstTriggerId(turn);
    if (stance === null || reasonCode === null || triggerId === null) continue;
    behavior.push({
      atTick: numberCell(turn, "created_tick", 0),
      agentId: stringCell(turn, "agent_id") ?? "",
      trigger: triggerId,
      stance,
      reasonCode,
      commands: commandTypesOf(stage),
    });
  }
  return behavior;
}

/** 取 turn 的第一条触发器 ID；没有触发器时返回 null。 */
function firstTriggerId(turn: Readonly<Record<string, unknown>>): string | null {
  const triggers = jsonCell(turn, "trigger_ids_json");
  if (!Array.isArray(triggers)) return null;
  const first = triggers[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** 取 decision 阶段归档的命令类型列表；没有命令时返回空数组。 */
function commandTypesOf(stage: Readonly<Record<string, Json>>): readonly string[] {
  const commands = stage["commands"];
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((command) => {
    if (typeof command === "string" && command.length > 0) return [command];
    if (typeof command !== "object" || command === null || Array.isArray(command)) return [];
    const type = (command as Readonly<Record<string, Json>>)["type"];
    return typeof type === "string" && type.length > 0 ? [type] : [];
  });
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
    const probeResult = probeExecutionsOf({
      rows: tx.rows("probe_results").list({ run_id: runId }),
      // 探针的 kind 与 answerKey 只能来自 run 冻结的脚本引用；脚本不在索引里就没有判定依据。
      checkpoints: selection === null ? [] : (input.scripts.get(selection.scriptRef)?.checkpoints ?? []),
      deterministicDecision: deterministic,
    });
    const archivedEvidenceComplete = booleanCell(run, "evidence_complete");
    // 有探针记录却缺脚本声明时无法计分，这说明证据不完整，不能当成「没有探针」放过。
    const evidenceComplete = archivedEvidenceComplete && probeResult.undeclaredProbeCount === 0;
    const invalidReasons = [
      ...(booleanCell(run, "contaminated") ? ["contaminated"] : []),
      ...(probeResult.undeclaredProbeCount === 0 ? [] : ["undeclared-probes"]),
    ];
    return evaluation.report({
      runId,
      variant: runSummary(run).variant ?? "unknown",
      scriptId: selection?.scriptRef ?? "unknown",
      scriptBranch: selection?.branch ?? "none",
      validity: {
        valid: evidenceComplete && !booleanCell(run, "contaminated"),
        contaminated: booleanCell(run, "contaminated"),
        evidenceComplete,
        invalidReasons,
      },
      probes: probeResult.probes,
      behavior: behaviorOf({ turns: tx.rows("turn_runs").list({ run_id: runId }) }),
      memory: memoryOf({
        records: branchId.length === 0 ? [] : tx.branch(branchId).table("memory_records").list(),
        // maintenance_runs 是部署级表（主键为 maintenance_id），只能经非分支接口按 run 读取。
        maintenance: tx.rows("maintenance_runs").list({ run_id: runId }),
      }),
      cost: costOf({ rows: tx.rows("model_attempts").list({ work_ref: runId }), pricingVersion: input.pricingVersion }),
      latency: latencyOf(turnDurationsOf(tx.rows("turn_runs").list({ run_id: runId }))),
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
      // 契约要求 manifestHash 非空。未写摘要的 run 无法自证冻结输入，
      // 因此给出明确的「缺失」标记而不是空串，同时把该 run 报为证据不完整。
      const manifestHash = stringCell(row, "manifest_hash");
      return {
        runId,
        status: stringCell(row, "status") ?? "created",
        manifest: jsonCell(row, "manifest_json") ?? {},
        manifestHash: manifestHash ?? "missing-manifest",
        contaminated: booleanCell(row, "contaminated"),
        evidenceComplete: booleanCell(row, "evidence_complete") && manifestHash !== null,
      };
    },
    report(runId) {
      const report = storage.transact((tx) => reportFor(tx, runId));
      // run 不存在是正常查询结果，不是内部错误：返回 null 让路由给出 not-found。
      return report === null ? null : toReportResponse(report);
    },
    experiment(experimentId) {
      // 实验与 run 的关联目前没有持久化来源：RunSpec 没有实验标识字段，runs 表也没有关联列。
      // 因此这里不按 seed 文本猜测归组——猜错会把不同实验合并并返回错误标识。
      // 关联字段补齐后在这里改为读显式字段（见跟踪该工作的 Issue）。
      const matched = runRows().filter((row) => experimentIdOf(row) === experimentId);
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
        const experimentId = experimentIdOf(row);
        if (experimentId === null) continue;
        counts.set(experimentId, (counts.get(experimentId) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([experimentId, runCount]) => ({ experimentId, runCount }));
    },
  };
}

/**
 * 读出 run 归属的实验标识。
 *
 * 只认 RunSpec 上显式写入的 `experimentId` 字段；没有该字段时返回 null，
 * 不从 `seed` 等旁证推断——`seed` 是与实验标识独立的配置项，两者可以不同名，
 * 多个实验也可以共享同一 seed。
 */
function experimentIdOf(row: Readonly<Record<string, unknown>>): string | null {
  const spec = jsonCell(row, "run_spec_json");
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return null;
  const value = (spec as Readonly<Record<string, Json>>)["experimentId"];
  return typeof value === "string" && value.length > 0 ? value : null;
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
