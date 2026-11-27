/**
 * 冻结一次 run 的解析结果：内容版本、seed、实际装配引用与每个模块的解析后配置。
 * 依赖 kernel 的规范化摘要、实验包的 RunSpec 类型、公共契约的名册类型与已解析 server 装配；不访问存储、不启动模块。
 * 禁止写入密钥或凭据，禁止用原始 JSON.stringify、模块 ID 或截断摘要代替规范化哈希。
 * 未声明 Agent 槽位时不解析 profile、toolset 与模型布局，只保留名册选择供运行记录。
 */
import type { Json, Roster } from "@world-prism/contracts";
import type { RunSpec } from "@world-prism/experiment";
import { computeConfigHash, type CanonicalHasher } from "@world-prism/kernel";
import { canonicalHasher } from "../host-services";
import type { ResolvedServerAssembly } from "./assembly";

/** manifest 中的一个已解析模块：配置原文与规范化摘要都冻结，便于复核组合。 */
export interface RunManifestModule {
  readonly moduleId: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly configRef: string | null;
  readonly config: Json;
  readonly configHash: string;
}

/** RunSpec 中的实际启动选择；模板值不会写入这里。 */
export interface RunManifestSelection {
  readonly runSpecId: string;
  readonly moduleAssemblyRef: string;
  readonly worldPackRef: string;
  readonly scenarioRef: string;
  readonly rosterRef: string;
  readonly modelLayoutRef: string;
}

/** 冻结 manifest；manifestHash 单独写入 runs.manifest_hash，不放进对象自身。 */
export interface RunManifest {
  readonly schemaVersion: 1;
  readonly seed: string;
  readonly selection: RunManifestSelection;
  readonly content: {
    readonly packId: string;
    readonly contentVersion: string;
  };
  readonly assembly: {
    readonly assemblyId: string;
    readonly realm: "server";
    readonly modules: readonly RunManifestModule[];
    readonly catalogHash: string;
    readonly assemblyHash: string;
  };
  readonly roster: {
    readonly rosterRef: string;
    readonly agents: Roster["agents"];
  };
  /** 装配未声明 Agent 槽位时为 null，表示未解析 profile、toolset 与模型布局。 */
  readonly agentSlots: Readonly<Record<string, readonly string[]>> | null;
  readonly agentProfiles?: Json;
  readonly models?: Json;
}

export interface BuildRunManifestInput {
  readonly runSpec: RunSpec;
  readonly content: { readonly packId: string; readonly contentVersion: string };
  readonly roster: Roster;
  readonly resolved: ResolvedServerAssembly;
  readonly agentProfiles?: Json;
  readonly models?: Json;
  readonly hash?: CanonicalHasher;
}

export interface BuiltRunManifest {
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

/** 冻结解析后的模块配置、内容版本、seed 与装配引用，并计算 manifest 的规范化摘要。 */
export async function buildRunManifest(input: BuildRunManifestInput): Promise<BuiltRunManifest> {
  const hash = input.hash ?? canonicalHasher;
  const modules: RunManifestModule[] = [];
  for (const planned of input.resolved.plan.modules) {
    modules.push({
      moduleId: planned.moduleId,
      version: planned.version,
      apiVersion: planned.apiVersion,
      configRef: planned.configRef,
      config: planned.config,
      configHash: await computeConfigHash(planned.config, hash),
    });
  }
  const slotEntries = Object.entries(input.resolved.plan.agentSlots);
  const manifest: RunManifest = {
    schemaVersion: 1,
    seed: input.runSpec.seed,
    selection: {
      runSpecId: input.runSpec.id,
      moduleAssemblyRef: input.runSpec.moduleAssemblyRef,
      worldPackRef: input.runSpec.worldPackRef,
      scenarioRef: input.runSpec.scenarioRef,
      rosterRef: input.runSpec.rosterRef,
      modelLayoutRef: input.runSpec.modelLayoutRef,
    },
    content: {
      packId: input.content.packId,
      contentVersion: input.content.contentVersion,
    },
    assembly: {
      assemblyId: input.resolved.plan.assemblyId,
      realm: "server",
      modules,
      catalogHash: input.resolved.catalogHash,
      assemblyHash: input.resolved.assemblyHash,
    },
    roster: {
      rosterRef: input.roster.rosterId,
      agents: input.roster.agents,
    },
    agentSlots: slotEntries.length === 0 ? null : Object.fromEntries(slotEntries),
    ...(input.agentProfiles === undefined ? {} : { agentProfiles: input.agentProfiles }),
    ...(input.models === undefined ? {} : { models: input.models }),
  };
  return {
    manifest,
    manifestHash: await computeConfigHash(manifest as unknown as Json, hash),
  };
}

/** 已冻结 manifest 中重启兼容性检查需要的字段。 */
export interface FrozenManifestFacts {
  readonly seed: string;
  readonly moduleAssemblyRef: string;
  readonly rosterRef: string;
  readonly packId: string;
  readonly contentVersion: string;
  readonly hasAgentSlots: boolean;
  readonly hasModels: boolean;
  readonly catalogHash: string;
}

function manifestObject(value: Json, label: string): Readonly<Record<string, Json>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`冻结 manifest 的 ${label} 不是对象`);
  }
  return value as Readonly<Record<string, Json>>;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把契约里的 Json 判为 any。
function manifestString(value: Json | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`冻结 manifest 缺少 ${label}`);
  }
  return value;
}

/** 读取并校验冻结 manifest 的关键字段；字段损坏时拒绝按它启动。 */
export function readFrozenManifest(value: Json): FrozenManifestFacts {
  const manifest = manifestObject(value, "根节点");
  const selection = manifestObject(manifest["selection"] ?? null, "selection");
  const content = manifestObject(manifest["content"] ?? null, "content");
  const assembly = manifestObject(manifest["assembly"] ?? null, "assembly");
  return {
    seed: manifestString(manifest["seed"], "seed"),
    moduleAssemblyRef: manifestString(selection["moduleAssemblyRef"], "selection.moduleAssemblyRef"),
    rosterRef: manifestString(selection["rosterRef"], "selection.rosterRef"),
    packId: manifestString(content["packId"], "content.packId"),
    contentVersion: manifestString(content["contentVersion"], "content.contentVersion"),
    hasAgentSlots: manifest["agentSlots"] !== null && manifest["agentSlots"] !== undefined,
    hasModels: manifest["models"] !== undefined,
    catalogHash: manifestString(assembly["catalogHash"], "assembly.catalogHash"),
  };
}
