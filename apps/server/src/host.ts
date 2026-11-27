/**
 * 打开服务端宿主：依次完成核心启动（内容/装配/存储/在线 run/模块）、权威网关装配、
 * 只读端口与观测数据源绑定、客户端内容视图、运营编排、生命周期与传输应用，并返回可监听、可关闭的运行实例。
 * 依赖 host 子模块与 authority；不启动浏览器端，也不直接引用模块实现。
 * 禁止绕过解析计划引用模块实现、按当前入参重建已冻结的在线 run，或重复实现时钟状态与路由。
 */
import type { Authority } from "@world-prism/authority";
import { activateAgentRosterInTransaction, SpeechApprovalIndex } from "@world-prism/agent-runtime";
import { DomainError, modelLayoutRoutesResponseSchema, type Json, type StoragePort } from "@world-prism/contracts";
import { catchUpWorldTick } from "./tick";
import { createClientContent } from "./host/client-content";
import { createHostStartup } from "./host/startup";
import { disposeInReverse, disposeWithin, drainBeforeClose, type DrainFailure } from "./host/dispose";
import { logInternalError } from "./host/internal-error-log";
import { createLifecycle } from "./host/lifecycle";
import type { LiveRunState } from "./host/live-state";
import { clockConfigOf, serverModuleDefinitions, worldChapterLengthOf, type ServerApp, type TransportPort } from "./host/module-catalog";
import type { HostOptions } from "./host/options";
import { OperationJournal } from "./host/operation-journal";
import { OnlineAgentHost } from "./host/online-agents";
import { createOperationsHost } from "./host/operations";
import { createObservabilitySources } from "./host/observability-sources";
import { createReadPorts } from "./host/reads";
import { createTransportApp } from "./host/transport-app";
import { ModelLayoutAdminPort } from "./host/model-layout-admin";
import { createEvaluationReadPort } from "./host/evaluation-read";
import { resolve } from "node:path";
import { createRunWrites, type RunWrites } from "./host/run-writes";
import { createWorldAuthority } from "./host/world-authority";
import { ExperimentRunner } from "./host/experiment-runner";
import { loadRoster } from "@world-prism/experiment";
import { StoredAgentArtifactStore } from "@world-prism/module-sdk";
import type { EvaluationPort } from "./host/module-catalog";

import type { HostStartup } from "./host/startup";

export type { HostOptions } from "./host/options";
export type { DisposalStep, DrainFailure, DrainStep } from "./host/dispose";
export { disposeInReverse, disposeWithin, drainBeforeClose, settleWithin } from "./host/dispose";

/** 关闭时每级资源排空的默认预算；与租约期限解耦，只用于给关闭一个可终止的边界。 */
const defaultShutdownDrainMs = 10_000;

/**
 * 实验执行器单个 tick 或单个探针等待收敛的默认上限。
 * 它只用来把卡死显式报成失败：真实模型下一个 tick 可能串行跑多个 turn 与记忆整理，
 * 单个 turn 预算上限 90 秒、整理租约 2 分钟，上限必须远大于它们之和，避免把正常的慢 tick 误判为积压。
 */
const defaultExperimentSettleTimeoutMs = 30 * 60_000;

/** 收敛等待的轮询间隔；与 turn 就绪轮询的首档间隔一致。 */
const experimentPollIntervalMs = 25;

