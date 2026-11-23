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
  readonly errors: readonly {
    readonly runId: string;
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
  validateExperimentSpec(spec, input.content, input.loadRoster(spec.base.rosterRef).value, input.loadContext);
  const runSpecs = runsOfExperiment(spec);

  const runIds: string[] = [];
  const errors: ExperimentCreateResult["errors"][number][] = [];
  for (const runSpec of runSpecs) {
    const created: RunCreateResult = await createRun(input.runWrite, runSpec);
    runIds.push(created.runId);
    if (created.status === "preflight-failed") {
      errors.push({ runId: created.runId, errors: created.errors });
    }
  }
  return { experimentId: spec.experimentId, runIds, errors };
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
