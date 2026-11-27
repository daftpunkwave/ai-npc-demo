/**
 * 加载并解析 server 装配：严格读取装配目录，按 kernel 解析计划校验绑定、能力闭包、作用域、
 * 拓扑与模块配置，并计算规范化摘要；部署期配置覆盖只用于启动计划，不进入冻结摘要。
 * 装配目录的扫描是启动路径与 check:catalog 的唯一实现，文件级约束只在这里维护一份。
 * 依赖 yaml、契约 schema、kernel 解析/摘要与组合根模块定义；不启动模块、不打开存储。
 * 禁止接受任意路径、未登记模块，也禁止用模块 ID、原始 JSON.stringify 或截断摘要代替规范化哈希。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
/* eslint-disable security/detect-non-literal-fs-filename -- 只读取 config/assemblies 目录，且每个文件都经 realpath 越界与普通文件检查。 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { LoadingError } from "@world-prism/experiment";
import {
  assemblyDescriptorSchema,
  protocolVersion,
  type AssemblyDescriptor,
  type CapabilityRef,
  type ContentPack,
  type Json,
  type ModuleDefinition,
  type ModuleRef,
  type ResolvedModuleSet,
} from "@world-prism/contracts";
import { loadContentPack, schemaLoadingError } from "@world-prism/experiment";
import {
  computeAssemblyHash,
  computeCatalogHash,
  computeConfigHash,
  createModuleRegistry,
  resolveRealmPlan,
  type CanonicalHasher,
  type ResolvedRealmPlan,
} from "@world-prism/kernel";
import { deploymentDefaults } from "../deployment-defaults";
import { canonicalHasher } from "../host-services";
import { clientRequiredCapabilities, serverAgentRequiredCapabilities, serverRequiredCapabilities } from "./module-catalog";

/** 装配目录固定为项目根下的 config/assemblies；测试可传入不同根目录。 */
function assemblyDirectory(root: string = process.cwd()): string {
  return resolve(root, "config/assemblies");
}

/** 装配文件枚举与逐文件诊断：只报告文件名与原因，由调用方决定是抛出还是累积。 */
export interface AssemblyScanFailure {
  readonly file: string;
  readonly code: "assemblies-unreadable" | "assembly-unreadable" | "assembly-schema" | "assembly-duplicate";
  readonly message: string;
  /** schema 失败时保留原始加载错误，启动路径据此抛出带字段路径的错误。 */
  readonly error?: LoadingError;
}

/** 装配目录中的一份成功解析的装配及其来源文件名。 */
export interface ScannedAssembly {
  readonly fileName: string;
  readonly assembly: AssemblyDescriptor;
}

/** 装配目录扫描结果：成功解析的装配按文件顺序排列，失败项逐条记录。 */
export interface AssemblyScan {
  readonly directory: string;
  readonly assemblies: readonly ScannedAssembly[];
  readonly failures: readonly AssemblyScanFailure[];
}

/**
 * 扫描并解析装配目录，是启动路径与 check:catalog 共用的唯一实现。
 * 文件级约束（目录可读、普通文件、realpath 不越界、schema、assemblyId 唯一）都在这里生效，
 * 避免两条路径对同一目录给出不同结论。
 */
/**
 * 执行单文件的 realpath、普通文件、读取、YAML 解析与 schema 校验。
 * 任一环节失败都返回失败项而不是抛出：预检要累积同一次扫描的全部问题，
 * 单个文件在 realpath 之后被删除或不可读不能吞掉其余文件的结论。
 */
