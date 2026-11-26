/**
 * 计算模块配置、目录快照与已解析装配的稳定摘要：输入先规范化为 JSON 再交给注入的 hash 端口。
 * 依赖公共契约的规范 JSON 与模块/装配类型，以及本包的目录快照与实例计划类型。
 * 禁止内置哈希算法、依赖注册顺序或键书写顺序，也禁止把未规范化对象直接交给 hash 端口。
 */
import {
  DomainError,
  agentSlots as agentSlotNames,
  canonicalJson,
  type AgentSlotImplementations,
  type AssemblyDescriptor,
  type CapabilityBinding,
  type CapabilityRef,
  type ContributionRef,
  type ExperimentAxis,
  type Json,
  type ModuleDefinition,
  type Realm,
} from "@world-prism/contracts";
import type { CatalogSnapshot } from "./registry";
import type { ResolvedRealmPlan } from "./resolve-assembly";

/** 注入的哈希端口：接收规范 JSON 字符串并返回摘要，具体算法由服务端或浏览器宿主提供。 */
// eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
export type CanonicalHasher = (canonicalJson: string) => Promise<string>;

/** 计算装配摘要所需输入：装配描述符、realm 与该 realm 已解析的实例计划。 */
export interface ComputeAssemblyHashInput {
  readonly assembly: AssemblyDescriptor;
  readonly realm: Realm;
  readonly plan: ResolvedRealmPlan;
  readonly hash: CanonicalHasher;
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const compareJson = (left: Json, right: Json): number => compareText(canonicalJson(left), canonicalJson(right));

function capabilityRefJson(ref: CapabilityRef): Json {
  return {
    capability: ref.capability,
    cardinality: ref.cardinality,
    instanceScope: ref.instanceScope,
  };
}

function sortedCapabilityRefs(refs: readonly CapabilityRef[]): Json[] {
  return refs.map(capabilityRefJson).sort(compareJson);
}

function contributionJson(ref: ContributionRef): Json {
  const entry: { [key: string]: Json } = {
    extensionId: ref.extensionId,
    slot: ref.slot,
    order: ref.order,
  };
  if (ref.allowedRoles !== undefined) {
    entry["allowedRoles"] = [...ref.allowedRoles];
  }
  return entry;
}

function experimentAxisJson(axis: ExperimentAxis): Json {
  const entry: { [key: string]: Json } = {
    key: axis.key,
    label: axis.label,
  };
  if (axis.values !== undefined) {
    entry["values"] = [...axis.values];
  }
  return entry;
}

/** 把模块描述符中可 JSON 表达的稳定契约字段整理为规范目录条目，函数与 schema 不参与摘要。 */
function catalogEntryJson(definition: ModuleDefinition): Json {
  const entry: { [key: string]: Json } = {
    id: definition.id,
    version: definition.version,
    apiVersion: definition.apiVersion,
    realm: definition.realm,
    kind: definition.kind,
    instanceScope: definition.instanceScope,
    provides: sortedCapabilityRefs(definition.provides),
    requires: sortedCapabilityRefs(definition.requires),
    requiresRemote: [...definition.requiresRemote].sort(compareText),
    stateSchemaVersion: definition.stateSchemaVersion,
  };
  if (definition.defaults !== undefined) {
    entry["defaults"] = definition.defaults;
  }
  if (definition.ownsAggregates !== undefined) {
    entry["ownsAggregates"] = [...definition.ownsAggregates].sort(compareText);
  }
  if (definition.contributions !== undefined) {
    entry["contributions"] = [...definition.contributions].map(contributionJson).sort(compareJson);
  }
  if (definition.experimentAxes !== undefined) {
    entry["experimentAxes"] = [...definition.experimentAxes].map(experimentAxisJson).sort(compareJson);
  }
  return entry;
}

function bindingJson(binding: CapabilityBinding): Json {
  const entry: { [key: string]: Json } = {
    capability: binding.capability,
    moduleId: binding.moduleId,
    configRef: binding.configRef,
  };
  if (binding.fallbackModuleIds !== undefined) {
    entry["fallbackModuleIds"] = [...binding.fallbackModuleIds];
  }
  return entry;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
function agentSlotsJson(declared: AgentSlotImplementations | undefined): Json {
  if (declared === undefined) {
    return null;
  }
  const entry: { [key: string]: Json } = {};
  for (const slot of agentSlotNames) {
    // eslint-disable-next-line security/detect-object-injection -- 槽位来自固定 agentSlotNames 清单，realm 来自受限枚举。
    const moduleIds = declared[slot];
    if (moduleIds !== undefined) {
      // eslint-disable-next-line security/detect-object-injection -- 槽位来自固定 agentSlotNames 清单，realm 来自受限枚举。
      entry[slot] = [...moduleIds];
    }
  }
  return entry;
}

async function digest(hash: CanonicalHasher, value: Json): Promise<string> {
  const canonical = canonicalJson(value);
  const result = await hash(canonical);
  if (typeof result !== "string" || result.length === 0) {
    throw new DomainError("plugin-failed", "hash 端口未返回非空摘要", {
      details: { canonicalLength: canonical.length },
    });
  }
  return result;
}

/** 计算已解析模块配置的摘要；配置对象的键序不影响结果。 */
export async function computeConfigHash(config: Json, hash: CanonicalHasher): Promise<string> {
  return digest(hash, config);
}

/** 计算目录快照摘要；模块条目按 id 与版本排序，注册顺序与对象键序不影响结果。 */
export async function computeCatalogHash(catalog: CatalogSnapshot, hash: CanonicalHasher): Promise<string> {
  const modules = [...catalog]
    .sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`))
    .map(catalogEntryJson);
  return digest(hash, { modules });
}

/** 计算一个 realm 的装配摘要：装配选择、Agent 槽位与每个模块的版本及配置摘要共同参与。 */
export async function computeAssemblyHash(input: ComputeAssemblyHashInput): Promise<string> {
  const { assembly, realm, plan, hash } = input;
  if (plan.realm !== realm) {
    throw new DomainError("assembly-incompatible", `实例计划的 realm ${plan.realm} 与请求的 ${realm} 不一致`, {
      details: { planRealm: plan.realm, realm },
    });
  }
  const modules: Json[] = [];
  for (const planned of plan.modules) {
    modules.push({
      moduleId: planned.moduleId,
      version: planned.version,
      apiVersion: planned.apiVersion,
      configHash: await computeConfigHash(planned.config, hash),
    });
  }
  modules.sort(compareJson);

  const payload: { [key: string]: Json } = {
    assemblyId: assembly.assemblyId,
    schemaVersion: assembly.schemaVersion,
    realm,
    modules,
    // eslint-disable-next-line security/detect-object-injection -- 槽位来自固定 agentSlotNames 清单，realm 来自受限枚举。
    bindings: assembly.realms[realm].bindings.map(bindingJson),
  };
  if (realm === "server") {
    payload["agentSlots"] = agentSlotsJson(assembly.realms.server.agentSlots);
  }
  return digest(hash, payload);
}
