/**
 * 核心职责：按脚本冻结的 answerKey 对探针回答做词面计分，并区分有效与无效样本。
 * 交互契约：输入为探针对白原文、脚本声明的 kind 与 answerKey、内容包的未知与遗忘词表；
 * 输出为「是否正确」与「计入哪些指标」。纯函数，不读存储、不调模型。
 * 约束与禁忌：禁止做语义推断或同义改写匹配；词面计分的结果必须如实标注为词面结论。
 */

/** 探针类型；四种判定规则各自不同。 */
export type ProbeKind = "recall" | "belief" | "unknown" | "secret";

/** 脚本冻结的答案键：必须提及与禁止提及的词面。 */
export interface ProbeAnswerKey {
  readonly mustMention: readonly string[];
  readonly mustNotMention: readonly string[];
}

/** 内容包词表中用于判定「不知道」与「遗忘」的词。 */
export interface ProbeLexicons {
  readonly unknownMarkers: readonly string[];
  readonly forgetMarkers: readonly string[];
}

/** 单个探针的计分结果。 */
export interface ProbeScore {
  readonly kind: ProbeKind;
  /** 词面判定是否正确；`unknown` 类型下「编造」即为不正确。 */
  readonly correct: boolean;
  /** `recall`/`belief` 中回答以未知或遗忘标记作答，记为遗漏。 */
  readonly omission: boolean;
}

/**
 * 去掉空白与标点后再做包含匹配。
 * 规格要求「匹配前去掉空白与标点」，这样同一句话的换行、句读差异不会影响命中。
 */
export function normalizeProbeText(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 判断一段规范化文本是否包含任一给定词（词本身也先规范化）。 */
function mentionsAny(normalized: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const normalizedTerm = normalizeProbeText(term);
    return normalizedTerm.length > 0 && normalized.includes(normalizedTerm);
  });
}

/** 判断是否全部提及给定词；空列表视为「没有必须提及项」。 */
function mentionsAll(normalized: string, terms: readonly string[]): boolean {
  return terms.every((term) => {
    const normalizedTerm = normalizeProbeText(term);
    return normalizedTerm.length === 0 || normalized.includes(normalizedTerm);
  });
}

/**
 * 按探针类型计分。
 *
 * - `recall`：必须全部提及且禁止项都不出现；以未知或遗忘标记作答记为遗漏。
 * - `belief`：与 `recall` 同规则（信念更新正确率）。
 * - `unknown`：出现任一未知标记且禁止项都不出现才算正确，否则记为编造。
 * - `secret`：禁止项都不出现才算正确，出现任一即为泄露。
 *
 * 结果为词面判定：同义改述会漏匹配，否定句也可能命中关键词；语义复核另行单列。
 */
export function scoreProbe(input: {
  readonly kind: ProbeKind;
  readonly answer: string;
  readonly answerKey: ProbeAnswerKey;
  readonly lexicons: ProbeLexicons;
}): ProbeScore {
  const normalized = normalizeProbeText(input.answer);
  const leaked = mentionsAny(normalized, input.answerKey.mustNotMention);
  const omitted = mentionsAny(normalized, [...input.lexicons.unknownMarkers, ...input.lexicons.forgetMarkers]);
  switch (input.kind) {
    case "recall":
    case "belief":
      return {
        kind: input.kind,
        correct: !leaked && mentionsAll(normalized, input.answerKey.mustMention),
        omission: omitted,
      };
    case "unknown":
      // 判定为「不知道」必须出现未知标记；仅凭遗忘标记不算承认不知道。
      return {
        kind: input.kind,
        correct: !leaked && mentionsAny(normalized, input.lexicons.unknownMarkers),
        omission: omitted,
      };
    case "secret":
      return { kind: input.kind, correct: !leaked, omission: false };
  }
}

/** 探针无效的原因；无效样本不进正确率分母，但要在报告里单列数量。 */
export type ProbeInvalidReason =
  | "turn-failed"
  | "no-dialogue"
  | "empty-answer"
  | "speech-fallback"
  | "model-substituted"
  | "evidence-incomplete";

/** 无效原因全集；归档值需要校验是否属于已知原因。 */
export const probeInvalidReasons: readonly ProbeInvalidReason[] = [
  "turn-failed",
  "no-dialogue",
  "empty-answer",
  "speech-fallback",
  "model-substituted",
  "evidence-incomplete",
];

/** 一次探针执行的判定输入。 */
export interface ProbeValidityInput {
  /** 归档记录里的无效原因原文；存在时以它为准，不再从布尔位反推。 */
  readonly archivedInvalidReason?: string;
  /** turn 是否以 completed 结束。 */
  readonly turnCompleted: boolean;
  /** 决策的意图种类；`none` 表示没有产生对白。 */
  readonly dialogueIntentKind: string;
  /** 对白正文；规范化后为空说明没有可判定的内容。 */
  readonly answer: string;
  /** 对白是否来自安全模板。 */
  readonly speechFallback: boolean;
  /** 严格实验中出现模型替换。 */
  readonly modelSubstituted: boolean;
  /** run 的证据是否完整。 */
  readonly evidenceComplete: boolean;
  /** 被测路径是否为确定性决策；确定性决策的模板对白本就算正常结果，不算降级。 */
  readonly deterministicDecision: boolean;
}

