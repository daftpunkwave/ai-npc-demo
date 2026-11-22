/**
 * 宿主核心启动：校验部署参数、加载内容与装配、启动存储、确定在线 run（首次创建或按冻结别名重启）、
 * 启动其余模块并构造运行期端口，最后把时钟停在暂停态。
 * 依赖 kernel 解析/生命周期、组合根模块目录、实验配置加载器、部署配置校验与存储事务。
 * 禁止绕过解析计划直接引用模块实现、按当前入参重建已冻结的在线 run，或在失败时留下已启动实例。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import { resolve } from "node:path";
import {
  assemblyDescriptorSchema,
  type AssemblyDescriptor,
  type HostServices,
  type Json,
  type ModuleDefinition,
  type ResolvedModuleSet,
  type StoragePort,
} from "@ai-npc/contracts";
import {
  loadContentPack,
  loadRoster,
  loadRunSpec,
  runSpecSchema,
  validateRoster,
  validateRunSpec,
  type ConfigLoadContext,
  type ContentPack,
  type RunSpec,
} from "@ai-npc/experiment";
import { startInstances, type StartedInstances } from "@ai-npc/kernel";
import { computeCatalogHash, createModuleRegistry } from "@ai-npc/kernel";
import type { GameClockPort, GameContent } from "@ai-npc/module-sdk";
import { assertDistinctTokens } from "../config";
import { canonicalHasher, createHostServices } from "../host-services";
import { resolveAgentConfiguration, type AgentConfiguration } from "./agent-configuration";
import { agentRunModuleIds, startAgentRunModules, type AgentRunModules } from "./agent-run-modules";
import {
  filterPlan,
  loadAssembly,
  loadAssemblies,
  resolveServerAssembly,
  resolveSessionAssemblies,
  type ResolvedServerAssembly,
} from "./assembly";
import { disposeInReverse } from "./dispose";
import { resolveFrozenAssembly } from "./frozen-assembly";
import { buildRunManifest, readFrozenManifest, type RunManifest } from "./manifest";
import { usesFixtureModelTransport } from "./model-configuration";
import {
  createServerRuntime,
  parseTransportConfig,
  plannedModuleForCapability,
  allModuleDefinitions,
  serverModuleDefinitions,
  toGameContent,
  type ServerRuntime,
} from "./module-catalog";
import { generateRunSeed } from "./random";
import { assertStorageCompatible, contentVersionMismatch, readOnlineEntry, type OnlineEntry } from "./online-entry";
import type { HostOptions } from "./options";
import {
  assertMigrationScopeIsCapabilityClosure,
  migrateOnlineRun,
  migrationSummary,
  OnlineRunMigrationRequiredError,
  restoreOnlineAliasToSourceBranch,
} from "./run-migration";

/** 本次启动实际使用的世界、装配、RunSpec 与冻结 manifest。 */
export interface ActiveRunState {
  readonly worldId: string;
  readonly branchId: string;
  readonly assembly: AssemblyDescriptor;
  readonly resolved: ResolvedServerAssembly;
  readonly runSpec: RunSpec;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
  readonly agents: AgentConfiguration | null;
}

/** 恢复或重开后的活动 run 与启动计划；执行迁移时携带源分支标识供失败补偿。 */
export interface ResumedRunState {
  readonly active: ActiveRunState;
  readonly startup: ResolvedServerAssembly;
  readonly migratedFromBranchId?: string;
}

/** 首次启动的待提交状态；时钟 provider 启动后再在同一事务内写入在线世界与初始时钟行。 */
export interface PendingFirstRun {
  readonly active: ActiveRunState;
  commit(clock: GameClockPort): void;
}

/** 浏览器 realm 的会话装配；未接线时由传输层按资源不存在处理。 */
export interface SessionAssemblies {
  readonly client: ResolvedModuleSet;
  readonly console: ResolvedModuleSet;
}

/** 启动完成后的宿主核心：已启动实例、运行期端口与冻结的在线 run。 */
export interface HostCore {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly storageStarted: StartedInstances;
  readonly startedModules: StartedInstances;
  readonly initialAgentModules: AgentRunModules | null;
  readonly runtime: ServerRuntime;
  readonly content: ContentPack;
  readonly gameContent: GameContent;
  readonly packId: string;
  readonly contentVersion: string;
  readonly loadContext: ConfigLoadContext;
  readonly active: ActiveRunState;
  readonly activeStartup: ResolvedServerAssembly;
  readonly sessionAssembly: SessionAssemblies;
}

const defaultPackId = "earth-2964-v1";
const defaultRunSpecRef = "online-default";
const defaultAssemblyRef = "local-slg-standard-v1";
const defaultRosterRef = "standard-15";

