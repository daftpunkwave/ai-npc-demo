/**
 * 核心职责：承接研究员创建 run 的请求，做预检、冻结 manifest 并写入一条 ready 的 run 记录。
 * 交互契约：依赖宿主服务（ID、时钟、规范哈希）、存储、内容包、装配加载器与模块定义表；
 * 装配按 RunSpec 的 `moduleAssemblyRef` 从配置重新解析，manifest 与 run 记录在同一事务里写入。
 * 约束与禁忌：只创建记录与分支，不启动 Agent 运行时、不推进时钟、不写世界状态；
 * 预检失败时不落库，也不留下半个 run。
 */
import {
  DomainError,
  type ContentPack,
  type HostServices,
  type Json,
  type ModuleDefinition,
  type Roster,
  type StoragePort,
} from "@world-prism/contracts";
import { runSpecSchema, validateRunSpec, type LoadedConfig, type RunSpec } from "@world-prism/experiment";
import { buildRunManifest } from "./manifest";
import { loadAssembly, resolveServerAssembly, type ResolvedServerAssembly } from "./assembly";

/** run 创建结果；与契约 `runCreateResponseSchema` 同形。 */
export interface RunValidationFailure {
  /** 稳定的错误码，供调用方分支处理；与契约 `runValidationErrorSchema.code` 一致。 */
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface RunCreateResult {
  readonly runId: string;
  readonly status: "ready" | "preflight-failed";
  readonly errors: readonly RunValidationFailure[];
}

/** run 创建所需的最小依赖。 */
export interface RunWriteInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly content: ContentPack;
  readonly definitions: readonly ModuleDefinition[];
  /** 内容包版本；与内容包一同冻结进 manifest。 */
  readonly contentVersion: string;
  /** 按引用加载名册；创建 run 时按 RunSpec 自己的 rosterRef 加载，不用在线名册代替。 */
  readonly loadRoster: (rosterRef: string) => LoadedConfig<Roster>;
  readonly worldId: string;
  /** 仓库根目录；loadAssembly 在其下定位 `config/assemblies`，不能再拼一层 config。 */
  readonly repoRoot: string;
}

/**
 * 转成可存入 JSON 列的值：经 JSON 往返剔除 `undefined` 属性。
 * 存储层拒绝带 undefined 的对象，而可选字段在运行期确实可能是 undefined。
 */
function canonicalJsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** 把任意异常收敛成一条预检失败原因；不吞掉原始信息。 */
function failureOf(code: string, path: string, error: unknown): RunValidationFailure {
  if (error instanceof DomainError) return { code, path, message: error.safeMessage };
  return { code, path, message: error instanceof Error ? error.message : String(error) };
}

/**
 * 创建 run：先预检，通过后冻结 manifest 并写入 ready 记录。
 *
 * 预检覆盖四件事：RunSpec 结构是否符合严格 schema、与内容包/名册的交叉校验、
 * 装配引用能否加载、装配能否解析。
 * HTTP 入口的契约只把 runSpec 描述为 JSON 对象（由配置加载边界负责结构校验），
 * 因此这里必须自己补上严格 schema——否则文件加载会被 schema 拒绝的字段形状，
 * 经 HTTP 提交却能进入冻结清单。
 * 任一失败都返回 `preflight-failed` 与逐条原因且不落库——创建出无法启动的 run
 * 会让后续的清单核对与配额统计都不成立。
 */
export async function createRun(input: RunWriteInput, runSpec: unknown): Promise<RunCreateResult> {
  const failures: RunValidationFailure[] = [];
  const parsed = runSpecSchema.safeParse(runSpec);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    failures.push({
      code: "run-spec-invalid",
      path: first === undefined ? "runSpec" : `runSpec.${first.path.map(String).join(".")}`,
      message: first?.message ?? "run 规格结构不合法",
    });
    return { runId: input.host.ids("run"), status: "preflight-failed", errors: failures };
  }
  const spec = parsed.data;
  // 名册必须按请求的 `rosterRef` 加载：用在线名册代替会拒绝有效请求，
  // 也会把与 RunSpec 不一致的名册冻结进 manifest。
  let roster: LoadedConfig<Roster> | undefined;
  try {
    roster = input.loadRoster(spec.rosterRef);
    validateRunSpec(spec, input.content, roster);
  } catch (error) {
    failures.push(failureOf("run-spec-invalid", "runSpec", error));
  }

  let resolved: ResolvedServerAssembly | null = null;
  try {
    const assembly = loadAssembly(spec.moduleAssemblyRef, input.repoRoot);
    resolved = await resolveServerAssembly(assembly, input.definitions, { content: input.content });
  } catch (error) {
    failures.push(failureOf("assembly-unresolved", "runSpec.moduleAssemblyRef", error));
  }

  const runId = input.host.ids("run");
  if (failures.length > 0 || resolved === null || roster === undefined) {
    return { runId, status: "preflight-failed", errors: failures };
  }

  // manifest 把解析后的模块配置、内容版本与 seed 一并冻结；摘要用于事后核对同一次 run 的输入未变。
  let sealed: Awaited<ReturnType<typeof buildRunManifest>>;
  try {
    sealed = await buildRunManifest({
      runSpec: spec,
      content: { packId: input.content.pack.packId, contentVersion: input.contentVersion },
      roster: roster.value,
      resolved,
    });
  } catch (error) {
    // 冻结失败属于预检失败：不落库，并把原因如实返回给调用方。
    return {
      runId,
      status: "preflight-failed",
      errors: [failureOf("manifest-freeze-failed", "runSpec", error)],
    };
  }

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
      manifest_json: canonicalJsonValue(sealed.manifest),
      manifest_hash: sealed.manifestHash,
      contaminated: 0,
      evidence_complete: 1,
      created_at: createdAt,
      started_at: null,
      ended_at: null,
    });
  });

  return { runId, status: "ready", errors: [] };
}
