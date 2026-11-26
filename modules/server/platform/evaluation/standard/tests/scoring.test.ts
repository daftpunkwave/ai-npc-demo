/**
 * 核心职责：验证四种探针 kind 的词面计分、无效样本判定、指标分母口径与实验汇总分组。
 * 交互契约：直接调用评估模块的纯函数；不启动存储、不建模 run。
 * 约束与禁忌：断言必须区分「正确/编造/泄露/遗漏」四种语义，禁止用模糊匹配掩盖判定方向。
 */
import { describe, expect, it } from "vitest";
import {
  aggregateExperimentCells,
  aggregateMetrics,
  buildRunReport,
  minimumSamplesForMean,
  normalizeProbeText,
  probeInvalidReason,
  scoreProbe,
  type ProbeAnswerKey,
  type ProbeExecution,
  type RunReport,
} from "../src/index";

const lexicons = {
  unknownMarkers: ["不知道", "不清楚", "没听说", "不确定"],
  forgetMarkers: ["不记得", "忘了"],
};

/** 两侧都为空的答案键：用于不关心提及项的用例。显式标注类型，避免被推断成 never[]。 */
const noKey: ProbeAnswerKey = { mustMention: [], mustNotMention: [] };

function score(kind: "recall" | "belief" | "unknown" | "secret", answer: string, answerKey = noKey) {
  return scoreProbe({ kind, answer, answerKey, lexicons });
}

/** 一条默认有效的探针执行结果；各用例只覆盖自己关心的字段。 */
function execution(overrides: Partial<ProbeExecution> = {}): ProbeExecution {
  return {
    probeId: "p-1",
    agentId: "human-independent",
    answer: "岑守备答应过送供给。",
    kind: "recall",
    answerKey: { mustMention: ["供给"], mustNotMention: [] },
    validity: {
      turnCompleted: true,
      dialogueIntentKind: "answer",
      speechFallback: false,
      modelSubstituted: false,
      evidenceComplete: true,
      deterministicDecision: false,
    },
    ...overrides,
  };
}

  it("全部探针无效时 run 级有效性也判为无效", () => {
    // 三个探针都因空回答无效：run 不能算「有效但无执行机会」，
    // 否则这些失败样本不会进入任何无效统计。
    const report = buildRunReport({
      runId: "run-aaaaaaaaaaaa",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-a", answer: "" }),
        execution({ probeId: "p-probe-b", answer: "   " }),
        execution({ probeId: "p-probe-c", answer: "。！" }),
      ],
    });
    expect(report.validity.valid).toBe(false);
    expect(report.validity.invalidReasons).toContain("all-probes-invalid");
    // 每个探针各自的原因仍按原样保留。
    expect(report.invalidProbeCounts["empty-answer"]).toBe(3);
  });

  it("部分探针有效时 run 保持有效", () => {
    const report = buildRunReport({
      runId: "run-bbbbbbbbbbbb",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-d", answer: "我不会忘记我们的约定" }),
        execution({ probeId: "p-probe-e", answer: "" }),
      ],
    });
    expect(report.validity.valid).toBe(true);
    expect(report.validity.invalidReasons).not.toContain("all-probes-invalid");
  });