/** 打开并启动宿主核心；调用方负责之后的传输装配与端口监听。 */
export async function createHostCore(options: HostOptions): Promise<HostCore> {
  assertDistinctTokens([
    { label: "player token", credential: options.playerToken },
    { label: "console token", credential: options.consoleToken },
    { label: "operator role token", credential: options.operatorToken },
    { label: "researcher role token", credential: options.researcherToken },
    { label: "evaluator role token", credential: options.evaluatorToken },
  ]);
  const dataDir = resolve(options.dataDir);
  if (dataDir.length <= 3 || /^[A-Za-z]:\\?$/.test(dataDir)) {
    throw new Error("DATA_DIR 必须是具体目录，不能是磁盘根目录");
  }
  if (options.assembly !== undefined && options.assemblyRef !== undefined) {
    throw new Error("不能同时指定装配对象与装配引用");
  }
  const host = createHostServices();
  const signal = new AbortController().signal;
  const definitions: readonly ModuleDefinition[] = options.moduleDefinitions ?? serverModuleDefinitions;
  const packId = options.packId ?? defaultPackId;
  const configDir = resolve(options.configRoot ?? "config");
  const loadContext: ConfigLoadContext = { configDir, env: process.env };
  const content = loadContentPack(options.contentRoot ?? resolve(process.cwd(), "content"), packId);
  const gameContent = toGameContent(content);
  const contentVersion = content.pack.contentVersion;
  const requestedAssembly = options.assembly === undefined
    ? loadAssembly(options.assemblyRef ?? defaultAssemblyRef)
    : assemblyDescriptorSchema.parse(options.assembly);
  const transportConfig = parseTransportConfig({
    host: options.transportHost ?? "127.0.0.1",
    port: options.transportPort ?? 3000,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://127.0.0.1:3000"],
  });

  /** 部署期参数由宿主并入模块配置：数据目录与监听设置不写进装配，也不参与冻结摘要。 */
  const deploymentOverrides: Readonly<Record<string, Json>> = {
    "platform.storage.sqlite": { dataDir },
    "transport.http-ws.fastify": transportConfig as unknown as Json,
  };

  // 装配预检必须先于存储启动：缺失依赖、重复绑定、错误 realm 与非法配置都在打开数据库前失败。
  const requestedResolved = await resolveServerAssembly(requestedAssembly, definitions, { content });
  const requestedStartup = await resolveServerAssembly(requestedAssembly, definitions, {
    configOverrides: deploymentOverrides,
    content,
  });
  const storageModuleId = plannedModuleForCapability(requestedStartup.plan, "platform.storage").moduleId;
  const storageStarted = await startInstances(filterPlan(requestedStartup.plan, (moduleId) => moduleId === storageModuleId), {
    host,
    scope: {},
    signal,
  });
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把 StoragePort 判为 any。
  const storage = storageStarted.instances[0]?.port as StoragePort | undefined;
  if (storage === undefined) {
    await storageStarted.dispose();
    throw new Error("存储模块没有暴露 StoragePort");
  }

  /** 首次启动：用当前启动选择生成新 RunSpec、随机 seed 与冻结 manifest；提交函数在时钟 provider 启动后写入在线世界。 */
  const prepareFirstRun = async (): Promise<PendingFirstRun> => {
    const roster = loadRoster(options.rosterRef ?? defaultRosterRef, loadContext);
    validateRoster(roster.value, content);
    const runSpecRef = options.runSpecRef ?? (usesFixtureModelTransport(requestedResolved.plan) ? "online-model-test" : defaultRunSpecRef);
    const loaded = loadRunSpec(runSpecRef, loadContext, {
      seed: generateRunSeed(),
      moduleAssemblyRef: requestedAssembly.assemblyId,
      worldPackRef: packId,
      rosterRef: roster.value.rosterId,
      ...(options.modelLayoutRef === undefined ? {} : { modelLayoutRef: options.modelLayoutRef }),
    });
    validateRunSpec(loaded.value, content, roster);
    const agents = await resolveAgentConfiguration({
      assembly: requestedResolved, roster: roster.value, runSpec: loaded.value, loadContext, definitions, content,
    });
    const sealed = await buildRunManifest({
      runSpec: loaded.value,
      content: { packId, contentVersion },
      roster: roster.value,
      resolved: requestedResolved,
      ...(agents === null ? {} : { agentProfiles: agents.manifest }),
      ...(agents?.models ? { models: agents.models.manifest } : {}),
    });
    const worldId = host.ids("wld");
    const branchId = host.ids("br");
    const runId = host.ids("run");
    const createdAt = host.nowIso();
    return {
      active: {
        worldId,
        branchId,
        assembly: requestedAssembly,
        resolved: requestedResolved,
        runSpec: loaded.value,
        manifest: sealed.manifest,
        manifestHash: sealed.manifestHash,
        agents,
      },
      commit: (clock) => {
        storage.transact((tx) => {
          tx.rows("worlds").put({
            world_id: worldId,
            pack_id: packId,
            content_version: contentVersion,
            created_at: createdAt,
          });
          tx.rows("branches").put({
            branch_id: branchId,
            world_id: worldId,
            kind: "online",
            status: "active",
            parent_branch_id: null,
            forked_at_world_seq: null,
            run_id: runId,
            profile_hash: null,
            created_at: createdAt,
          });
          tx.rows("runs").put({
            run_id: runId,
            world_id: worldId,
            branch_id: branchId,
            mode: "live",
            status: "running",
            run_spec_json: loaded.value,
            manifest_json: sealed.manifest as unknown as Json,
            manifest_hash: sealed.manifestHash,
            contaminated: 0,
            evidence_complete: 1,
            created_at: createdAt,
            started_at: createdAt,
            ended_at: null,
          });
          // 初始时钟行由 provider 自己的有效配置写入，宿主不解析或构造 clock 行。
          clock.initializeInTransaction(tx, branchId);
          tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: createdAt });
        });
      },
    };
  };

  /** 重启：沿用在线别名指向的分支与已冻结 run，不复用当前入参重建 RunSpec。 */
  const resumeRun = async (online: OnlineEntry): Promise<ResumedRunState> => {
    // 本次启动执行迁移时记录源分支；宿主启动失败时按它恢复在线入口。
    let migratedSourceBranchId: string | null = null;
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
    const currentAssembly = loadAssembly(frozenSpec.moduleAssemblyRef);
    const compatible = await resolveFrozenAssembly(currentAssembly, definitions, facts);
    const { assembly } = compatible;
    const roster = loadRoster(frozenSpec.rosterRef, loadContext);
    validateRoster(roster.value, content);
    validateRunSpec(frozenSpec, content, roster);
    const resolved = await resolveServerAssembly(assembly, compatible.definitions, { content });
    const startup = await resolveServerAssembly(assembly, compatible.definitions, { configOverrides: deploymentOverrides, content });
    const agents = await resolveAgentConfiguration({
      assembly: resolved, roster: roster.value, runSpec: frozenSpec, loadContext, definitions: compatible.definitions,
      content, legacyDecision: compatible.legacyDecision,
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
      // 冻结 manifest 与当前解析结果不一致时，只有装配能力闭包差异（模块绑定集与摘要）允许显式迁移；
      // seed、RunSpec 选择、内容、名册或 Agent 配置任一差异都意味着这不是升级，拒绝迁移保持拒绝启动。
      assertMigrationScopeIsCapabilityClosure(manifestValue, rebuilt.manifest);
      const migrationInput = {
        storage,
        host,
        online,
        runSpec: frozenSpec as unknown as Json,
        manifest: rebuilt.manifest,
        manifestHash: rebuilt.manifestHash,
      };
      if (options.migrateOnlineRun !== true) {
        throw new OnlineRunMigrationRequiredError({
          runId: online.runId,
          branchId: online.branchId,
          detail: `冻结 manifest_hash「${storedHash}」，按当前装配与模块目录复算为「${rebuilt.manifestHash}」`,
        });
      }
      const migrated = migrateOnlineRun(migrationInput);
      migratedSourceBranchId = online.branchId;
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
        migratedFromBranchId: migratedSourceBranchId,
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
  };

  // 启动失败路径都以异常结束，因此正常走到这里时五种状态必然已赋值；activeStarted 保留可空用于失败清理。
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把 StartedInstances 判为 any。
  let activeStarted: StartedInstances | null = null;
  let initialAgentModules: AgentRunModules | null = null;
  let serverRuntime: ServerRuntime;
  let sessionAssemblies: SessionAssemblies;
  let active: ActiveRunState;
  let activeStartup: ResolvedServerAssembly;
  // 本次启动若执行了迁移，记录源分支；后续启动失败时按它恢复在线入口，避免失败后别名悬在新 run 上。
  let migratedSourceBranchId: string | null = null;
  try {
    const online = storage.transact(readOnlineEntry);

    let chosen: ActiveRunState;
    let startup: ResolvedServerAssembly;
    let pendingFirstRun: PendingFirstRun | null = null;
    if (online === null) {
      pendingFirstRun = await prepareFirstRun();
      chosen = pendingFirstRun.active;
      startup = requestedStartup;
    } else {
      const resumed = await resumeRun(online);
      chosen = resumed.active;
      startup = resumed.startup;
      migratedSourceBranchId = resumed.migratedFromBranchId ?? null;
    }
    assertStorageCompatible(startup.plan, requestedStartup.plan, storageModuleId);
    activeStartup = startup;
    active = chosen;
    // 在线装配确定后再启动其余模块；存储实例作为部署级 provider 复用，不重复创建。
    const agentModuleIds = chosen.agents === null ? new Set<string>() : agentRunModuleIds(startup.plan);
    activeStarted = await startInstances(filterPlan(startup.plan, (moduleId) =>
      moduleId !== storageModuleId && !agentModuleIds.has(moduleId)), {
      host,
      scope: { worldId: chosen.worldId, branchId: chosen.branchId },
      signal,
      running: storageStarted.instances,
    });
    serverRuntime = createServerRuntime({
      plan: startup.plan,
      instances: [...storageStarted.instances, ...activeStarted.instances],
      content: gameContent,
      host,
    });
    sessionAssemblies = await resolveSessionAssemblies(chosen.assembly, allModuleDefinitions);
    const moduleRegistry = createModuleRegistry();
    for (const definition of allModuleDefinitions) {
      moduleRegistry.register(definition);
    }
    const catalogHash = await computeCatalogHash(moduleRegistry.snapshot(), canonicalHasher);
    const adminAssemblies = [];
    for (const assembly of loadAssemblies()) {
      const server = await resolveServerAssembly(assembly, serverModuleDefinitions, { content });
      const browser = await resolveSessionAssemblies(assembly, allModuleDefinitions);
      adminAssemblies.push({
        source: "repo" as const,
        descriptor: assembly,
        resolved: {
          server: server.modules,
          client: browser.client,
          console: browser.console,
        },
      });
    }
    serverRuntime.moduleAdmin.bind({
      catalogHash,
      definitions: allModuleDefinitions,
      assemblies: adminAssemblies,
    });
    if (chosen.agents !== null) {
      initialAgentModules = await startAgentRunModules({
        plan: startup.plan, configuration: chosen.agents, content, host, scope: { worldId: chosen.worldId, branchId: chosen.branchId },
        running: [...storageStarted.instances, ...activeStarted.instances],
      });
    }
    if (pendingFirstRun !== null) {
      // 世界、分支、run、别名与初始时钟行在同一事务提交，时钟配置来自 provider。
      pendingFirstRun.commit(serverRuntime.clock);
    }
    const restoredClock = serverRuntime.clock.read(chosen.branchId);
    if (restoredClock.mode !== "paused") {
      const paused = serverRuntime.clock.pause(chosen.branchId);
      if (!paused.ok) {
        throw new Error(`启动时暂停时钟失败：${paused.reasonCode}`);
      }
    }
  } catch (error) {
    // 迁移已提交但启动失败：先把在线别名与源分支状态恢复到迁移前，源 run/分支回到可重启状态；
    // 迁移产生的新分支与新 run 留存为孤儿记录。补偿失败只记日志，不掩盖原始启动错误。
    if (migratedSourceBranchId !== null) {
      try {
        restoreOnlineAliasToSourceBranch(storage, host.nowIso(), migratedSourceBranchId);
        host.logger.info(`启动失败后已恢复在线入口到源分支 ${migratedSourceBranchId}`);
      } catch (compensationError) {
        host.logger.error("启动失败后恢复在线入口失败", {
          message: compensationError instanceof Error ? compensationError.message : String(compensationError),
        });
      }
    }
    // 启动失败时逆序释放已创建实例；清理失败只记日志，保留原始启动错误。
    try {
      await disposeInReverse([
        { label: "storage", dispose: () => storageStarted.dispose() },
        {
          label: "started modules",
          dispose: async () => {
            await activeStarted?.dispose();
          },
        },
        { label: "run Agent modules", dispose: async () => { await initialAgentModules?.started.dispose(); } },
      ]);
    } catch (cleanupError) {
      host.logger.error("启动失败后的清理未全部完成", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
  // 最后一道运行时防线：类型上均已赋值，避免将来重构漏赋值后静默返回未初始化状态。
  const runtimeState: readonly unknown[] = [activeStarted, serverRuntime, sessionAssemblies, active, activeStartup];
  if (runtimeState.some((value) => value === null || value === undefined)) {
    await disposeInReverse([{ label: "storage", dispose: () => storageStarted.dispose() }]);
    throw new Error("宿主运行时未初始化");
  }
  return {
    host,
    storage,
    storageStarted,
    startedModules: activeStarted,
    initialAgentModules,
    runtime: serverRuntime,
    content,
    gameContent,
    packId,
    contentVersion,
    loadContext,
    active,
    activeStartup,
    sessionAssembly: sessionAssemblies,
  };
}
