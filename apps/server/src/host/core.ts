/**
 * 宿主核心启动：校验部署参数、加载内容与装配、启动存储、确定在线 run（首次创建或按冻结别名重启）、
 * 启动其余模块并构造运行期端口，最后把时钟停在暂停态。
 * 依赖 kernel 解析/生命周期、组合根模块目录、实验配置加载器、部署配置校验与存储事务。
 * 禁止绕过解析计划直接引用模块实现、按当前入参重建已冻结的在线 run，或在失败时留下已启动实例。
 */
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
import type { GameClockPort, GameContent } from "@ai-npc/module-sdk";
import { assertDistinctTokens } from "../config";
import { createHostServices } from "../host-services";
import {
  filterPlan,
  loadAssembly,
  resolveServerAssembly,
  resolveSessionAssemblies,
  type ResolvedServerAssembly,
} from "./assembly";
import { disposeInReverse } from "./dispose";
import { buildRunManifest, readFrozenManifest, type RunManifest } from "./manifest";
import {
  createServerRuntime,
  parseTransportConfig,
  plannedModuleForCapability,
  serverModuleDefinitions,
  toGameContent,
  type ServerRuntime,
} from "./module-catalog";
import { generateRunSeed } from "./random";
import { assertStorageCompatible, contentVersionMismatch, readOnlineEntry, type OnlineEntry } from "./online-entry";
import type { HostOptions } from "./options";

/** 本次启动实际使用的世界、装配、RunSpec 与冻结 manifest。 */
export interface ActiveRunState {
  readonly worldId: string;
  readonly branchId: string;
  readonly assembly: AssemblyDescriptor;
  readonly resolved: ResolvedServerAssembly;
  readonly runSpec: RunSpec;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

/** 恢复或重开后的活动 run 与启动计划。 */
export interface ResumedRunState {
  readonly active: ActiveRunState;
  readonly startup: ResolvedServerAssembly;
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
const defaultRosterRef = "standard-20";

/** 打开并启动宿主核心；调用方负责之后的传输装配与端口监听。 */
export async function createHostCore(options: HostOptions): Promise<HostCore> {
  assertDistinctTokens([
    { label: "玩家令牌", token: options.playerToken },
    { label: "控制台令牌", token: options.consoleToken },
    { label: "operator 单角色令牌", token: options.operatorToken },
    { label: "researcher 单角色令牌", token: options.researcherToken },
    { label: "evaluator 单角色令牌", token: options.evaluatorToken },
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
  const configDir = resolve(process.cwd(), "config");
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
  const requestedResolved = await resolveServerAssembly(requestedAssembly, definitions);
  const requestedStartup = await resolveServerAssembly(requestedAssembly, definitions, {
    configOverrides: deploymentOverrides,
  });
  const storageModuleId = plannedModuleForCapability(requestedStartup.plan, "platform.storage").moduleId;
  const storageStarted = await startInstances(filterPlan(requestedStartup.plan, (moduleId) => moduleId === storageModuleId), {
    host,
    scope: {},
    signal,
  });
  const storage = storageStarted.instances[0]?.port as StoragePort | undefined;
  if (storage === undefined) {
    await storageStarted.dispose();
    throw new Error("存储模块没有暴露 StoragePort");
  }

  /** 首次启动：用当前启动选择生成新 RunSpec、随机 seed 与冻结 manifest；提交函数在时钟 provider 启动后写入在线世界。 */
  const prepareFirstRun = async (): Promise<PendingFirstRun> => {
    const roster = loadRoster(options.rosterRef ?? defaultRosterRef, loadContext);
    validateRoster(roster.value, content);
    const loaded = loadRunSpec(options.runSpecRef ?? defaultRunSpecRef, loadContext, {
      seed: generateRunSeed(),
      moduleAssemblyRef: requestedAssembly.assemblyId,
      worldPackRef: packId,
      rosterRef: roster.value.rosterId,
      ...(options.modelLayoutRef === undefined ? {} : { modelLayoutRef: options.modelLayoutRef }),
    });
    validateRunSpec(loaded.value, content, roster);
    const sealed = await buildRunManifest({
      runSpec: loaded.value,
      content: { packId, contentVersion },
      roster: roster.value,
      resolved: requestedResolved,
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
    const assembly = loadAssembly(frozenSpec.moduleAssemblyRef);
    const roster = loadRoster(frozenSpec.rosterRef, loadContext);
    validateRoster(roster.value, content);
    validateRunSpec(frozenSpec, content, roster);
    const resolved = await resolveServerAssembly(assembly, definitions);
    const startup = await resolveServerAssembly(assembly, definitions, { configOverrides: deploymentOverrides });
    const rebuilt = await buildRunManifest({
      runSpec: frozenSpec,
      content: { packId, contentVersion },
      roster: roster.value,
      resolved,
    });
    const storedHash = typeof run["manifest_hash"] === "string" ? run["manifest_hash"] : "";
    if (storedHash.length === 0) {
      throw new Error("在线 run 缺少 manifest_hash，拒绝按当前入参重建");
    }
    if (rebuilt.manifestHash !== storedHash) {
      throw new Error("冻结 manifest 无法复算：装配、名册或内容版本与 run 记录不一致");
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
      },
      startup,
    };
  };

  let activeStarted: StartedInstances | null = null;
  let serverRuntime: ServerRuntime | null = null;
  let sessionAssemblies: SessionAssemblies | null = null;
  let active: ActiveRunState | null = null;
  let activeStartup: ResolvedServerAssembly | null = null;
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
    }
    assertStorageCompatible(startup.plan, requestedStartup.plan, storageModuleId);
    activeStartup = startup;
    active = chosen;
    // 在线装配确定后再启动其余模块；存储实例作为部署级 provider 复用，不重复创建。
    activeStarted = await startInstances(filterPlan(startup.plan, (moduleId) => moduleId !== storageModuleId), {
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
    sessionAssemblies = await resolveSessionAssemblies(chosen.assembly, definitions);
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
    // 启动失败时逆序释放已创建实例；清理失败只记日志，保留原始启动错误。
    try {
      await disposeInReverse([
        { label: "存储", dispose: () => storageStarted.dispose() },
        {
          label: "已启动模块",
          dispose: async () => {
            await activeStarted?.dispose();
          },
        },
      ]);
    } catch (cleanupError) {
      host.logger.error("启动失败后的清理未全部完成", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
  if (
    activeStarted === null ||
    serverRuntime === null ||
    sessionAssemblies === null ||
    active === null ||
    activeStartup === null
  ) {
    await disposeInReverse([{ label: "存储", dispose: () => storageStarted.dispose() }]);
    throw new Error("宿主运行时未初始化");
  }
  return {
    host,
    storage,
    storageStarted,
    startedModules: activeStarted,
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