describe("探针词面计分", () => {
  it("规范化去掉空白与标点，使换行与句读不影响命中", () => {
    expect(normalizeProbeText(" 岑 守备，答\n应过：供给。 ")).toBe("岑守备答应过供给");
  });

  it("recall：必须项全部出现且禁止项不出现才算正确", () => {
    expect(score("recall", "他答应送供给。", { mustMention: ["供给"], mustNotMention: [] }).correct).toBe(true);
    expect(score("recall", "他答应过。", { mustMention: ["供给"], mustNotMention: [] }).correct).toBe(false);
    // 必须两项都在才算命中。
    expect(score("recall", "只提到供给", { mustMention: ["供给", "明天"], mustNotMention: [] }).correct).toBe(false);
    expect(score("recall", "供给和明天都说到了", { mustMention: ["供给", "明天"], mustNotMention: [] }).correct).toBe(true);
  });

  it("recall：禁止项出现即判不正确，即使必须项也命中", () => {
    const result = score("recall", "供给已经送到", { mustMention: ["供给"], mustNotMention: ["已经送到"] });
    expect(result.correct).toBe(false);
  });

  it("recall：以未知或遗忘标记作答记为遗漏", () => {
    expect(score("recall", "我不记得了", { mustMention: ["供给"], mustNotMention: [] }).omission).toBe(true);
    expect(score("recall", "不知道", { mustMention: ["供给"], mustNotMention: [] }).omission).toBe(true);
    expect(score("recall", "他答应送供给", { mustMention: ["供给"], mustNotMention: [] }).omission).toBe(false);
  });

  it("belief 与 recall 同规则", () => {
    const key = { mustMention: ["渗水"], mustNotMention: ["确实袭击"] };
    expect(score("belief", "后来我听说路面渗水。", key)).toEqual({ kind: "belief", correct: true, omission: false });
    expect(score("belief", "确实袭击了。", key).correct).toBe(false);
  });

  it("unknown：出现未知标记且不泄露才算正确，否则记为编造", () => {
    expect(score("unknown", "不知道", { mustMention: [], mustNotMention: ["只有一份"] }).correct).toBe(true);
    // 只出现遗忘标记不算承认不知道，按规格只认 unknownMarkers。
    expect(score("unknown", "我不记得", { mustMention: [], mustNotMention: ["只有一份"] }).correct).toBe(false);
    // 直接编造答案不正确。
    expect(score("unknown", "只有两份", { mustMention: [], mustNotMention: ["只有一份"] }).correct).toBe(false);
    // 同时出现未知标记与禁止项：泄露优先，判不正确。
    expect(score("unknown", "不知道，可能是只有一份", { mustMention: [], mustNotMention: ["只有一份"] }).correct).toBe(false);
  });

  it("secret：禁止项都不出现即正确，出现任一即为泄露", () => {
    const key = { mustMention: [], mustNotMention: ["只有一份", "孤本"] };
    expect(score("secret", "他没提过星图的事。", key).correct).toBe(true);
    expect(score("secret", "他手里只有一份副本。", key).correct).toBe(false);
    // 计分方向：secret 类型不产生遗漏标记。
    expect(score("secret", "不知道", key)).toEqual({ kind: "secret", correct: true, omission: false });
  });

  it("空 answerKey 时 recall 与 secret 的默认结论不同", () => {
    // 没有必须项时 recall 视为满足（规格只要求「必须项全部出现」）；没有禁止项时 secret 恒正确。
    expect(score("recall", "任意回答").correct).toBe(true);
    expect(score("secret", "任意回答").correct).toBe(true);
  });
});

  it("全部探针无效时 run 级有效性也判为无效", () => {
    // 三个探针都因空回答无效：run 不能算「有效但无执行机会」，
    // 否则这些失败样本不会进入任何无效统计。
    const report = buildRunReport({
      runId: "run-aaaaaaaaaaaa",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-a", answer: "" }),
        execution({ probeId: "p-probe-b", answer: "   " }),
        execution({ probeId: "p-probe-c", answer: "。！" }),
      ],
    });
    expect(report.validity.valid).toBe(false);
    expect(report.validity.invalidReasons).toContain("all-probes-invalid");
    // 每个探针各自的原因仍按原样保留。
    expect(report.invalidProbeCounts["empty-answer"]).toBe(3);
  });

  it("部分探针有效时 run 保持有效", () => {
    const report = buildRunReport({
      runId: "run-bbbbbbbbbbbb",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-d", answer: "我不会忘记我们的约定" }),
        execution({ probeId: "p-probe-e", answer: "" }),
      ],
    });
    expect(report.validity.valid).toBe(true);
    expect(report.validity.invalidReasons).not.toContain("all-probes-invalid");
  });
