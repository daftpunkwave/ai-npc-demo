/**
 * 核心职责：按在线别名恢复已冻结的 run：校验冻结 manifest 与当前内容/名册/装配是否一致，
 * 决定是否走显式迁移，并给出活动 run 状态与实例计划。
 * 交互契约：输入在线入口、已解析的内容包与配置上下文、装配目录与部署期覆盖；
 * 返回活动 run、启动计划与（若发生迁移）源分支标识和原状态供失败补偿。
 * 约束与禁忌：不按当前入参重建 RunSpec、不静默改写冻结哈希、不跳过 manifest 与 RunSpec 的一致性校验。
 */
import type { AssemblyDescriptor, ContentPack, HostServices, Json, ModuleDefinition, StoragePort } from "@world-prism/contracts";
import {
  loadRoster,
  runSpecSchema,
  validateRoster,
  validateRunSpec,
  type ConfigLoadContext,
} from "@world-prism/experiment";
import { resolveAgentConfiguration } from "./agent-configuration";
import { loadAssembly, resolveServerAssembly, type ResolvedServerAssembly } from "./assembly";
import { resolveFrozenAssembly } from "./frozen-assembly";
import { buildRunManifest, readFrozenManifest } from "./manifest";
import { contentVersionMismatch, type OnlineEntry } from "./online-entry";
import {
  assertMigrationScopeIsCapabilityClosure,
  migrateOnlineRun,
  migrationSummary,
  OnlineRunMigrationRequiredError,
} from "./run-migration";
import type { ResumedRunState } from "./startup-types";

/** 重启恢复的输入；与首次启动共享同一批已解析参数。 */
export interface ResumeRunInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly online: OnlineEntry;
  readonly definitions: readonly ModuleDefinition[];
  readonly content: ContentPack;
  readonly contentVersion: string;
  readonly packId: string;
  readonly loadContext: ConfigLoadContext;
  readonly assemblies: readonly AssemblyDescriptor[];
  readonly deploymentOverrides: Readonly<Record<string, Json>>;
  readonly migrateOnlineRun: boolean;
}

/**
 * 重启：沿用在线别名指向的分支与已冻结 run，不复用当前入参重建 RunSpec。
 *
 * 冻结 manifest 与当前解析结果不一致时，只有装配能力闭包差异允许显式迁移；
 * seed、RunSpec 选择、内容、名册或 Agent 配置任一差异都拒绝启动。
 */
