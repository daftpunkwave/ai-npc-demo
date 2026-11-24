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

/** 实验创建结果：实验标识、创建出的 run 与逐条预检失败原因。 */
export interface ExperimentCreateResult {
  readonly experimentId: string;
  readonly runIds: readonly string[];
  /** 与 runIds 一一对应的逐个创建结果；失败项带逐条原因。 */
  readonly runs: readonly {
    readonly runId: string;
    readonly status: "ready" | "preflight-failed";
    readonly errors: readonly { readonly code: string; readonly message: string; readonly path: string }[];
  }[];
}

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
  const runSpecs = runsOfExperiment(spec);

  // 幂等：同一实验标识已有 run 时直接返回既有结果，不重复创建。
  // 没有这层检查时，重试同一请求会按相同规格再建一批 run，实验数据被污染成两份。
  const existing = existingRunsOf(input, spec.experimentId);
  if (existing.length > 0) {
    return {
      experimentId: spec.experimentId,
      runIds: existing.map((run) => run.runId),
      runs: existing,
    };
  }

  const runs: ExperimentCreateResult["runs"][number][] = [];
  for (const runSpec of runSpecs) {
    const created: RunCreateResult = await createRun(input.runWrite, runSpec);
    runs.push({ runId: created.runId, status: created.status, errors: created.errors });
  }
  return {
    experimentId: spec.experimentId,
    runIds: runs.map((run) => run.runId),
    runs,
  };
}

/**
 * 读出某实验已创建的 run。
 *
 * 归组依据是 RunSpec 上显式的 `experimentId`，与评估读取同一口径——
 * 不解析 `seed`、不猜命名约定。
 */
function existingRunsOf(
  input: ExperimentWriteInput,
  experimentId: string,
): readonly ExperimentCreateResult["runs"][number][] {
  const rows = input.runWrite.storage.transact((tx) => tx.rows("runs").list({}));
  const found: ExperimentCreateResult["runs"][number][] = [];
  for (const row of rows) {
    if (experimentIdOfRow(row) !== experimentId) continue;
    const runId = runIdOfRow(row);
    if (runId === null) continue;
    found.push({ runId, status: "ready", errors: [] });
  }
  return found;
}

/** 取 run 行里的 run 标识；不是字符串时返回 null。 */
function runIdOfRow(row: Readonly<Record<string, unknown>>): string | null {
  const value = row["run_id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 取 run 行归属的实验标识。
 *
 * `run_spec_json` 可能以对象或 JSON 字符串返回，两种都要处理；
 * 解析失败时返回 null 而不是抛错——单条记录损坏不该让整个幂等检查失败。
 */
function experimentIdOfRow(row: Readonly<Record<string, unknown>>): string | null {
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
  const value = (spec as { readonly experimentId?: unknown }).experimentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 从请求里取实验规格：配置引用直接加载，内联对象经同一套 schema 校验。 */
function resolveSpec(
  input: ExperimentWriteInput,
  request: { readonly experimentSpec: unknown } | { readonly experimentRef: string },
): ExperimentSpec {
  if ("experimentRef" in request) {
    return loadExperimentSpec(request.experimentRef, input.loadContext).value;
  }
  // 内联规格同样不能绕过 schema：请求体来自外部，必须按配置契约校验后才可使用。
  const parsed = experimentSpecSchema.safeParse(request.experimentSpec);
  if (!parsed.success) {
    // 结构不合法属于调用方错误，映射为 validation 而不是内部故障。
    throw new DomainError("validation", `实验规格结构不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}
