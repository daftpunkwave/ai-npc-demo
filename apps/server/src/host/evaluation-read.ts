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
  StorageTransaction,
} from "@world-prism/contracts";
import { artifactBodyText } from "@world-prism/module-sdk";
import type {
  EvaluationPort,
  ProbeExecution,
  ReportBehavior,
  ReportCost,
  ReportLatency,
  ReportMemory,
  RunReport,
} from "./module-catalog";
import {
  booleanCell,
  frozenPricingVersionOf,
  jsonCell,
  numberCell,
  runSummary,
  scriptSelectionOf,
  stringCell,
} from "./evaluation-row-codec";
import {
  artifactValue,
  behaviorOf,
  commandTypesOf,
  costOf,
  failedTurnCountOf,
  latencyOf,
  memoryOf,
  turnDurationsOf,
} from "./evaluation-metrics";

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
  /** 当前宿主的世界标识；读取与写入都限定在该作用域内。 */
  readonly worldId: string;
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
    // 归档的结论优先：`valid` 与 `invalid_reason` 是写入时判定的，重读时不要再推导。
    // 只有旧记录缺这两列时才退回最小推断，否则 `empty-answer` 之类的原因会被抹成「有效」。
    const archivedValid = row["valid"] === undefined ? null : booleanCell(row, "valid");
    const archivedReason = stringCell(row, "invalid_reason");
    probes.push({
      probeId,
      agentId,
      answer,
      kind: spec.kind as ProbeExecution["kind"],
      answerKey: spec.answerKey,
      validity: {
        // 归档结论存在时原样采用；缺失时才用「回答非空」推断。
        turnCompleted: archivedValid ?? answer.length > 0,
        dialogueIntentKind: answer.length === 0 ? "none" : "answer",
        speechFallback: archivedReason === "speech-fallback",
        modelSubstituted: archivedReason === "model-substituted",
        evidenceComplete: archivedReason === "evidence-incomplete" ? false : (archivedValid ?? answer.length > 0),
        deterministicDecision: input.deterministicDecision,
        // 归档的无效原因直接带上，供上层按原因归类而不必再猜。
        ...(archivedReason === null ? {} : { archivedInvalidReason: archivedReason }),
      },
    });
  }
  return { probes, undeclaredProbeCount };
}

/** 构造评估只读端口。 */
export function createEvaluationReadPort(input: EvaluationReadInput): EvaluationReadPort {
  const { storage, evaluation } = input;
  /**
   * 读取当前宿主作用域内的 run。
   *
   * 必须按 `world_id` 过滤：`runs` 是部署级表，同一 dataDir 下可能有多个世界的记录，
   * 不过滤会让控制台读到其他世界的数据。
   */
  const runRows = (): readonly Readonly<Record<string, unknown>>[] =>
    storage.transact((tx) => tx.rows("runs").list({ world_id: input.worldId }));

  const summaryOf = (row: Readonly<Record<string, unknown>>): RunSummary => runSummary(row);

  /**
   * 在事务外装载这些 run 中以文件存放的 decision artifact 正文。
   * 报告在一个只读事务里组装，事务内不能做文件 I/O；artifact 写入后不再改变，提前装载不影响报告一致性。
   */
  const fileDecisionBodies = (runIds: readonly string[]): ReadonlyMap<string, string> => {
    const rows = storage.transact((tx) => runIds.flatMap((runId) =>
      tx.rows("artifacts").list({ run_id: runId, kind: "decision", storage: "file" })));
    return new Map(rows.map((row) => [String(row["artifact_id"]), artifactBodyText(storage, row)]));
  };

  /**
   * 在一个只读事务里为单个 run 组装报告。
   * `report` 与 `experiment` 共用这一份实现，避免实验汇总与单 run 报告出现两套口径。
   */
  const reportFor = (
    tx: Parameters<Parameters<StoragePort["transact"]>[0]>[0],
    runId: string,
    fileBodies: ReadonlyMap<string, string>,
  ): RunReport | null => {
    const run = tx.rows("runs").get({ run_id: runId });
    if (run === null || String(run["world_id"]) !== input.worldId) return null;
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
    const turns = tx.rows("turn_runs").list({ run_id: runId });
    // 分支上有 turn 失败或预算耗尽时，某个输入没有得到完成的决策：轨迹不完整，run 计为无效样本而不是从样本里消失。
    const failedTurns = failedTurnCountOf(turns, branchId);
    const invalidReasons = [
      ...(booleanCell(run, "contaminated") ? ["contaminated"] : []),
      ...(probeResult.undeclaredProbeCount === 0 ? [] : ["undeclared-probes"]),
      ...(failedTurns === 0 ? [] : ["agent-turn-failed"]),
    ];
    return evaluation.report({
      runId,
      variant: runSummary(run).variant ?? "unknown",
      scriptId: selection?.scriptRef ?? "unknown",
      scriptBranch: selection?.branch ?? "none",
      validity: {
        valid: evidenceComplete && !booleanCell(run, "contaminated") && failedTurns === 0,
        contaminated: booleanCell(run, "contaminated"),
        evidenceComplete,
        invalidReasons,
      },
      probes: probeResult.probes,
      behavior: behaviorOf({ tx, turns, fileBodies }),
      memory: memoryOf({
        records: branchId.length === 0 ? [] : tx.branch(branchId).table("memory_records").list(),
        // maintenance_runs 是部署级表（主键为 maintenance_id），只能经非分支接口按 run 读取；
        // 探针沙盒与实验分支同属一个 run，按 run 自己的分支收窄，沙盒里排队的整理不计入实验分支的记忆快照。
        maintenance: tx.rows("maintenance_runs").list({ run_id: runId, branch_id: branchId }),
      }),
      // 价目版本以该 run 冻结的模型配置为准；实验 run 可能选用与在线世界不同的模型布局。
      cost: costOf({ rows: tx.rows("budget_ledger").list({ run_id: runId }), pricingVersion: frozenPricingVersionOf(run) ?? input.pricingVersion }),
      latency: latencyOf(turnDurationsOf(turns)),
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
      // 跨 world 的 run 视为不存在：作用域外的数据不该经控制台暴露。
      if (row === null || String(row["world_id"]) !== input.worldId) return null;
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
      const fileBodies = fileDecisionBodies([runId]);
      const report = storage.transact((tx) => reportFor(tx, runId, fileBodies));
      // run 不存在是正常查询结果，不是内部错误：返回 null 让路由给出 not-found。
      return report === null ? null : toReportResponse(report);
    },
    experiment(experimentId) {
      // 仅按 RunSpec 显式写入的 `experimentId` 归组，不按 seed 文本猜测。
      const matched = runRows().filter((row) => experimentIdOf(row) === experimentId);
      if (matched.length === 0) return null;
      const runIds = matched
        .map((row) => stringCell(row, "run_id"))
        .filter((runId): runId is string => runId !== null);
      // 每个 run 的报告与单 run 报告共用同一实现，汇总口径因此不会分叉。
      const fileBodies = fileDecisionBodies(runIds);
      const reports = storage.transact((tx) => runIds.flatMap((runId) => {
        const report = reportFor(tx, runId, fileBodies);
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
    invalidProbeCounts: { ...report.invalidProbeCounts },
    behavior: report.behavior.map((entry) => ({ ...entry, commands: [...entry.commands] })),
    memory: report.memory,
    cost: report.cost,
    latency: report.latency,
  };
}
