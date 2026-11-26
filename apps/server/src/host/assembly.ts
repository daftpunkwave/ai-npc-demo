/**
 * 加载并解析 server 装配：严格读取装配目录，按 kernel 解析计划校验绑定、能力闭包、作用域、
 * 拓扑与模块配置，并计算规范化摘要；部署期配置覆盖只用于启动计划，不进入冻结摘要。
 * 依赖 yaml、契约 schema、kernel 解析/摘要与组合根模块定义；不启动模块、不打开存储。
 * 禁止接受任意路径、未登记模块，也禁止用模块 ID、原始 JSON.stringify 或截断摘要代替规范化哈希。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
/* eslint-disable security/detect-non-literal-fs-filename -- 只读取 config/assemblies 目录，且每个文件都经 realpath 越界与普通文件检查。 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  assemblyDescriptorSchema,
  protocolVersion,
  type AssemblyDescriptor,
  type CapabilityRef,
  type Json,
  type ModuleDefinition,
  type ModuleRef,
  type ResolvedModuleSet,
} from "@ai-npc/contracts";
import { loadContentPack, schemaLoadingError, type ContentPack } from "@ai-npc/experiment";
import {
  computeAssemblyHash,
  computeCatalogHash,
  computeConfigHash,
  createModuleRegistry,
  resolveRealmPlan,
  type CanonicalHasher,
  type ResolvedRealmPlan,
} from "@ai-npc/kernel";
import { canonicalHasher } from "../host-services";
import { clientRequiredCapabilities, serverAgentRequiredCapabilities, serverRequiredCapabilities } from "./module-catalog";

/** 装配目录固定为项目根下的 config/assemblies；测试可传入不同根目录。 */
function assemblyDirectory(root: string = process.cwd()): string {
  return resolve(root, "config/assemblies");
}

/** 读取装配目录内的全部 YAML；每个文件必须是普通文件并通过严格 schema。 */
export function loadAssemblies(root: string = process.cwd()): readonly AssemblyDescriptor[] {
  const directory = assemblyDirectory(root);
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(`无法读取装配目录 ${directory}：${error instanceof Error ? error.message : String(error)}`);
  }
  const assemblies: AssemblyDescriptor[] = [];
  const realDirectory = realpathSync(directory);
  for (const fileName of fileNames) {
    const filePath = join(directory, fileName);
    // 拒绝符号链接与越界路径：realpath 必须仍位于固定的装配目录内，且目标是普通文件。
    const realFile = realpathSync(filePath);
    if (!realFile.startsWith(`${realDirectory}${sep}`) || !statSync(realFile).isFile()) {
      throw new Error(`装配文件越出目录或不是普通文件: ${fileName}`);
    }
    const text = readFileSync(realFile, "utf8");
    let parsed: unknown;
    try {
      parsed = parse(text);
    } catch (error) {
      throw new Error(`装配文件 ${fileName} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`);
    }
    const result = assemblyDescriptorSchema.safeParse(parsed);
    if (!result.success) {
      // 装配文件是配置边界：失败原因必须带字段路径，并与其它配置加载器共用同一错误类型。
      throw schemaLoadingError(fileName, result.error);
    }
    assemblies.push(result.data);
  }
  const ids = new Set<string>();
  for (const assembly of assemblies) {
    if (ids.has(assembly.assemblyId)) {
      throw new Error(`装配目录中存在重复 assemblyId=${assembly.assemblyId}`);
    }
    ids.add(assembly.assemblyId);
  }
  return assemblies;
}

/**
 * 按 assemblyId 在装配目录中读取唯一装配。
 * 目录内每个 YAML 都必须通过装配 schema；损坏文件直接报告文件名，不静默跳过。
 */
export function loadAssembly(ref: string, root: string = process.cwd()): AssemblyDescriptor {
  if (ref.trim().length === 0 || ref.includes("/") || ref.includes("\\")) {
    throw new Error(`未知 server 装配: ${ref}`);
  }
  const matches = loadAssemblies(root).filter((assembly) => assembly.assemblyId === ref);
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

/** 服务端启动与目录检查使用同一组内容注入和条件能力要求。 */
export function serverAssemblyInputs(
  assembly: AssemblyDescriptor,
  required: readonly CapabilityRef[],
  options: ResolveServerAssemblyOptions = {},
  root = process.cwd(),
): { readonly requiredCapabilities: readonly CapabilityRef[]; readonly configOverrides: Readonly<Record<string, Json>> } {
  const server = assembly.realms.server;
  const toolBinding = server.bindings.find((binding) => binding.capability === "agent.tools");
  const configOverrides = { ...options.configOverrides };
  if (toolBinding?.moduleId === "agent.tools.game-tools") {
    const content = options.content ?? loadContentPack(resolve(root, "content"), "earth-2964-v1");
    configOverrides[toolBinding.moduleId] = { toolDescriptions: content.prompts.toolDescriptions };
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
