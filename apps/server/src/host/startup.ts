/**
 * 宿主启动编排：校验部署参数、加载内容与装配、启动存储、确定在线 run（首次创建或按冻结别名重启）、
 * 启动其余模块并构造运行期端口，最后把时钟停在暂停态。
 * 依赖 kernel 解析/生命周期、组合根模块目录、实验配置加载器、部署配置校验与存储事务。
 * 禁止绕过解析计划直接引用模块实现、按当前入参重建已冻结的在线 run，或在失败时留下已启动实例。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import { resolve } from "node:path";
import {
  assemblyDescriptorSchema,
  type AssemblyDescriptor,
  type Json,
  type ModuleDefinition,
  type StoragePort,
} from "@world-prism/contracts";
import {
  createConfigDocumentCache,
  loadContentPack,
  type ConfigLoadContext,
} from "@world-prism/experiment";
import { startInstances } from "@world-prism/kernel";
import { assertDistinctTokens } from "../config";
import { deploymentDefaults } from "../deployment-defaults";
import { createHostServices } from "../host-services";
import { createSpanTimings } from "./span-timings";
import { agentRunModuleIds, startAgentRunModules, type AgentRunModules } from "./agent-run-modules";
import {
  filterPlan,
  loadAssembly,
  loadAssemblies,
  resolveServerAssembly,
  resolveSessionAssemblies,
  type ResolvedServerAssembly,
} from "./assembly";
import { assertStorageCompatible, readOnlineEntry } from "./online-entry";
import type { HostOptions } from "./options";
import { restoreOnlineAliasToSourceBranch } from "./run-migration";
import { resolveModuleAdminCatalog } from "./module-admin-catalog";
import {
  createServerRuntime,
  parseTransportConfig,
  plannedModuleForCapability,
  allModuleDefinitions,
  serverModuleDefinitions,
  toGameContent,
} from "./module-catalog";
import { prepareFirstRun } from "./startup-first-run";
import { resumeRun } from "./startup-resume";
import { StartupResources } from "./startup-resources";
import type {
  ActiveRunState,
  HostStartup,
  PendingFirstRun,
  ResumedRunState,
  SessionAssemblies,
} from "./startup-types";

export type {
  ActiveRunState,
  HostStartup,
  PendingFirstRun,
  ResumedRunState,
  SessionAssemblies,
} from "./startup-types";

/** 打开并启动宿主；调用方负责之后的传输装配与端口监听。 */
export async function createHostStartup(options: HostOptions): Promise<HostStartup> {
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
  // 热路径耗时只在进程内汇总；控制台健康页经宿主读取，模块经 host.tracer 记录。
  const spanTimings = createSpanTimings({ now: () => performance.now() });
  const host = createHostServices({ tracer: spanTimings });
  const signal = new AbortController().signal;
  const definitions: readonly ModuleDefinition[] = options.moduleDefinitions ?? serverModuleDefinitions;
  const packId = options.packId ?? deploymentDefaults.contentPackId;
  const configDir = resolve(options.configRoot ?? "config");
  const loadContext: ConfigLoadContext = { configDir, env: process.env, cache: createConfigDocumentCache() };
  // 装配目录与当前装配在本函数内被反复使用：整份目录只读一次，当前装配复用同一份解析结果。
  const assemblies = loadAssemblies();
  const content = loadContentPack(options.contentRoot ?? resolve(process.cwd(), "content"), packId);
  const gameContent = toGameContent(content);
  const contentVersion = content.pack.contentVersion;
  const requestedAssembly = options.assembly === undefined
    ? loadAssembly(options.assemblyRef ?? deploymentDefaults.assemblyRef, process.cwd(), assemblies)
    : assemblyDescriptorSchema.parse(options.assembly);
  // allowedOrigins 未指定时交给传输配置 schema 的缺省值，宿主不再另存一份 Origin 列表。
  const transportConfig = parseTransportConfig({
    host: options.transportHost ?? "127.0.0.1",
    port: options.transportPort ?? 3000,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
  });

  /** 部署期参数由宿主并入模块配置：数据目录、保留天数与监听设置不写进装配，也不参与冻结摘要。 */
  const deploymentOverrides: Readonly<Record<string, Json>> = {
    "platform.storage.sqlite": {
      dataDir,
      ...(options.traceSpansRetentionDays === undefined
        ? {}
        : { retentionDays: { trace_spans: options.traceSpansRetentionDays } }),
    },
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

  const firstRunInput = {
    host,
    storage,
    definitions,
    content,
    contentVersion,
    packId,
    loadContext,
    requestedAssembly,
    requestedResolved,
    rosterRef: options.rosterRef ?? deploymentDefaults.rosterRef,
    runSpecRef: options.runSpecRef,
    modelLayoutRef: options.modelLayoutRef,
  } satisfies Parameters<typeof prepareFirstRun>[0];
  const resumeInput = {
    host,
    storage,
    definitions,
    content,
    contentVersion,
    packId,
    loadContext,
    assemblies,
    deploymentOverrides,
    migrateOnlineRun: options.migrateOnlineRun === true,
  };

  // 启动失败路径都以异常结束，因此正常走到这里时五种状态必然已赋值；activeStarted 保留可空用于失败清理。
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，把 StartedInstances 判为 any。
  let activeStarted: Awaited<ReturnType<typeof startInstances>> | null = null;
  let initialAgentModules: AgentRunModules | null = null;
  let serverRuntime: ReturnType<typeof createServerRuntime>;
  let sessionAssemblies: SessionAssemblies;
  let active: ActiveRunState;
  let activeStartup: ResolvedServerAssembly;
  // 本次启动若执行了迁移，记录源分支与其原状态；后续启动失败时按它恢复在线入口，避免失败后别名悬在新 run 上。
  let migrated: ResumedRunState | null = null;
  // 逆序清理链在一处完整表达：资源在取得处登记，失败与后续关闭复用同一份清单。
  const resources = new StartupResources();
  resources.track("storage", () => storageStarted.dispose());
  try {
    const online = storage.transact(readOnlineEntry);

    let chosen: ActiveRunState;
    let startup: ResolvedServerAssembly;
    let pendingFirstRun: PendingFirstRun | null = null;
    if (online === null) {
      pendingFirstRun = await prepareFirstRun(firstRunInput);
      chosen = pendingFirstRun.active;
      startup = requestedStartup;
    } else {
      const resumed = await resumeRun({ ...resumeInput, online });
      chosen = resumed.active;
      startup = resumed.startup;
      migrated = resumed;
    }
    assertStorageCompatible(startup.plan, requestedStartup.plan, storageModuleId);
    // 浏览器两段与 server 段同属在线装配：requiresRemote 缺口等装配不兼容要在启动其余模块之前拒绝。
    sessionAssemblies = await resolveSessionAssemblies(chosen.assembly, allModuleDefinitions);
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
    resources.track("started modules", () => activeStarted?.dispose() ?? Promise.resolve());
    serverRuntime = createServerRuntime({
      plan: startup.plan,
      instances: [...storageStarted.instances, ...activeStarted.instances],
      content: gameContent,
      host,
    });
    serverRuntime.moduleAdmin.bind(await resolveModuleAdminCatalog({ assemblies, content }));
    if (chosen.agents !== null) {
      initialAgentModules = await startAgentRunModules({
        plan: startup.plan, configuration: chosen.agents, content, host, scope: { worldId: chosen.worldId, branchId: chosen.branchId },
        running: [...storageStarted.instances, ...activeStarted.instances],
      });
      resources.track("run Agent modules", () => initialAgentModules?.started.dispose() ?? Promise.resolve());
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
    restoreMigratedAlias(migrated, storage, host);
    // 启动失败时逆序释放已登记资源；清理失败只记日志，保留原始启动错误。
    try {
      await resources.releaseAll();
    } catch (cleanupError) {
      host.logger.error("启动失败后的清理未全部完成", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
  // 最后一道运行时防线：类型上均已赋值，避免将来重构漏赋值后静默返回未初始化状态。
  if ([activeStarted, sessionAssemblies, active, activeStartup, serverRuntime].some((value) => value === undefined)) {
    await resources.releaseAll();
    throw new Error("宿主运行时未初始化");
  }
  return {
    host,
    spanTimings,
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

/**
 * 启动失败后撤销迁移：把在线别名与源分支状态恢复到迁移前，
 * 让源 run 与分支回到可重启状态；迁移产生的新分支与新 run 留存为孤儿记录。
 */
function restoreMigratedAlias(
  migrated: ResumedRunState | null,
  storage: StoragePort,
  host: ReturnType<typeof createHostServices>,
): void {
  if (migrated?.migratedFromBranchId === undefined) return;
  const branchId = migrated.migratedFromBranchId;
  const status = migrated.migratedSourceBranchStatus;
  // 源分支状态在迁移结果里给出；缺失说明迁移记录不完整，宁可保留原错误也不猜一个状态写回。
  if (status === undefined) {
    host.logger.error("启动失败后缺少迁移源分支状态，跳过在线入口补偿", { branchId });
    return;
  }
  try {
    restoreOnlineAliasToSourceBranch(storage, host.nowIso(), branchId, status);
    host.logger.info(`启动失败后已恢复在线入口到源分支 ${branchId}`);
  } catch (compensationError) {
    host.logger.error("启动失败后恢复在线入口失败", {
      message: compensationError instanceof Error ? compensationError.message : String(compensationError),
    });
  }
}