export async function resumeRun(input: ResumeRunInput): Promise<ResumedRunState> {
  const { host, storage, online, content, packId, contentVersion } = input;
  const run = online.run;
  const parsed = runSpecSchema.safeParse(run["run_spec_json"]);
  if (!parsed.success) {
    throw new Error(`在线 run 的 RunSpec 无法解析：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
  }
  const frozenSpec = parsed.data;
  const manifestValue = run["manifest_json"];
  if (manifestValue === null || manifestValue === undefined || manifestValue instanceof Uint8Array) {
    throw new Error("在线 run 缺少冻结 manifest（旧版本数据），拒绝按当前入参重建");
  }
  const facts = readFrozenManifest(manifestValue);
  if (facts.seed !== frozenSpec.seed) {
    throw new Error("冻结 manifest 的 seed 与 RunSpec 不一致");
  }
  if (facts.moduleAssemblyRef !== frozenSpec.moduleAssemblyRef) {
    throw new Error("冻结 manifest 的装配引用与 RunSpec 不一致");
  }
  if (facts.rosterRef !== frozenSpec.rosterRef) {
    throw new Error("冻结 manifest 的名册引用与 RunSpec 不一致");
  }
  if (facts.packId !== packId) {
    throw new Error(`内容包不一致：在线 run 冻结「${facts.packId}」，当前内容包「${packId}」；拒绝启动`);
  }
  if (facts.contentVersion !== contentVersion) {
    throw contentVersionMismatch(facts.contentVersion, contentVersion, "在线 run");
  }
  const worldRow = storage.transact((tx) => tx.rows("worlds").get({ world_id: online.worldId }));
  if (worldRow === null) {
    throw new Error(`在线分支引用的 world ${online.worldId} 不存在`);
  }
  if (worldRow["pack_id"] !== packId) {
    throw new Error(`内容包不一致：在线世界「${String(worldRow["pack_id"])}」，当前内容包「${packId}」；拒绝启动`);
  }
  const worldVersion = typeof worldRow["content_version"] === "string" ? worldRow["content_version"] : "";
  if (worldVersion !== contentVersion) {
    throw contentVersionMismatch(worldVersion, contentVersion, "在线世界");
  }
  const storedHash = typeof run["manifest_hash"] === "string" ? run["manifest_hash"] : "";
  if (storedHash.length === 0) throw new Error("在线 run 缺少 manifest_hash，拒绝按当前入参重建");
  if (await host.hash(manifestValue as Json) !== storedHash) {
    throw new Error("冻结 manifest 内容与 manifest_hash 不一致：运行记录被修改");
  }
  const currentAssembly = loadAssembly(frozenSpec.moduleAssemblyRef, process.cwd(), input.assemblies);
  const compatible = await resolveFrozenAssembly(currentAssembly, input.definitions, facts);
  const { assembly } = compatible;
  const roster = loadRoster(frozenSpec.rosterRef, input.loadContext);
  validateRoster(roster.value, content);
  validateRunSpec(frozenSpec, content, roster);
  const resolved = await resolveServerAssembly(assembly, compatible.definitions, { content });
  const startup = await resolveServerAssembly(assembly, compatible.definitions, {
    configOverrides: input.deploymentOverrides,
    content,
  });
  const agents = await resolveAgentConfiguration({
    assembly: resolved, roster: roster.value, runSpec: frozenSpec, loadContext: input.loadContext,
    definitions: compatible.definitions, content, legacyDecision: compatible.legacyDecision,
  });
  const rebuilt = await buildRunManifest({
    runSpec: frozenSpec,
    content: { packId, contentVersion },
    roster: roster.value,
    resolved,
    ...(agents === null ? {} : { agentProfiles: agents.manifest }),
    ...(agents?.models ? { models: agents.models.manifest } : {}),
  });
  if (rebuilt.manifestHash !== storedHash) {
    assertMigrationScopeIsCapabilityClosure(manifestValue, rebuilt.manifest);
    const migrationInput = {
      storage,
      host,
      online,
      runSpec: frozenSpec as unknown as Json,
      manifest: rebuilt.manifest,
      manifestHash: rebuilt.manifestHash,
    };
    if (!input.migrateOnlineRun) {
      throw new OnlineRunMigrationRequiredError({
        runId: online.runId,
        branchId: online.branchId,
        detail: `冻结 manifest_hash「${storedHash}」，按当前装配与模块目录复算为「${rebuilt.manifestHash}」`,
      });
    }
    const migrated = migrateOnlineRun(migrationInput);
    host.logger.info(migrationSummary(migrationInput, migrated));
    return {
      active: {
        worldId: online.worldId,
        branchId: migrated.branchId,
        assembly,
        resolved,
        runSpec: frozenSpec,
        manifest: rebuilt.manifest,
        manifestHash: rebuilt.manifestHash,
        agents,
      },
      startup,
      migratedFromBranchId: online.branchId,
      migratedSourceBranchStatus: migrated.sourceBranchStatus,
    };
  }
  return {
    active: {
      worldId: online.worldId,
      branchId: online.branchId,
      assembly,
      resolved,
      runSpec: frozenSpec,
      manifest: rebuilt.manifest,
      manifestHash: storedHash,
      agents,
    },
    startup,
  };
}

/** 供启动编排复用的计划类型别名，避免重复导入。 */
export type { ResolvedServerAssembly };
