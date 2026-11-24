/**
 * 核心职责：渲染评估页面的只读视图：实验列表、run 状态与「变体 × 脚本分支」指标汇总。
 * 交互契约：经 console 宿主端口读取远端评估数据；不发起写操作，不显示凭据。
 * 约束与禁忌：页面不改变实验状态；样本不足与不可计算指标必须如实呈现，不用 0 代替缺失值。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析时会把 React/契约类型判成 any。 */
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type { ExperimentDetailResponse, ModuleCreateInput, ModuleInstance, RunReportResponse } from "@ai-npc/contracts";

/**
 * 控制台宿主端口：页面只读其中的评估数据读取能力。
 * 读取方法由宿主按真实 HTTP 客户端注入；页面不直接拼请求，也不假设服务端路由的名称。
 * `report` 返回 null 仅表示「该 run 不存在」；其它失败必须以异常抛出，由页面显示，便于定位。
 */
interface ConsoleHostPort {
  readonly evaluation: {
    /** 实验列表；没有实验时返回空数组。 */
    list(): Promise<readonly { readonly experimentId: string; readonly runCount: number }[]>;
    /** 实验详情：各 run 摘要与「变体 × 脚本分支」汇总。 */
    experiment(experimentId: string): Promise<ExperimentDetailResponse>;
    /** 单个 run 的报告；run 不存在时返回 null，其它错误抛出。 */
    report(runId: string): Promise<RunReportResponse | null>;
  };
}

/** 指标值：无法计算时显示 N/A，不显示 0。 */
function metricValue(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(3);
}

/** 样本数不足阈值时标注，避免把一两例的结果当作结论。 */
function sampleNote(validSamples: number, minimum: number): string {
  return validSamples < minimum ? `（样本不足：${validSamples}）` : `（${validSamples} 例）`;
}

/** 汇总时每个格子的最少样本数，与评估模块的 `minimumSamplesForMean` 保持一致。 */
const minimumSamplesForMean = 3;

