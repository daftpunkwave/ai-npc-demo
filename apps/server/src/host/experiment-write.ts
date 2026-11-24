/**
 * 核心职责：承接研究员的实验创建请求，按规格展开为多次 run 并逐个创建，返回实验标识与 run 列表。
 * 交互契约：依赖实验规格加载与展开、内容包与名册校验、以及单 run 创建端口；
 * 展开结果里的实验标识与变体/脚本分支一并写入每个 RunSpec，供评估读取按显式字段归组。
 * 约束与禁忌：只创建 run 记录，不启动执行、不推进时钟；规格本身不合法时在创建任何 run 之前失败。
 */
import { DomainError } from "@ai-npc/contracts";
import {
  experimentSpecSchema,
  expandExperimentRuns,
  loadExperimentSpec,
  validateExperimentSpec,
  type ConfigLoadContext,
  type ContentPack,
  type ExperimentSpec,
  type LoadedConfig,
  type Roster,
  type RunSpec,
} from "@ai-npc/experiment";
import { createRun, type RunCreateResult, type RunWriteInput } from "./run-write";

/** 实验创建的输入。 */
export interface ExperimentWriteInput {
  readonly content: ContentPack;
  /** 按引用加载名册；校验必须用规格自己声明的名册，不能用在线名册代替。 */
  readonly loadRoster: (rosterRef: string) => LoadedConfig<Roster>;
  readonly loadContext: ConfigLoadContext;
  /** 单 run 创建的依赖；实验创建复用同一套预检与冻结逻辑。 */
  readonly runWrite: RunWriteInput;
}

/** run 生命周期状态；实验重放必须回传记录里的真实状态，不能统一改写为 ready。 */
export type ExperimentRunStatus =
  | "created"
  | "preflight-failed"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "invalid";

const experimentRunStatuses = new Set<ExperimentRunStatus>([
  "created", "preflight-failed", "ready", "running", "paused", "completed", "failed", "invalid",
]);

/** 实验创建结果：实验标识、创建出的 run 与逐条预检失败原因。 */
export interface ExperimentCreateResult {
  readonly experimentId: string;
  readonly runIds: readonly string[];
  /** 与 runIds 一一对应的逐个创建/重放结果；失败项带逐条原因。 */
  readonly runs: readonly {
    readonly runId: string;
    readonly status: ExperimentRunStatus;
    readonly errors: readonly { readonly code: string; readonly message: string; readonly path: string }[];
  }[];
  /** 预检失败的 run 数量；为 0 表示全部就绪。 */
  readonly failedRunCount: number;
}

/** 同一进程内按实验串行化创建，避免并发请求在幂等检查与落库之间重复建 run。 */
const pendingExperiments = new Map<string, Promise<ExperimentCreateResult>>();

/**
 * 把实验规格展开为具体的 RunSpec 列表。
 *
 * 展开本身是纯函数 `expandExperimentRuns` 的直接应用：变体补丁、脚本分支、重复次数与 seed 都在那里确定。
 * 这里只把展开结果与模板合成完整 RunSpec，并写入实验标识——评估读取据此归组，不再从 `seed` 文本推断。
 */
export function runsOfExperiment(spec: ExperimentSpec): readonly RunSpec[] {
  return expandExperimentRuns(spec).map((run) => {
    const branchSuffix = run.scriptBranch === null ? "" : `-${run.scriptBranch}`;
    return {
      // 模板省略了 schemaVersion（与 id/variant/script 一样由实验决定），这里补回完整 RunSpec。
      schemaVersion: 1 as const,
      ...spec.base,
      id: `${spec.experimentId}-${run.variantId}-r${run.repetition}${branchSuffix}`,
      experimentId: spec.experimentId,
      seed: run.seed,
      variant: {
        id: run.variantId,
        profilePatchRefs: [...run.profilePatchRefs],
        agentIds: null,
      },
      script: run.scriptBranch === null
        ? { scriptRef: spec.scriptRef }
        : { scriptRef: spec.scriptRef, branch: run.scriptBranch },
    };
  });
}