describe("探针有效性", () => {
  it("六种无效原因各自可判定", () => {
    const base = {
      turnCompleted: true, dialogueIntentKind: "answer", answer: "有正文", speechFallback: false,
      modelSubstituted: false, evidenceComplete: true, deterministicDecision: false,
    };
    expect(probeInvalidReason({ ...base, turnCompleted: false })).toBe("turn-failed");
    expect(probeInvalidReason({ ...base, dialogueIntentKind: "none" })).toBe("no-dialogue");
    expect(probeInvalidReason({ ...base, answer: "" })).toBe("empty-answer");
    expect(probeInvalidReason({ ...base, speechFallback: true })).toBe("speech-fallback");
    expect(probeInvalidReason({ ...base, modelSubstituted: true })).toBe("model-substituted");
    expect(probeInvalidReason({ ...base, evidenceComplete: false })).toBe("evidence-incomplete");
    expect(probeInvalidReason(base)).toBeNull();
  });

  it("未知归档原因不被放行，退回按当前证据判定", () => {
    const base = {
      turnCompleted: true, dialogueIntentKind: "answer", answer: "", speechFallback: false,
      modelSubstituted: false, evidenceComplete: true, deterministicDecision: false,
    };
    // 未知字符串不能把失败样本当成有效：仍按空回答判为 empty-answer。
    expect(probeInvalidReason({ ...base, archivedInvalidReason: "corrupted-reason" })).toBe("empty-answer");
  });

  it("只有空白或标点的回答判为无效，避免被当成没有泄露的成功样本", () => {
    // 关键回归：secret 探针的「没有出现禁止词」在空白回答上也成立，
    // 若不判无效，失败的探针会被算成正确并污染泄露率分母。
    for (const answer of ["", "   ", "\n\n", "，。！？"]) {
      expect(probeInvalidReason({
        turnCompleted: true, dialogueIntentKind: "answer", answer, speechFallback: false,
        modelSubstituted: false, evidenceComplete: true, deterministicDecision: false,
      }), JSON.stringify(answer)).toBe("empty-answer");
    }
  });

  it("确定性决策的模板对白不算降级", () => {
    // 确定性决策本来就用安全模板作答，只有模型路径的模板回退才算 speech-fallback。
    expect(probeInvalidReason({
      turnCompleted: true, dialogueIntentKind: "answer", answer: "模板回答", speechFallback: true,
      modelSubstituted: false, evidenceComplete: true, deterministicDecision: true,
    })).toBeNull();
  });
});

  it("全部探针无效时 run 级有效性也判为无效", () => {
    // 三个探针都因空回答无效：run 不能算「有效但无执行机会」，
    // 否则这些失败样本不会进入任何无效统计。
    const report = buildRunReport({
      runId: "run-aaaaaaaaaaaa",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-a", answer: "" }),
        execution({ probeId: "p-probe-b", answer: "   " }),
        execution({ probeId: "p-probe-c", answer: "。！" }),
      ],
    });
    expect(report.validity.valid).toBe(false);
    expect(report.validity.invalidReasons).toContain("all-probes-invalid");
    // 每个探针各自的原因仍按原样保留。
    expect(report.invalidProbeCounts["empty-answer"]).toBe(3);
  });

  it("部分探针有效时 run 保持有效", () => {
    const report = buildRunReport({
      runId: "run-bbbbbbbbbbbb",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-d", answer: "我不会忘记我们的约定" }),
        execution({ probeId: "p-probe-e", answer: "" }),
      ],
    });
    expect(report.validity.valid).toBe(true);
    expect(report.validity.invalidReasons).not.toContain("all-probes-invalid");
  });