/** run 报告视图：指标按「分子/分母/值」三列呈现，探针逐条列出有效性与得分。 */
function RunReportPanel({ report }: { readonly report: RunReportResponse }): ReactNode {
  return (
    <section>
      <h3>run {report.runId}</h3>
      <p>变体 {report.variant} · 脚本 {report.scriptId} · 分支 {report.scriptBranch}</p>
      <p>
        有效性：{report.validity.valid ? "有效" : "无效"}
        {report.validity.contaminated ? "（已污染）" : ""}
        {report.validity.evidenceComplete ? "" : "（证据不完整）"}
        {report.validity.invalidReasons.length === 0 ? "" : `：${report.validity.invalidReasons.join("、")}`}
      </p>
      {Object.entries(report.invalidProbeCounts).some(([, count]) => count > 0) ? (
        <p>
          无效探针：
          {Object.entries(report.invalidProbeCounts)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => `${reason} ${count}`)
            .join(" · ")}
        </p>
      ) : null}
      <table>
        <thead>
          <tr><th>指标</th><th>分子</th><th>分母</th><th>值</th></tr>
        </thead>
        <tbody>
          {report.metrics.map((metric) => (
            <tr key={metric.metric}>
              <td>{metric.metric}</td>
              <td>{metric.numerator ?? "—"}</td>
              <td>{metric.denominator ?? "—"}</td>
              <td>
                {metric.value === null
                  ? `N/A${metric.reason === undefined ? "" : `（${metric.reason}）`}`
                  : metricValue(metric.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>探针</h4>
      <ul>
        {report.probes.map((probe) => (
          <li key={probe.probeId}>
            {probe.probeId} · {probe.agentId} · {probe.score.kind} ·{" "}
            {probe.valid ? (probe.score.correct ? "正确" : "不正确") : `无效（${probe.invalidReason ?? "未知原因"}）`}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 评估页主体：可选择实验与 run，逐格展示汇总并显示所选 run 的报告。 */
function EvaluationPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const reader = host.evaluation;
  const [experiments, setExperiments] = useState<readonly { readonly experimentId: string; readonly runCount: number }[]>([]);
  const [experimentId, setExperimentId] = useState<string | null>(null);
  const [experiment, setExperiment] = useState<ExperimentDetailResponse | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [report, setReport] = useState<RunReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  // 实验列表：只加载一次，之后由选择驱动详情。
  useEffect(() => {
    let cancelled = false;
    void reader.list().then((list) => {
      if (cancelled) return;
      setExperiments(list);
      setExperimentId((current) => current ?? list[0]?.experimentId ?? null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [reader]);

  // 所选实验的详情；切换实验时清空上一个 run 的选择与报告，避免显示错配的数据。
  useEffect(() => {
    if (experimentId === null) {
      setExperiment(null);
      setRunId(null);
      setReport(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setReport(null);
    setReportError(null);
    void reader.experiment(experimentId).then((detail) => {
      if (cancelled) return;
      setExperiment(detail);
      setRunId((current) => (current !== null && detail.runs.some((run) => run.runId === current)
        ? current
        : detail.runs[0]?.runId ?? null));
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [reader, experimentId]);

  // 所选 run 的报告；读取失败要显示出来，不能静默退回空状态。
  useEffect(() => {
    if (runId === null) {
      setReport(null);
      return;
    }
    let cancelled = false;
    // 立即清除上一个 run 的报告：加载期间继续显示旧数据会让读者以为那是当前 run 的结论。
    setReport(null);
    setReportError(null);
    void reader.report(runId).then((next) => {
      if (!cancelled) setReport(next);
    }).catch((cause: unknown) => {
      if (!cancelled) setReportError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [reader, runId]);

  if (error !== null) {
    return <p role="alert">读取实验数据失败：{error}</p>;
  }
  // 空状态如实呈现：页面只读，创建实验须经研究员角色与服务端预检。
  if (experiments.length === 0) {
    return <p>还没有实验记录。创建实验需要研究员角色并经服务端预检。</p>;
  }
  return (
    <section>
      <h2>评估与对比</h2>
      <label>
        实验
        <select
          value={experimentId ?? ""}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => setExperimentId((event.target as unknown as { value: string }).value)}
        >
          {experiments.map((entry) => (
            <option key={entry.experimentId} value={entry.experimentId}>
              {entry.experimentId}（{entry.runCount} 个 run）
            </option>
          ))}
        </select>
      </label>
      {experiment === null ? <p>正在读取实验数据…</p> : (
        <>
          <label>
            run
            <select value={runId ?? ""} onChange={(event: ChangeEvent<HTMLSelectElement>) => setRunId((event.target as unknown as { value: string }).value)}>
              {experiment.runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.runId}（{run.variant ?? "无变体"} · {run.status}）
                </option>
              ))}
            </select>
          </label>
          <h3>分组汇总</h3>
          <table>
            <thead>
              <tr><th>变体</th><th>脚本分支</th><th>指标</th><th>有效样本</th><th>无效样本</th><th>均值</th></tr>
            </thead>
            <tbody>
              {experiment.cells.flatMap((cell) => cell.metrics.map((metric) => (
                <tr key={`${cell.variant}/${cell.scriptBranch}/${metric.metric}`}>
                  <td>{cell.variant}</td>
                  <td>{cell.scriptBranch}</td>
                  <td>{metric.metric}</td>
                  <td>{metric.validSamples}{sampleNote(metric.validSamples, minimumSamplesForMean)}</td>
                  <td>{metric.invalidSamples}</td>
                  <td>{metricValue(metric.mean)}</td>
                </tr>
              )))}
            </tbody>
          </table>
          {reportError === null ? null : <p role="alert">读取 run 报告失败：{reportError}</p>}
          {report === null ? <p>该 run 没有可用报告。</p> : <RunReportPanel report={report} />}
        </>
      )}
    </section>
  );
}

/** 评估页面模块：只暴露只读页面端口，不注册任何写操作。 */
export function createEvaluationPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port = {
    title: "评估与对比",
    renderContribution: (): ReactNode => <EvaluationPage />,
  } satisfies BrowserViewPort & { readonly title: string };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