/**
 * 创建实验：加载并校验规格，展开为 run，逐个走单 run 的预检与创建。
 *
 * 规格校验在创建任何 run 之前完成——规格本身不合法时不该留下半套 run。
 * 单个 run 的预检失败不中断后续创建，但会逐条报告：一个变体的配置问题
 * 不应掩盖其他变体同样需要修正的信息。
 */
/**
 * 单个实验允许展开的 run 上限。
 *
 * 展开数量由用户输入决定（变体 × 脚本分支 × 重复次数），不设上限时一次请求
 * 就能要求创建任意多份 run，既拖垮存储也会让响应体无界增长。
 */
export const maxRunsPerExperiment = 200;

export async function createExperiment(
  input: ExperimentWriteInput,
  request: { readonly experimentSpec: unknown } | { readonly experimentRef: string },
): Promise<ExperimentCreateResult> {
  const spec = resolveSpec(input, request);
  // 名册按规格自己的 `base.rosterRef` 加载：用在线名册会拒绝有效实验，
  // 也会让校验通过但 manifest 冻结的名册与规格不一致。
  try {
    validateExperimentSpec(spec, input.content, input.loadRoster(spec.base.rosterRef).value, input.loadContext);
  } catch (error) {
    // 规格交叉校验失败是调用方输入问题，映射为 validation；
    // 否则会被当成内部故障，调用方拿不到可修正的信息。
    throw new DomainError("validation", `实验规格校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
  // 先算规模再展开：变体 × 分支 × 重复可以先相乘，避免为了发现超限而真的构造出巨大数组。
  const branchCount = Math.max(1, spec.scriptBranches.length);
  const planned = spec.variants.length * branchCount * spec.repetitions;
  if (!Number.isSafeInteger(planned) || planned > maxRunsPerExperiment) {
    throw new DomainError(
      "validation",
      `实验将展开出 ${planned} 个 run，超过单次上限 ${maxRunsPerExperiment}`,
    );
  }
  const runSpecs = runsOfExperiment(spec);
  // 同一进程内的并发创建按实验串行化：两个请求都在对方落库前看到空集时，
  // 只有先进入者会创建，后来者等待并复用同一结果。
  const key = `${input.runWrite.worldId}:${spec.experimentId}`;
  const pending = pendingExperiments.get(key);
  if (pending !== undefined) return pending;
  const task = createExperimentOnce(input, spec, runSpecs);
  pendingExperiments.set(key, task);
  try {
    return await task;
  } finally {
    pendingExperiments.delete(key);
  }
}

/** 幂等与创建的实际执行体；调用方已按实验串行化。 */
async function createExperimentOnce(
  input: ExperimentWriteInput,
  spec: ExperimentSpec,
  runSpecs: readonly RunSpec[],
): Promise<ExperimentCreateResult> {
  const existing = existingRunsOf(input, spec.experimentId);
  const bySpecId = new Map<string, ExistingRun>();
  const legacy: ExistingRun[] = [];
  for (const run of existing) {
    if (run.specId === null) legacy.push(run);
    else bySpecId.set(run.specId, run);
  }
  // 旧记录的 RunSpec 没有 id 时无法按展开结果对账，保持“已有即重放”的旧行为。
  if (existing.length > 0 && bySpecId.size === 0) {
    return {
      experimentId: spec.experimentId,
      runIds: existing.map((run) => run.runId),
      runs: existing.map(outcomeOf),
      failedRunCount: 0,
    };
  }
  const runs: ExperimentCreateResult["runs"][number][] = [];
  for (const runSpec of runSpecs) {
    const found = bySpecId.get(runSpec.id);
    if (found !== undefined) {
      runs.push(outcomeOf(found));
      continue;
    }
    // 部分失败后重试时补建缺失的 run，而不是只返回已存在的那部分。
    const created: RunCreateResult = await createRun(input.runWrite, runSpec);
    runs.push({ runId: created.runId, status: created.status, errors: created.errors });
  }
  for (const run of legacy) runs.push(outcomeOf(run));
  return {
    experimentId: spec.experimentId,
    runIds: runs.map((run) => run.runId),
    runs,
    failedRunCount: runs.filter((run) => run.status === "preflight-failed").length,
  };
}

interface ExistingRun {
  readonly runId: string;
  readonly specId: string | null;
  readonly status: ExperimentRunStatus;
}

function outcomeOf(run: ExistingRun): ExperimentCreateResult["runs"][number] {
  // 预检失败的历史原因没有单独持久化，如实留空而不是编造一条。
  return { runId: run.runId, status: run.status, errors: [] };
}

/**
 * 读出某实验已创建的 run。
 *
 * 归组依据是 RunSpec 上显式的 `experimentId`，与评估读取同一口径——
 * 不解析 `seed`、不猜命名约定。`runs` 是部署级表，必须按当前世界过滤，
 * 否则其他世界的同名实验会被当成“已有实验”。
 */
function existingRunsOf(
  input: ExperimentWriteInput,
  experimentId: string,
): readonly ExistingRun[] {
  const rows = input.runWrite.storage.transact((tx) =>
    tx.rows("runs").list({ world_id: input.runWrite.worldId }));
  const found: ExistingRun[] = [];
  for (const row of rows) {
    if (experimentIdOfRow(row) !== experimentId) continue;
    const runId = runIdOfRow(row);
    if (runId === null) continue;
    found.push({
      runId,
      specId: runSpecIdOfRow(row),
      status: runStatusOfRow(row),
    });
  }
  return found;
}

/** 取 run 行里的 run 标识；不是字符串时返回 null。 */
function runIdOfRow(row: Readonly<Record<string, unknown>>): string | null {
  const value = row["run_id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 取 run 行里的 RunSpec。
 *
 * `run_spec_json` 可能以对象或 JSON 字符串返回，两种都要处理；
 * 解析失败时返回 null 而不是抛错——单条记录损坏不该让整个幂等检查失败。
 */
function runSpecOfRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  const raw = row["run_spec_json"];
  let spec: unknown = raw;
  if (typeof raw === "string") {
    try {
      spec = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return null;
  return spec as Readonly<Record<string, unknown>>;
}

/** 取 run 行归属的实验标识；没有显式字段时返回 null，不从 seed 推断。 */
function experimentIdOfRow(row: Readonly<Record<string, unknown>>): string | null {
  const value = runSpecOfRow(row)?.["experimentId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 取 RunSpec.id；实验展开写入的确定性标识用于与本次展开结果对账。 */
function runSpecIdOfRow(row: Readonly<Record<string, unknown>>): string | null {
  const value = runSpecOfRow(row)?.["id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 取 run 行真实生命周期状态；未知值按 invalid 处理而不是伪装成 ready。 */
function runStatusOfRow(row: Readonly<Record<string, unknown>>): ExperimentRunStatus {
  const value = row["status"];
  return typeof value === "string" && experimentRunStatuses.has(value as ExperimentRunStatus)
    ? value as ExperimentRunStatus
    : "invalid";
}

/** 从请求里取实验规格：配置引用直接加载，内联对象经同一套 schema 校验。 */
function resolveSpec(
  input: ExperimentWriteInput,
  request: { readonly experimentSpec: unknown } | { readonly experimentRef: string },
): ExperimentSpec {
  if ("experimentRef" in request) {
    try {
      return loadExperimentSpec(request.experimentRef, input.loadContext).value;
    } catch (error) {
      // 配置引用不存在或不可解析属于调用方输入问题，不能落到 500。
      throw new DomainError("validation", `实验规格加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 内联规格同样不能绕过 schema：请求体来自外部，必须按配置契约校验后才可使用。
  const parsed = experimentSpecSchema.safeParse(request.experimentSpec);
  if (!parsed.success) {
    // 结构不合法属于调用方错误，映射为 validation 而不是内部故障。
    throw new DomainError("validation", `实验规格结构不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}
