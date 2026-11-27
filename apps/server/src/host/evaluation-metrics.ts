/**
 * 核心职责：从归档行聚合 run 报告的各项指标：成本、turn 时长与延迟、记忆分层、行为记录，
 * 以及行为记录需要的 artifact 正文、触发器种类与命令类型查询。
 * 交互契约：输入已读取的行集合与必要的存储事务，返回控制台报告字段；缺失字段按契约回退，不编造值。
 * 以文件存放的 artifact 正文由调用方在事务外预先装载后传入。行为记录只收外部输入触发的决策，
 * 探针、调试、巡检与预期提醒这类内部唤醒不计入。
 * 约束与禁忌：不执行查询以外的工作、不写存储、不在事务内读取文件，也不为缺失的触发器或立场填默认值。
 */
import type { Json, StorageTransaction } from "@world-prism/contracts";
import type {
  ReportBehavior,
  ReportCost,
  ReportLatency,
  ReportMemory,
} from "./module-catalog";
import { jsonCell, numberCell, stringCell } from "./evaluation-row-codec";

/** 成本快照：从预算账本聚合；未结算的尝试按预留值计入，未知 usage 的尝试数一并给出。 */
export function costOf(input: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly pricingVersion: string;
}): ReportCost {
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownUsageAttempts = 0;
  let costEstimate = 0;
  let currency = "USD";
  for (const row of input.rows) {
    // 未结算的行用预留值兜底；结算后 actual_* 才是真实 usage。
    inputTokens += numberCell(row, "actual_input", numberCell(row, "reserved_input", 0));
    outputTokens += numberCell(row, "actual_output", numberCell(row, "reserved_output", 0));
    if (numberCell(row, "usage_unknown", 0) !== 0) unknownUsageAttempts += 1;
    costEstimate += numberCell(row, "cost_estimate", 0);
    const rowCurrency = stringCell(row, "currency");
    if (rowCurrency !== null) currency = rowCurrency;
  }
  return { inputTokens, outputTokens, unknownUsageAttempts, costEstimate, currency, pricingVersion: input.pricingVersion };
}

/**
 * 从 turn 的 `started_at` 与 `ended_at` 计算每次 turn 的时长（毫秒）。
 *
 * 只有两列都存在且能解析成时间、且结束不早于开始的 turn 才计入样本；
 * 未开始、未结束或时间戳异常时跳过，而不是用 0 充数——0 会把延迟曲线压低。
 */