export interface RunningHost {
  readonly app: ServerApp;
  readonly storage: StoragePort;
  /** 命令网关；嵌入式宿主与测试可以按生产装配直接提交命令。 */
  readonly authority: Authority;
  readonly branchId: string;
  readonly worldId: string;
  readonly transport: TransportPort;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 从已启动实例中取出评估端口。
 * 装配未绑定 `platform.evaluation`（或绑定了替代实现而端口形状不同）时返回 null：
 * 评估路由随后按 not-ready 返回，宿主照常启动，不因为一个可选读取能力缺失而整体失败。
 */
function evaluationPortOf(core: HostStartup): EvaluationPort | null {
  const instance = [...core.storageStarted.instances, ...core.startedModules.instances]
    .find((running) => running.moduleId === "platform.evaluation.standard");
  const port = instance?.port;
  if (port === undefined || port === null || typeof port !== "object") return null;
  // 端口形状由模块自己声明；这里只确认三个读取入口都是函数，避免替代实现让路由在调用期崩溃。
  const candidate = port as Partial<EvaluationPort>;
  return typeof candidate.report === "function" && typeof candidate.experimentCells === "function"
    ? (port as EvaluationPort)
    : null;
}

/** 从冻结的模型配置里读出价目版本；未写时如实返回 unknown，不编造日期。 */
function pricingVersionOf(models: Json): string {
  if (typeof models !== "object" || models === null || Array.isArray(models)) return "unknown";
  const value = (models as Readonly<Record<string, Json>>)["pricingVersion"];
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/** 打开并启动服务端宿主；调用方负责监听端口与优雅关闭。 */
export async function startHost(options: HostOptions): Promise<RunningHost> {
  const core = await createHostStartup(options);
  let agents: OnlineAgentHost | null = null;
  let experiments: ExperimentRunner | null = null;
  let app: ServerApp | null = null;
  const active: LiveRunState = {
    branchId: core.active.branchId, worldId: core.active.worldId,
    onBranchChanged: () => agents?.requestSwitch(),
  };
  const clockConfig = clockConfigOf(core.activeStartup.plan);
  const journal = new OperationJournal(core.storage, () => core.host.nowIso(), (message, error) => {
    logInternalError(core.host.logger, message, error);
  });

  const approvals = new SpeechApprovalIndex();
  const rosterAgentIds = core.active.agents?.roster.agents.map(({ agentId }) => agentId);
  const authority = createWorldAuthority({ core, runSeed: core.active.runSpec.seed, approvals, rosterAgentIds });

  const reads = createReadPorts({
    host: core.host,
    storage: core.storage,
    runtime: core.runtime,
    authority,
    gameContent: core.gameContent,
    active,
  });
  // 观测 provider 只经数据源端口读取他人数据：事件、turn 证据与 Agent 状态由各自所有者的查询提供，
  // 角色位置经世界模块只读端口，tick 经时钟 provider。
  core.runtime.observability.bind(createObservabilitySources({
    storage: core.storage,
    host: core.host,
    worldTick: (tx, branchId) => core.runtime.clock.readInTransaction(tx, branchId).worldTick,
    worldIn: (tx, scope) => reads.portsIn(tx, scope)["game.world"],
  }));
  if (core.active.agents !== null) {
    agents = new OnlineAgentHost({ core, active, reads, authority, approvals, onStateChange: () => app?.notifyWorldChanged() });
  }
  // 关闭分两级：先按契约排空（停止新任务、等待提交边界），再逆序释放资源。
  // 排空预算来自宿主配置，未配置时用与租约解耦的默认值，避免单个卡住的 turn 无限拖住退出。
  // 整个关闭共享一次预算：每级只拿剩余时间，n 个层级不会累积成 n 倍预算。
  const shutdownBudgetMs = options.shutdownDrainMs ?? defaultShutdownDrainMs;
  // 只写标签、本次剩余预算与原因，不写可能含业务正文的整份上下文。
  const reportClose = (message: string, data: DrainFailure): void => {
    core.host.logger.warn(message, { label: data.label, deadlineMs: data.deadlineMs, message: data.message });
  };
  const drainResources = async (deadlineAt: number): Promise<void> => drainBeforeClose(
    [
      // 实验执行器最先排空：它在共享存储上驱动实验分支，必须在模块与存储释放前把当前 run 落为 paused。
      { label: "experiment runner", drain: async (deadlineMs) => { await experiments?.close(deadlineMs); } },
      { label: "online Agents", drain: async (deadlineMs) => { await agents?.drain(deadlineMs); } },
      { label: "started modules", drain: (deadlineMs) => core.startedModules.drain(deadlineMs) },
      { label: "storage", drain: (deadlineMs) => core.storageStarted.drain(deadlineMs) },
    ],
    Math.max(0, deadlineAt - Date.now()),
    reportClose,
  );
  const disposeResources = (transportApp: ServerApp | null): Promise<void> => disposeInReverse([
    { label: "storage", dispose: () => core.storageStarted.dispose() },
    { label: "started modules", dispose: () => core.startedModules.dispose() },
    { label: "online Agents", dispose: async () => { await agents?.close(); } },
    ...(transportApp === null ? [] : [{ label: "transport", dispose: () => core.runtime.transport.close(transportApp) }]),
  ]);
  const closeResources = async (transportApp: ServerApp | null): Promise<void> => {
    const deadlineAt = Date.now() + shutdownBudgetMs;
    // 先停止接受新请求：关闭传输监听放在排空之前，否则排空边界会被新到达的请求突破。
    // 传输实例本身仍保留到释放阶段，已建立的读请求可以在预算内收尾。
    if (transportApp !== null) core.runtime.transport.stopAccepting?.(transportApp);
    await drainResources(deadlineAt);
    // 释放同样受同一绝对截止时间约束：被放弃的释放仍在后台继续，不会阻塞进程退出。
    await disposeWithin(
      () => disposeResources(transportApp),
      Math.max(0, deadlineAt - Date.now()),
      "host resources",
      reportClose,
    );
  };
  try {
    await agents?.switch();
  } catch (error) {
    try {
      await disposeResources(null);
    } catch (cleanupError) {
      core.host.logger.error("Agent startup cleanup failed", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
  const lifecycle = createLifecycle({
    host: core.host,
    storage: core.storage,
    runtime: core.runtime,
    authority,
    active,
    autoPauseAfterDisconnectMs: clockConfig.autoPauseAfterDisconnectMs,
    // 投影里的 campaign 是当前分支唯一权威来源；未开局时禁止继续时钟。
    campaignStarted: () => reads.projection().campaign !== null,
    // 关闭走两级编排（排空后释放）；只有启动失败路径直接释放资源。
    closeResources,
    agentHealth: () => agents?.healthy ?? true,
  });
  const operations = createOperationsHost({
    host: core.host,
    storage: core.storage,
    runtime: core.runtime,
    active,
    journal,
    runSpec: core.active.runSpec,
    frozenManifest: core.active.manifest,
    frozenManifestHash: core.active.manifestHash,
    activeAssembly: core.active.assembly,
    packId: core.packId,
    contentVersion: core.contentVersion,
    content: core.content,
    loadContext: core.loadContext,
    activateRestoredRoster: (tx, branchId) => {
      if (rosterAgentIds === undefined) return;
      if (!tx.branch(branchId).table("agent_activations").list().some((row) => row["status"] === "dormant")) return;
      const activation = activateAgentRosterInTransaction({
        tx, branchId, agentIds: rosterAgentIds, nowIso: core.host.nowIso(),
      });
      if (activation.kind === "rejected") {
        throw new DomainError(activation.reasonCode, "Agent activation capacity exhausted.");
      }
    },
    clockState: () => lifecycle.clockState(),
    control: (mode, expectedRunVersion, ticks) => {
      if (mode === "step") {
        return lifecycle.control("step", expectedRunVersion, ticks ?? 0);
      }
      return lifecycle.control(mode, expectedRunVersion);
    },
    catchUpCurrentTick: () => {
      if (lifecycle.clockState().mode === "paused") agents?.fenceTurns("snapshot");
      catchUpWorldTick({
        storage: core.storage,
        clock: core.runtime.clock,
        authority,
        branchId: active.branchId,
      });
    },
  });

  const content = createClientContent(core.content, {
    secondsPerTick: clockConfig.secondsPerTick,
    evaluationTick: worldChapterLengthOf(core.activeStartup.plan),
  });
  const knownAgentIds = new Set([
    ...core.gameContent.characters.keys(),
    ...core.gameContent.factions.keys(),
  ]);
  const modelLayouts = new ModelLayoutAdminPort(
    core.loadContext,
    knownAgentIds,
    () => {
      const models = core.active.manifest.models;
      const routes = models !== null && !Array.isArray(models) && typeof models === "object"
        ? models["routes"] : undefined;
      const resolved = Array.isArray(routes)
        ? routes.flatMap((route) => {
          if (route === null || Array.isArray(route) || typeof route !== "object") return [];
          const { agentId, purpose, modelId, connectionId, adapterId, externalModel } = route;
          return [agentId, purpose, modelId, connectionId, adapterId, externalModel].every((value) =>
            typeof value === "string" && value.length > 0)
            ? [{ agentId, purpose, modelId, connectionId, adapterId, externalModel }]
            : [];
        })
        : [];
      return modelLayoutRoutesResponseSchema.parse({ routes: resolved });
    },
    () => core.active.manifest.selection.modelLayoutRef ?? null,
  );

  // 评估端口是可选能力：装配未绑定或替代实现形状不符时保持 null，路由按 not-ready 返回。
  const evaluationPort = evaluationPortOf(core);
  // 写入能力（创建 run、导出）只依赖存储、内容与装配定义，不依赖评估模块；
  // 计分与报告才需要评估端口，因此两者分开注入，评估模块缺失时写入仍然可用。
  // 创建 run 与实验执行器复算冻结配置共用同一组依赖，二者对同一 RunSpec 不会解析出不同结果。
  const runConfiguration = {
    content: core.content,
    definitions: options.moduleDefinitions ?? serverModuleDefinitions,
    contentVersion: core.contentVersion,
    loadRoster: (rosterRef: string) => loadRoster(rosterRef, core.loadContext),
    loadContext: core.loadContext,
    // loadAssembly 期望仓库根目录并在其下拼接 `config/assemblies`；
    // 宿主的 configRoot 指向配置目录本身，因此取其父目录作为仓库根。
    repoRoot: resolve(resolve(options.configRoot ?? "config"), ".."),
  };
  const writes = createRunWrites({
    ...runConfiguration,
    host: core.host,
    storage: core.storage,
    worldId: core.active.worldId,
    artifacts: new StoredAgentArtifactStore(core.storage, core.host),
  });
  const evaluation = evaluationPort === null ? undefined : createEvaluationReadPort({
    storage: core.storage,
    evaluation: evaluationPort,
    scripts: core.content.index.scripts,
    lexicons: core.content.locale.lexicons,
    pricingVersion: core.active.manifest.models === undefined ? "unknown" : pricingVersionOf(core.active.manifest.models),
    worldId: core.active.worldId,
  });
  const runner = new ExperimentRunner({
    core, reads, runConfiguration,
    report: evaluation === undefined ? null : (runId) => evaluation.report(runId),
    settleTimeoutMs: options.experimentSettleTimeoutMs ?? defaultExperimentSettleTimeoutMs,
    pollIntervalMs: experimentPollIntervalMs,
  }, core.active.worldId);
  experiments = runner;
  // 上次进程遗留的 running 实验 run 没有驱动者：先归位为 paused，由研究员显式继续。
  runner.recoverInterrupted();
  // 启动接口只改 run 状态与时钟；执行器在状态提交后被唤醒，按启动顺序逐个驱动。
  const runWrites: RunWrites = {
    ...writes,
    startRun: (runId, request) => {
      const result = writes.startRun(runId, request);
      runner.wake();
      return result;
    },
  };

  const transportApp = await createTransportApp({
    host: core.host,
    hotPathTimings: () => core.spanTimings.summaries(),
    options,
    runtime: core.runtime,
    active,
    authority,
    assembly: core.active.resolved.modules,
    reads,
    operations,
    lifecycle,
    gameContent: core.gameContent,
    content,
    sessionAssembly: core.sessionAssembly,
    modelLayouts,
    evaluation,
    writes: runWrites,
    runProgress: (runId) => runner.progress(runId),
    // 未启动 Agent 运行时（无 Agent 名册）时没有维护队列，健康摘要按零值展示。
    ...(agents === null ? {} : { maintenanceQueue: () => agents.maintenanceQueue }),
    // 世界变化同时驱动传输推送与 Agent 运行时：tick 推进、命令提交后立即重跑一轮，
    // 不再等下一次空闲巡检。
    ...(agents === null ? {} : { onWorldCommitted: () => agents?.notifyWorldChanged() }),
    disposeOnFailure: () => disposeResources(null),
  });

  app = transportApp;
  lifecycle.attachApp(transportApp);
  lifecycle.start();

  return {
    app: transportApp,
    storage: core.storage,
    authority,
    // 在线分支切换后仍反映当前在线入口，调用方不需要重新启动宿主即可读取。
    get branchId(): string {
      return active.branchId;
    },
    get worldId(): string {
      return active.worldId;
    },
    transport: core.runtime.transport,
    listen: () => core.runtime.transport.listen(transportApp),
    close: () => lifecycle.close(),
  };
}
