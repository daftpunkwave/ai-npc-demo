/**
 * 核心职责：承接研究员创建 run 的请求，做预检、冻结 manifest 并写入一条 ready 的 run 记录。
 * 交互契约：依赖宿主服务（ID、时钟、规范哈希）、存储与 run 配置解析；装配按 RunSpec 的 `moduleAssemblyRef`
 * 从配置重新解析，Agent profile 与模型挂载一并冻结，manifest 与 run 记录在同一事务里写入。
 * 约束与禁忌：只创建记录与分支，不启动 Agent 运行时、不推进时钟、不写世界状态；
 * 预检失败时不落库，也不留下半个 run。
 */
import {
  type HostServices,
  type Json,
  type StoragePort,
} from "@world-prism/contracts";
import { runSpecSchema } from "@world-prism/experiment";
import { resolveRunConfiguration, type RunConfigurationFailure, type RunConfigurationInput } from "./run-configuration";

/** run 创建结果；与契约 `runCreateResponseSchema` 同形。 */
export type RunValidationFailure = RunConfigurationFailure;

export interface RunCreateResult {
  readonly runId: string;
  readonly status: "ready" | "preflight-failed";
  readonly errors: readonly RunValidationFailure[];
}

/** run 创建所需的最小依赖。 */
export interface RunWriteInput extends RunConfigurationInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly worldId: string;
}

/**
 * 转成可存入 JSON 列的值：经 JSON 往返剔除 `undefined` 属性。
 * 存储层拒绝带 undefined 的对象，而可选字段在运行期确实可能是 undefined。
 */
function canonicalJsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * 创建 run：先预检，通过后冻结 manifest 并写入 ready 记录。
 *
 * 预检覆盖 RunSpec 严格 schema、与内容包/名册的交叉校验、装配解析，以及 Agent profile、工具集与模型挂载的解析。
 * HTTP 入口的契约只把 runSpec 描述为 JSON 对象（由配置加载边界负责结构校验），
 * 因此这里必须自己补上严格 schema——否则文件加载会被 schema 拒绝的字段形状，
 * 经 HTTP 提交却能进入冻结清单。
 * 任一失败都返回 `preflight-failed` 与逐条原因且不落库——创建出无法启动的 run
 * 会让后续的清单核对与配额统计都不成立。
 */
export async function createRun(input: RunWriteInput, runSpec: unknown): Promise<RunCreateResult> {
  const parsed = runSpecSchema.safeParse(runSpec);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    return {
      runId: input.host.ids("run"),
      status: "preflight-failed",
      errors: [{
        code: "run-spec-invalid",
        path: first === undefined ? "runSpec" : `runSpec.${first.path.map(String).join(".")}`,
        message: first?.message ?? "run 规格结构不合法",
      }],
    };
  }
  const spec = parsed.data;
  const resolved = await resolveRunConfiguration(input, spec);
  const runId = input.host.ids("run");
  if ("failures" in resolved) {
    return { runId, status: "preflight-failed", errors: resolved.failures };
  }
  const { manifest, manifestHash } = resolved.configuration;

  const createdAt = input.host.nowIso();
  const runBranchId = input.host.ids("br");
  input.storage.transact((tx) => {
    // 每个 run 有自己的分支：实验 run 之间互不影响，也不污染在线分支。
    tx.rows("branches").put({
      branch_id: runBranchId,
      world_id: input.worldId,
      kind: "experiment",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: 0,
      run_id: runId,
      profile_hash: null,
      created_at: createdAt,
    });
    tx.rows("runs").put({
      run_id: runId,
      world_id: input.worldId,
      branch_id: runBranchId,
      mode: spec.mode,
      // ready 表示预检与冻结已完成，等待显式 start；不在这里自动开跑。
      status: "ready",
      // 规范 JSON 往返会剔除 undefined 属性：存储层拒绝 undefined，且冻结值本就不该带它。
      run_spec_json: canonicalJsonValue(spec),
      manifest_json: canonicalJsonValue(manifest),
      manifest_hash: manifestHash,
      contaminated: 0,
      evidence_complete: 1,
      created_at: createdAt,
      started_at: null,
      ended_at: null,
    });
  });

  return { runId, status: "ready", errors: [] };
}