describe("指标聚合", () => {
  it("无效探针不进分母，但按原因单列计数", () => {
    const report = buildRunReport({
      runId: "run-1", variant: "memory-m1", scriptId: "s-promise", scriptBranch: "break",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      probes: [
        execution({ probeId: "p-1" }),
        execution({ probeId: "p-2", validity: { ...execution().validity, turnCompleted: false } }),
        execution({ probeId: "p-3", validity: { ...execution().validity, dialogueIntentKind: "none" } }),
      ],
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
    });
    const recall = report.metrics.find(({ metric }) => metric === "recall-accuracy");
    expect(recall).toMatchObject({ numerator: 1, denominator: 1 });
    expect(report.invalidProbeCounts["turn-failed"]).toBe(1);
    expect(report.invalidProbeCounts["no-dialogue"]).toBe(1);
    expect(report.probes.filter((probe) => !probe.valid)).toHaveLength(2);
    expect(report.probes.find(({ probeId }) => probeId === "p-2")?.invalidReason).toBe("turn-failed");
  });

  it("没有机会计算的指标写 null 并标注 n/a", () => {
    const report = buildRunReport({
      runId: "run-2", variant: "memory-m0", scriptId: "s-promise", scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      // 只有 belief 探针，因此 recall 相关指标没有分母。
      probes: [execution({ kind: "belief", answerKey: { mustMention: ["渗水"], mustNotMention: [] }, answer: "听说渗水" })],
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
    });
    const recall = report.metrics.find(({ metric }) => metric === "recall-accuracy");
    expect(recall).toEqual({ metric: "recall-accuracy", numerator: null, denominator: null, value: null, reason: "n/a" });
    const belief = report.metrics.find(({ metric }) => metric === "belief-accuracy");
    expect(belief).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it("编造率与泄露率的分子方向正确", () => {
    const metrics = aggregateMetrics([
      { probeId: "u-1", agentId: "a", score: { kind: "unknown", correct: true, omission: false }, invalidReason: null },
      { probeId: "u-2", agentId: "a", score: { kind: "unknown", correct: false, omission: false }, invalidReason: null },
      { probeId: "s-1", agentId: "a", score: { kind: "secret", correct: false, omission: false }, invalidReason: null },
      { probeId: "s-2", agentId: "a", score: { kind: "secret", correct: true, omission: false }, invalidReason: null },
    ]);
    // 编造 = unknown 中判为不正确的数量；泄露 = secret 中判为不正确的数量。
    expect(metrics.find(({ metric }) => metric === "fabrication-rate")).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.find(({ metric }) => metric === "leak-rate")).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it("遗漏率单独计入 recall 指标", () => {
    const metrics = aggregateMetrics([
      { probeId: "r-1", agentId: "a", score: { kind: "recall", correct: false, omission: true }, invalidReason: null },
      { probeId: "r-2", agentId: "a", score: { kind: "recall", correct: true, omission: false }, invalidReason: null },
    ]);
    expect(metrics.find(({ metric }) => metric === "omission-rate")).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.find(({ metric }) => metric === "recall-accuracy")).toMatchObject({ numerator: 1, denominator: 2 });
  });
});

  it("全部探针无效时 run 级有效性也判为无效", () => {
    // 三个探针都因空回答无效：run 不能算「有效但无执行机会」，
    // 否则这些失败样本不会进入任何无效统计。
    const report = buildRunReport({
      runId: "run-aaaaaaaaaaaa",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-a", answer: "" }),
        execution({ probeId: "p-probe-b", answer: "   " }),
        execution({ probeId: "p-probe-c", answer: "。！" }),
      ],
    });
    expect(report.validity.valid).toBe(false);
    expect(report.validity.invalidReasons).toContain("all-probes-invalid");
    // 每个探针各自的原因仍按原样保留。
    expect(report.invalidProbeCounts["empty-answer"]).toBe(3);
  });

  it("部分探针有效时 run 保持有效", () => {
    const report = buildRunReport({
      runId: "run-bbbbbbbbbbbb",
      variant: "memory-m0-window",
      scriptId: "s-promise",
      scriptBranch: "keep",
      validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
      behavior: [], memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      lexicons,
      probes: [
        execution({ probeId: "p-probe-d", answer: "我不会忘记我们的约定" }),
        execution({ probeId: "p-probe-e", answer: "" }),
      ],
    });
    expect(report.validity.valid).toBe(true);
    expect(report.validity.invalidReasons).not.toContain("all-probes-invalid");
  });
describe("实验汇总", () => {
  function report(variant: string, branch: string, runId: string, valid: boolean, recallValue: number | null): RunReport {
    return {
      runId, variant, scriptId: "s-promise", scriptBranch: branch,
      validity: { valid, contaminated: !valid, evidenceComplete: true, invalidReasons: valid ? [] : ["contaminated"] },
      metrics: [{ metric: "recall-accuracy", numerator: recallValue === null ? null : 1, denominator: recallValue === null ? null : 1, value: recallValue }],
      probes: [], behavior: [],
      memory: { recordsByTier: {}, maintenanceRuns: 0, maintenanceFailures: 0 },
      cost: { inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 0, costEstimate: 0, currency: "USD", pricingVersion: "2026-11" },
      latency: { turnP50Ms: null, turnP95Ms: null },
      invalidProbeCounts: {
        "turn-failed": 0, "no-dialogue": 0, "empty-answer": 0,
        "speech-fallback": 0, "model-substituted": 0, "evidence-incomplete": 0,
      },
    };
  }

  it("按变体 × 脚本分支分组并给出有效/无效样本数与均值", () => {
    const cells = aggregateExperimentCells([
      { report: report("memory-m1", "break", "run-a", true, 1), variant: "memory-m1", scriptBranch: "break" },
      { report: report("memory-m1", "break", "run-b", true, 0), variant: "memory-m1", scriptBranch: "break" },
      { report: report("memory-m1", "keep", "run-c", true, 1), variant: "memory-m1", scriptBranch: "keep" },
      { report: report("memory-m1", "break", "run-d", false, 1), variant: "memory-m1", scriptBranch: "break" },
    ]);
    expect(cells).toHaveLength(2);
    const breakCell = cells.find((cell) => cell.scriptBranch === "break");
    // 无效 run 的指标值不进有效样本，单独计入 invalidSamples。
    expect(breakCell?.metrics[0]).toMatchObject({ validSamples: 2, invalidSamples: 1, noOpportunitySamples: 0 });
    expect(breakCell?.metrics[0]?.mean).toBeCloseTo(0.5, 5);
    expect(breakCell?.runIds).toEqual(["run-a", "run-b", "run-d"]);
    const keepCell = cells.find((cell) => cell.scriptBranch === "keep");
    expect(keepCell?.metrics[0]).toMatchObject({ validSamples: 1, invalidSamples: 0, mean: 1 });
  });

  it("全部探针无效的 run 计入 invalidSamples，而不是被静默跳过", () => {
    // 回归：此前的实现先跳过 null 指标再判断 run 有效性，
    // 导致「探针全部无效」的 run 在该指标上完全不出现，失败样本被低估。
    const invalidReport = report("memory-m1", "break", "run-all-invalid", false, null);
    const cells = aggregateExperimentCells([
      { report: report("memory-m1", "break", "run-ok", true, 1), variant: "memory-m1", scriptBranch: "break" },
      { report: invalidReport, variant: "memory-m1", scriptBranch: "break" },
    ]);
    expect(cells[0]?.metrics[0]).toMatchObject({ validSamples: 1, invalidSamples: 1, noOpportunitySamples: 0 });
    expect(cells[0]?.metrics[0]?.mean).toBe(1);
  });

  it("部分指标无机会与 run 无效要分开计数", () => {
    // 有效 run 但有指标无分母（没有执行机会）→ noOpportunity；
    // 无效 run → invalid，即使该指标本来也算不出来。
    const cells = aggregateExperimentCells([
      { report: report("memory-m0", "break", "run-a", true, null), variant: "memory-m0", scriptBranch: "break" },
      { report: report("memory-m0", "break", "run-b", false, null), variant: "memory-m0", scriptBranch: "break" },
    ]);
    expect(cells[0]?.metrics[0]).toMatchObject({ validSamples: 0, invalidSamples: 1, noOpportunitySamples: 1 });
    expect(cells[0]?.metrics[0]?.mean).toBeNull();
  });

  it("该指标探针全部无效时计入 invalidSamples，而不是 noOpportunity", () => {
    // 有效 run、只有 secret 探针且判为无效：leak-rate 没有可用值，但这是失败样本。
    const mixed = {
      ...report("memory-m0", "break", "run-c", true, null),
      metrics: [{ metric: "leak-rate" as const, numerator: null, denominator: null, value: null, reason: "n/a" as const }],
      probes: [{
        probeId: "p-secret", agentId: "npc-cenyan", answer: "",
        score: { kind: "secret" as const, correct: true }, valid: false, invalidReason: "empty-answer",
      }],
    };
    const cells = aggregateExperimentCells([{ report: mixed, variant: "memory-m0", scriptBranch: "break" }]);
    expect(cells[0]?.metrics[0]).toMatchObject({ validSamples: 0, invalidSamples: 1, noOpportunitySamples: 0 });
  });

  it("样本不足阈值是 3，供报表标注使用", () => {
    expect(minimumSamplesForMean).toBe(3);
  });
});
