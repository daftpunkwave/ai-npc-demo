/**
 * 核心职责：按 RunSpec 解析一次 run 的完整冻结配置：名册、server 装配、Agent profile、工具集与模型挂载，并生成 manifest。
 * 交互契约：创建 run 与实验执行器共用本函数；执行器用同一实现复算 manifest 并与已存 `manifest_hash` 比对，
 * 两处不会因为各写一份解析逻辑而对同一 RunSpec 得出不同的冻结结果。
 * 约束与禁忌：不写存储、不启动模块；各阶段失败逐条累积为带错误码与路径的原因，不吞掉原始信息。
 */
import { DomainError, type ContentPack, type ModuleDefinition, type Roster } from "@world-prism/contracts";
import { validateRunSpec, type ConfigLoadContext, type LoadedConfig, type RunSpec } from "@world-prism/experiment";
import { resolveAgentConfiguration, type AgentConfiguration } from "./agent-configuration";
import { loadAssembly, resolveServerAssembly, type ResolvedServerAssembly } from "./assembly";
import { buildRunManifest, type RunManifest } from "./manifest";

/** 解析 run 配置所需的部署级依赖。 */
export interface RunConfigurationInput {
  readonly content: ContentPack;
  readonly definitions: readonly ModuleDefinition[];
  /** 内容包版本；与内容包一同冻结进 manifest。 */
  readonly contentVersion: string;
  /** 按引用加载名册；必须用 RunSpec 自己的 rosterRef，不能用在线名册代替。 */
  readonly loadRoster: (rosterRef: string) => LoadedConfig<Roster>;
  /** profile、工具集与模型布局的配置加载上下文。 */
  readonly loadContext: ConfigLoadContext;
  /** 仓库根目录；装配从其下的 `config/assemblies` 读取。 */
  readonly repoRoot: string;
}

/** 一条解析失败原因；错误码与契约 `runValidationErrorSchema.code` 一致。 */
export interface RunConfigurationFailure {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** 解析完成的冻结配置。 */
export interface RunConfiguration {
  readonly roster: Roster;
  readonly resolved: ResolvedServerAssembly;
  /** 装配未声明 Agent 槽位时为 null。 */
  readonly agents: AgentConfiguration | null;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

function failureOf(code: string, path: string, error: unknown): RunConfigurationFailure {
  if (error instanceof DomainError) return { code, path, message: error.safeMessage };
  return { code, path, message: error instanceof Error ? error.message : String(error) };
}

/**
 * 解析并冻结 run 配置。
 *
 * 名册与装配两项相互独立，都会执行并分别报告；Agent 配置依赖二者，只在二者都成功时解析。
 * Agent profile 与模型挂载一并冻结进 manifest：实验报告要能说明每个 Agent 实际用的记忆实现与模型路由，
 * 只冻结装配而在启动时再解析，会让环境变量或配置文件的后续改动静默进入已创建的 run。
 */
export async function resolveRunConfiguration(
  input: RunConfigurationInput,
  spec: RunSpec,
): Promise<{ readonly configuration: RunConfiguration } | { readonly failures: readonly RunConfigurationFailure[] }> {
  const failures: RunConfigurationFailure[] = [];
  let roster: LoadedConfig<Roster> | undefined;
  try {
    roster = input.loadRoster(spec.rosterRef);
    validateRunSpec(spec, input.content, roster);
  } catch (error) {
    failures.push(failureOf("run-spec-invalid", "runSpec", error));
  }
  let resolved: ResolvedServerAssembly | undefined;
  try {
    resolved = await resolveServerAssembly(loadAssembly(spec.moduleAssemblyRef, input.repoRoot), input.definitions, {
      content: input.content,
    });
  } catch (error) {
    failures.push(failureOf("assembly-unresolved", "runSpec.moduleAssemblyRef", error));
  }
  if (roster === undefined || resolved === undefined || failures.length > 0) return { failures };

  let agents: AgentConfiguration | null;
  try {
    agents = await resolveAgentConfiguration({
      assembly: resolved, roster: roster.value, runSpec: spec, loadContext: input.loadContext,
      definitions: input.definitions, content: input.content,
    });
  } catch (error) {
    return { failures: [failureOf("agent-configuration-invalid", "runSpec", error)] };
  }
  try {
    const sealed = await buildRunManifest({
      runSpec: spec,
      content: { packId: input.content.pack.packId, contentVersion: input.contentVersion },
      roster: roster.value,
      resolved,
      ...(agents === null ? {} : { agentProfiles: agents.manifest }),
      ...(agents?.models ? { models: agents.models.manifest } : {}),
    });
    return {
      configuration: { roster: roster.value, resolved, agents, manifest: sealed.manifest, manifestHash: sealed.manifestHash },
    };
  } catch (error) {
    return { failures: [failureOf("manifest-freeze-failed", "runSpec", error)] };
  }
}