export function turnDurationsOf(turns: readonly Readonly<Record<string, unknown>>[]): readonly number[] {
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
export function latencyOf(durationsMs: readonly number[]): ReportLatency {
  if (durationsMs.length === 0) return { turnP50Ms: null, turnP95Ms: null };
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const percentile = (ratio: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
    return sorted[index] ?? 0;
  };
  return { turnP50Ms: percentile(0.5), turnP95Ms: percentile(0.95) };
}

/** 记忆快照：按层级统计活动记录数与维护运行次数。 */
export function memoryOf(input: {
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly maintenance: readonly Readonly<Record<string, unknown>>[];
}): ReportMemory {
  const recordsByTier: Record<string, number> = {};
  for (const row of input.records) {
    // memory_records 是 append-only 行版本表；只有 active 行代表当前仍可见的记忆。
    if (stringCell(row, "status") !== "active") continue;
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
 * 行为记录：从 turn 归档的 decision artifact 与其真实触发器提取立场、理由类别与提交的命令。
 *
 * 字段都不允许填默认值：
 * - `trigger` 按 `trigger_ids_json` 的第一条 ID 查 `triggers.kind`；
 * - `stance` 与 `reasonCode` 从 decision artifact 的 `decision`/`dialogueIntent` 读取；
 * - `commands` 从 `turn.tool` 阶段归档的回执 ID 反查 `command_receipts.command_type`。
 * 任一必需字段缺失就整条跳过：编造一个触发器或立场会让报告声称发生过没发生的事情。
 */
/**
 * 不属于外部输入的唤醒种类：探针与调试是测量和排障手段，巡检与预期提醒是 Agent 按自身节奏的定时唤醒。
 * 行为记录用来比较各组对脚本外部输入的反应（评估文档第 8 节「行为记录」），这些 turn 混入会污染各组的行为分布。
 */
const nonExternalTriggerKinds: ReadonlySet<string> = new Set(["probe", "debug", "patrol", "prospective"]);

export function behaviorOf(input: {
  readonly tx: StorageTransaction;
  readonly turns: readonly Readonly<Record<string, unknown>>[];
  /** 事务外预先装载的文件存放 artifact 正文，键为 artifact ID。 */
  readonly fileBodies: ReadonlyMap<string, string>;
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
    const effective = stage["effective"];
    const artifactId = typeof effective === "object" && effective !== null && !Array.isArray(effective)
      ? (effective as Readonly<Record<string, Json>>)["artifactId"]
      : null;
    if (typeof artifactId !== "string") continue;
    const archived = artifactValue(input.tx, artifactId, input.fileBodies);
    if (archived === null || typeof archived !== "object" || Array.isArray(archived)) continue;
    const decision = (archived as Readonly<Record<string, Json>>)["decision"];
    if (typeof decision !== "object" || decision === null || Array.isArray(decision)) continue;
    const decisionRecord = decision as Readonly<Record<string, Json>>;
    const intent = decisionRecord["dialogueIntent"];
    const reasonCode = typeof intent === "object" && intent !== null && !Array.isArray(intent)
      ? (intent as Readonly<Record<string, Json>>)["reasonCode"]
      : null;
    const stance = decisionRecord["stance"];
    const triggerId = firstTriggerId(turn);
    if (typeof stance !== "string" || typeof reasonCode !== "string" || triggerId === null) continue;
    const branchId = stringCell(turn, "branch_id");
    const agentId = stringCell(turn, "agent_id");
    if (branchId === null || agentId === null) continue;
    const trigger = triggerKindOf(input.tx, branchId, triggerId);
    if (trigger === null || nonExternalTriggerKinds.has(trigger)) continue;
    behavior.push({
      atTick: numberCell(turn, "created_tick", 0),
      agentId,
      trigger,
      stance,
      reasonCode,
      commands: commandTypesOf({ tx: input.tx, branchId, agentId, stages }),
    });
  }
  return behavior;
}

/**
 * 读取 decision artifact 的解码后正文；引用失效、文件正文未预先装载或内容不是 JSON 时返回 null。
 * 文件存放的正文只从 fileBodies 取：本函数在报告的只读事务内运行，不能做文件 I/O。
 */
export function artifactValue(
  tx: StorageTransaction,
  artifactId: string,
  fileBodies: ReadonlyMap<string, string>,
): Json | null {
  const row = tx.rows("artifacts").get({ artifact_id: artifactId });
  if (row === null) return null;
  const body = row["body"];
  const text = row["storage"] === "file"
    ? fileBodies.get(artifactId) ?? null
    : typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : null;
  if (text === null) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/** 取 turn 的第一条触发器 ID；没有触发器时返回 null。 */
export function firstTriggerId(turn: Readonly<Record<string, unknown>>): string | null {
  const triggers = jsonCell(turn, "trigger_ids_json");
  if (!Array.isArray(triggers)) return null;
  const first = triggers[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** 按触发器 ID 读取 `triggers.kind`；记录缺失时返回 null，调用方跳过该行为样本。 */
export function triggerKindOf(tx: StorageTransaction, branchId: string, triggerId: string): string | null {
  const row = tx.branch(branchId).table("triggers").get({ trigger_id: triggerId });
  return row === null ? null : stringCell(row, "kind");
}

/** 从 `turn.tool` 阶段归档的回执 ID 反查命令类型；同一 turn 内去重。 */
export function commandTypesOf(input: {
  readonly tx: StorageTransaction;
  readonly branchId: string;
  readonly agentId: string;
  readonly stages: readonly Json[];
}): readonly string[] {
  const receiptIds = new Set<string>();
  for (const stage of input.stages) {
    if (typeof stage !== "object" || stage === null || Array.isArray(stage)) continue;
    if ((stage as Readonly<Record<string, Json>>)["stage"] !== "turn.tool") continue;
    const effective = (stage as Readonly<Record<string, Json>>)["effective"];
    if (typeof effective !== "object" || effective === null || Array.isArray(effective)) continue;
    const receiptId = (effective as Readonly<Record<string, Json>>)["receiptId"];
    if (typeof receiptId === "string") receiptIds.add(receiptId);
  }
  if (receiptIds.size === 0) return [];
  const rows = input.tx.branch(input.branchId).table("command_receipts").list({ principal_id: input.agentId });
  const types = new Set<string>();
  for (const row of rows) {
    const type = stringCell(row, "command_type");
    const receipt = jsonCell(row, "receipt_json");
    const receiptId = typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
      ? (receipt as Readonly<Record<string, Json>>)["receiptId"]
      : null;
    if (type !== null && typeof receiptId === "string" && receiptIds.has(receiptId)) types.add(type);
  }
  return [...types];
}