function scanAssemblyFile(
  directory: string,
  realDirectory: string,
  fileName: string,
): { readonly assembly: AssemblyDescriptor } | { readonly failure: AssemblyScanFailure } {
  const filePath = join(directory, fileName);
  const fail = (message: string): { readonly failure: AssemblyScanFailure } => ({
    failure: { file: fileName, code: "assembly-unreadable", message },
  });
  let realFile: string;
  try {
    // 拒绝符号链接与越界路径：realpath 必须仍位于固定的装配目录内，且目标是普通文件。
    realFile = realpathSync(filePath);
  } catch (error) {
    return fail(`装配文件不可用 ${fileName}：${error instanceof Error ? error.message : String(error)}`);
  }
  let isPlainFile: boolean;
  try {
    isPlainFile = realFile.startsWith(`${realDirectory}${sep}`) && statSync(realFile).isFile();
  } catch (error) {
    // realpath 与 stat 之间文件被删除或权限变化：同样按不可用处理，不中断扫描。
    return fail(`装配文件不可用 ${fileName}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainFile) {
    return fail(`装配文件越出目录或不是普通文件: ${fileName}`);
  }
  let text: string;
  try {
    text = readFileSync(realFile, "utf8");
  } catch (error) {
    return fail(`装配文件不可读 ${fileName}：${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return fail(`装配文件 ${fileName} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`);
  }
  const result = assemblyDescriptorSchema.safeParse(parsed);
  if (!result.success) {
    // 装配文件是配置边界：失败原因必须带字段路径，并与其它配置加载器共用同一错误类型。
    const error = schemaLoadingError(fileName, result.error);
    return { failure: { file: fileName, code: "assembly-schema", message: error.message, error } };
  }
  return { assembly: result.data };
}

export function scanAssemblyDirectory(root: string = process.cwd()): AssemblyScan {
  const directory = assemblyDirectory(root);
  const failures: AssemblyScanFailure[] = [];
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory, { withFileTypes: true })
      // 只按名字筛选，是否可用交给后续的 realpath 与普通文件检查判定。
      // 若在此用 isFile() 过滤，目录或符号链接会被静默忽略而不是被拒绝，
      // 指向目录外的链接就会绕过越界校验。
      .filter((entry) => /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    failures.push({
      file: directory,
      code: "assemblies-unreadable",
      message: `无法读取装配目录 ${directory}：${error instanceof Error ? error.message : String(error)}`,
    });
    return { directory, assemblies: [], failures };
  }
  const assemblies: ScannedAssembly[] = [];
  let realDirectory: string;
  try {
    realDirectory = realpathSync(directory);
  } catch (error) {
    // 目录可枚举但无法解析真实路径：后续无法判定越界，整体按目录不可读处理。
    failures.push({
      file: directory,
      code: "assemblies-unreadable",
      message: `无法解析装配目录 ${directory}：${error instanceof Error ? error.message : String(error)}`,
    });
    return { directory, assemblies: [], failures };
  }
  const seenAssemblyIds = new Map<string, string>();
  for (const fileName of fileNames) {
    const scanned = scanAssemblyFile(directory, realDirectory, fileName);
    if ("failure" in scanned) {
      failures.push(scanned.failure);
      continue;
    }
    const previous = seenAssemblyIds.get(scanned.assembly.assemblyId);
    if (previous !== undefined) {
      failures.push({
        file: fileName,
        code: "assembly-duplicate",
        message: `装配目录中存在重复 assemblyId=${scanned.assembly.assemblyId}，另一处在 ${previous}`,
      });
      continue;
    }
    seenAssemblyIds.set(scanned.assembly.assemblyId, fileName);
    assemblies.push({ fileName, assembly: scanned.assembly });
  }
  return { directory, assemblies, failures };
}

/** 读取装配目录内的全部 YAML；任一文件不可用即失败，不静默跳过。 */
export function loadAssemblies(root: string = process.cwd()): readonly AssemblyDescriptor[] {
  const scan = scanAssemblyDirectory(root);
  const [first] = scan.failures;
  if (first !== undefined) {
    throw first.error ?? new Error(first.message);
  }
  return scan.assemblies.map((entry) => entry.assembly);
}

/**
 * 按 assemblyId 在装配目录中读取唯一装配。
 * 目录内每个 YAML 都必须通过装配 schema；损坏文件直接报告文件名，不静默跳过。
 * 已读到整份目录的调用方传入 `assemblies` 复用结果，避免同一次启动重复扫描与解析。
 */
export function loadAssembly(
  ref: string,
  root: string = process.cwd(),
  assemblies?: readonly AssemblyDescriptor[],
): AssemblyDescriptor {
  if (ref.trim().length === 0 || ref.includes("/") || ref.includes("\\")) {
    throw new Error(`未知 server 装配: ${ref}`);
  }
  const matches = (assemblies ?? loadAssemblies(root)).filter((assembly) => assembly.assemblyId === ref);
  if (matches.length === 0) {
    throw new Error(`未知 server 装配: ${ref}`);
  }
  if (matches.length > 1) {
    throw new Error(`装配目录中存在多个 assemblyId=${ref} 的文件；装配 ID 必须唯一`);
  }
  return matches[0] as AssemblyDescriptor;
}

/** 解析 server 装配的选项：摘要端口与不进入摘要的部署期配置覆盖。 */
export interface ResolveServerAssemblyOptions {
  readonly hash?: CanonicalHasher;
  readonly configOverrides?: Readonly<Record<string, Json>>;
  readonly content?: ContentPack;
}

/** 接收内容包工具描述的能力；宿主按能力而不是具体模块 ID 选择注入对象。 */
const toolDescriptionsCapability = "agent.tools";

/** 装配中绑定到 `agent.tools` 的服务端绑定；未绑定时为 undefined。 */
function toolsBinding(assembly: AssemblyDescriptor): AssemblyDescriptor["realms"]["server"]["bindings"][number] | undefined {
  return assembly.realms.server.bindings.find((binding) => binding.capability === toolDescriptionsCapability);
}

/**
 * 装配是否需要把内容包的工具描述注入 `agent.tools` 的 provider 配置。
 * 预检只对这类装配读取内容包；其余装配（含测试用的自定义目录）不需要内容包就能完成解析。
 */
export function needsContentPack(assembly: AssemblyDescriptor): boolean {
  return toolsBinding(assembly) !== undefined;
}

/** 服务端启动与目录检查使用同一组内容注入和条件能力要求。 */
export function serverAssemblyInputs(
  assembly: AssemblyDescriptor,
  required: readonly CapabilityRef[],
  options: ResolveServerAssemblyOptions = {},
  root = process.cwd(),
): { readonly requiredCapabilities: readonly CapabilityRef[]; readonly configOverrides: Readonly<Record<string, Json>> } {
  const server = assembly.realms.server;
  const toolBinding = toolsBinding(assembly);
  const configOverrides = { ...options.configOverrides };
  if (toolBinding !== undefined) {
    // 工具说明文案属于内容包：装配把哪个模块绑定到 agent.tools，就把它作为该模块配置的 toolDescriptions 传入，
    // 换用其他工具 provider 只改装配；provider 的配置 schema 必须接受该字段。
    const content = options.content ?? loadContentPack(resolve(root, "content"), deploymentDefaults.contentPackId);
    const existing = configOverrides[toolBinding.moduleId];
    // 调用方对该模块的其他覆盖字段保留并与工具描述合并；非对象的覆盖原样交给 kernel 按非法覆盖拒绝，不在这里吞掉。
    if (existing === undefined || (typeof existing === "object" && existing !== null && !Array.isArray(existing))) {
      configOverrides[toolBinding.moduleId] = { ...existing, toolDescriptions: content.prompts.toolDescriptions };
    }
  }
  return {
    requiredCapabilities: Object.keys(server.agentSlots ?? {}).length > 0
      ? [...required, ...serverAgentRequiredCapabilities]
      : required,
    configOverrides,
  };
}

/** 一个 server 装配的解析结果：会话握手用的模块集、实例计划与两类规范化摘要。 */
export interface ResolvedServerAssembly {
  readonly plan: ResolvedRealmPlan;
  readonly modules: ResolvedModuleSet;
  readonly assemblyHash: string;
  readonly catalogHash: string;
}

/** 从装配绑定生成对外的能力清单；只公布实际绑定的能力，不公布模块额外提供的实现。 */
function boundCapabilities(
  assembly: AssemblyDescriptor,
  plan: ResolvedRealmPlan,
  realm: "server" | "client" | "console",
): CapabilityRef[] {
  const byModuleId = new Map(plan.modules.map((module) => [module.moduleId, module.definition]));
  const capabilities: CapabilityRef[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line security/detect-object-injection -- realm 是受限字面量联合，只索引装配中已声明的三个 realm。
  for (const binding of assembly.realms[realm].bindings) {
    const definition = byModuleId.get(binding.moduleId);
    const provided = definition?.provides.find((item) => item.capability === binding.capability);
    if (provided === undefined) {
      continue;
    }
    const key = `${provided.capability}:${provided.instanceScope}:${provided.cardinality}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    capabilities.push(provided);
  }
  return capabilities;
}

/**
 * 构造一个 realm 的模块引用摘要列表；调用前实例计划已完成全部校验。
 * `configHash` 始终给出同一份配置的规范摘要。
 * `config` 只对浏览器 realm（client / console）下发：它们没有装配解析器，必须靠这一份启动。
 * 服务端 realm 的实例由宿主自己创建，其配置含内容包下发的提示词与工具描述、部署期覆盖，
 * 属服务端内部参数，不能经 `/api/v1/session` 的 `serverAssembly` 暴露给玩家会话。
 */
async function moduleRefs(
  plan: ResolvedRealmPlan,
  hash: CanonicalHasher,
  includeConfig: boolean,
): Promise<ModuleRef[]> {
  const modules: ModuleRef[] = [];
  for (const module of plan.modules) {
    const configHash = await computeConfigHash(module.config, hash);
    modules.push({
      moduleId: module.moduleId,
      version: module.version,
      apiVersion: module.apiVersion,
      configHash,
      ...(includeConfig ? { config: module.config } : {}),
    });
  }
  return modules;
}

/**
 * 按 kernel 的统一解析规则构造 server 实例计划，并计算配置、目录与装配哈希。
 * 无 Agent 槽位时 plan.agentSlots 为空，宿主据此跳过 profile、toolset 与模型布局解析。
 */
export async function resolveServerAssembly(
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把 CanonicalHasher 判为 any。
  options: ResolveServerAssemblyOptions | CanonicalHasher = {},
): Promise<ResolvedServerAssembly> {
  const normalized = typeof options === "function" ? { hash: options } : options;
  const hash = normalized.hash ?? canonicalHasher;
  const registry = createModuleRegistry();
  for (const definition of definitions) {
    registry.register(definition);
  }
  const catalog = registry.snapshot();
  const plan = resolveRealmPlan({
    assembly,
    realm: "server",
    catalog,
    ...serverAssemblyInputs(assembly, serverRequiredCapabilities, normalized),
  });
  // server 装配摘要只带 configHash，不下发配置本身。
  const modules = await moduleRefs(plan, hash, false);
  const assemblyHash = await computeAssemblyHash({ assembly, realm: "server", plan, hash });
  return {
    plan,
    modules: {
      realm: "server",
      protocolVersion,
      modules,
      capabilities: boundCapabilities(assembly, plan, "server"),
      assemblyHash,
    },
    assemblyHash,
    catalogHash: await computeCatalogHash(catalog, hash),
  };
}

/** 浏览器 realm 的会话装配；与 server 共用同一解析器，空绑定得到空模块集。 */
export async function resolveSessionAssemblies(
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
  options: ResolveServerAssemblyOptions = {},
): Promise<{ readonly client: ResolvedModuleSet; readonly console: ResolvedModuleSet }> {
  const hash = options.hash ?? canonicalHasher;
  const registry = createModuleRegistry();
  for (const definition of definitions) {
    registry.register(definition);
  }
  const catalog = registry.snapshot();
  const resolveRealm = async (realm: "client" | "console"): Promise<ResolvedModuleSet> => {
    const plan = resolveRealmPlan({
      assembly,
      realm,
      catalog,
      ...(realm === "client" ? { requiredCapabilities: clientRequiredCapabilities } : {}),
    });
    const modules = await moduleRefs(plan, hash, true);
    return {
      realm,
      protocolVersion,
      modules,
      capabilities: boundCapabilities(assembly, plan, realm),
      assemblyHash: await computeAssemblyHash({ assembly, realm, plan, hash }),
    };
  };
  return { client: await resolveRealm("client"), console: await resolveRealm("console") };
}


/** 会话握手与装配测试只需要的模块集视图。 */
export async function resolveServerModules(
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
  options: ResolveServerAssemblyOptions = {},
): Promise<ResolvedModuleSet> {
  return (await resolveServerAssembly(assembly, definitions, options)).modules;
}

/** 从解析计划中取只含指定模块的子计划；模块的 requires 仍引用原提供者，由启动方补齐。 */
export function filterPlan(
  plan: ResolvedRealmPlan,
  predicate: (moduleId: string) => boolean,
): ResolvedRealmPlan {
  return {
    ...plan,
    modules: plan.modules.filter((module) => predicate(module.moduleId)),
  };
}