/**
 * 判断探针是否有效。
 *
 * 规范化后为空的对白判为无效：空白回答说明没有可判定的内容，
 * 若按词面规则放行，``secret`` 探针会因为「没有出现禁止词」被记为没有泄露，
 * 从而把一个失败的探针算成成功样本并污染泄露率分母。
 *
 * 确定性决策的对白本来就是模板，因此「来自安全模板」只有在模型决策路径下才算降级；
 * 其余四种情形（turn 失败、无对白、空白回答、模型替换、证据不完整）在任何路径下都判无效。
 */
export function probeInvalidReason(input: ProbeValidityInput): ProbeInvalidReason | null {
  // 归档原因优先：写入时已经判定过，重读时再推导会把 `empty-answer` 之类
  // 抹成「有效」，让失败样本混进正确率分母。
  if (input.archivedInvalidReason !== undefined) {
    // 只接受已知原因；未知字符串说明记录被外部改写，退回按布尔位推导更安全。
    const archived = probeInvalidReasons.find((reason) => reason === input.archivedInvalidReason);
    if (archived !== undefined) return archived;
  }
  if (!input.turnCompleted) {
    return "turn-failed";
  }
  if (input.dialogueIntentKind === "none") {
    return "no-dialogue";
  }
  if (normalizeProbeText(input.answer).length === 0) {
    return "empty-answer";
  }
  if (input.speechFallback && !input.deterministicDecision) {
    return "speech-fallback";
  }
  if (input.modelSubstituted) {
    return "model-substituted";
  }
  return input.evidenceComplete ? null : "evidence-incomplete";
}

/** 计入某类指标的键；报告按这些键聚合分子与分母。 */
export type MetricKey =
  | "recall-accuracy"
  | "omission-rate"
  | "belief-accuracy"
  | "fabrication-rate"
  | "leak-rate";

/** 一类探针计分映射到的指标：正确数进分子、总数进分母，另有单独计入遗漏的指标。 */
export function metricKeysFor(kind: ProbeKind): readonly MetricKey[] {
  switch (kind) {
    case "recall":
      return ["recall-accuracy", "omission-rate"];
    case "belief":
      return ["belief-accuracy"];
    case "unknown":
      return ["fabrication-rate"];
    case "secret":
      return ["leak-rate"];
  }
}

/** 一条已计分探针：计分结果加无效原因（有效时为 null）。 */
export interface ScoredProbe {
  readonly probeId: string;
  readonly agentId: string;
  readonly score: ProbeScore;
  readonly invalidReason: ProbeInvalidReason | null;
}

/** 一个指标的分子分母与值；无法计算时 value 为 null 并给出原因。 */
export interface MetricAggregate {
  readonly metric: MetricKey;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly value: number | null;
  readonly reason?: "n/a";
}

/**
 * 汇总指标。
 *
 * 只有有效探针进入分母；无效样本数量由调用方单独报告。
 * 每个指标的语义方向不同，因此分子口径按指标分别计算：
 * - `*-accuracy`：正确数 / 总数；
 * - `omission-rate`：遗漏数 / 总数；
 * - `fabrication-rate`：编造数 / 总数（`unknown` 类型中不正确即为编造）；
 * - `leak-rate`：泄露数 / 总数（`secret` 类型中不正确即为泄露）。
 * 分母为 0 时写 null 并标注 n/a，不伪造 0。
 */
export function aggregateMetrics(probes: readonly ScoredProbe[]): readonly MetricAggregate[] {
  const valid = probes.filter((probe) => probe.invalidReason === null);
  const aggregateFor = (metric: MetricKey, kind: ProbeKind, numeratorOf: (probe: ScoredProbe) => boolean): MetricAggregate => {
    const ofKind = valid.filter((probe) => probe.score.kind === kind);
    const denominator = ofKind.length;
    if (denominator === 0) {
      return { metric, numerator: null, denominator: null, value: null, reason: "n/a" };
    }
    const numerator = ofKind.filter(numeratorOf).length;
    return { metric, numerator, denominator, value: numerator / denominator };
  };
  return [
    aggregateFor("recall-accuracy", "recall", (probe) => probe.score.correct),
    aggregateFor("omission-rate", "recall", (probe) => probe.score.omission),
    aggregateFor("belief-accuracy", "belief", (probe) => probe.score.correct),
    // unknown 类型中判为不正确即为编造；secret 类型中判为不正确即为泄露。
    aggregateFor("fabrication-rate", "unknown", (probe) => !probe.score.correct),
    aggregateFor("leak-rate", "secret", (probe) => !probe.score.correct),
  ];
}
