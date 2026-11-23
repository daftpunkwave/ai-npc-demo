/**
 * 打开服务端宿主：依次完成核心启动（内容/装配/存储/在线 run/模块）、权威网关装配、
 * 只读端口、客户端内容视图、运营编排、生命周期与传输应用，并返回可监听、可关闭的运行实例。
 * 依赖 host 子模块与 authority；不启动浏览器端，也不直接引用模块实现。
 * 禁止绕过解析计划引用模块实现、按当前入参重建已冻结的在线 run，或重复实现时钟状态与路由。
 */
import { Authority } from "@ai-npc/authority";
import { activateAgentRosterInTransaction, createCampaignStartActivationHook, SpeechApprovalIndex } from "@ai-npc/agent-runtime";
import { DomainError, modelLayoutRoutesResponseSchema, type Json, type StoragePort } from "@ai-npc/contracts";
import { catchUpWorldTick } from "./tick";
import { createClientContent } from "./host/client-content";
import { createHostStartup } from "./host/startup";
import { disposeInReverse } from "./host/dispose";
import { logInternalError } from "./host/internal-error-log";
import { createLifecycle } from "./host/lifecycle";
import type { LiveRunState } from "./host/live-state";
import { clockConfigOf, serverModuleDefinitions, worldChapterLengthOf, type ServerApp, type TransportPort } from "./host/module-catalog";
import type { HostOptions } from "./host/options";
import { OperationJournal } from "./host/operation-journal";
import { OnlineAgentHost } from "./host/online-agents";
import { createOperationsHost } from "./host/operations";
import { createReadPorts } from "./host/reads";
import { createTransportApp } from "./host/transport-app";
import { ModelLayoutAdminPort } from "./host/model-layout-admin";
import { createEvaluationReadPort } from "./host/evaluation-read";
import { resolve } from "node:path";
import { createRunWrites } from "./host/run-writes";
import { loadRoster } from "@ai-npc/experiment";
import { StoredAgentArtifactStore } from "@ai-npc/module-sdk";
import type { EvaluationPort } from "./host/module-catalog";

import type { HostStartup } from "./host/startup";

export type { HostOptions } from "./host/options";
export type { DisposalStep } from "./host/dispose";
export { disposeInReverse } from "./host/dispose";

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
  const authority = new Authority({
    storage: core.storage,
    host: core.host,
    content: core.gameContent,
    moduleBinder: core.runtime.binder,
    runSeed: core.active.runSpec.seed,
    approvedSpeech: approvals,
  });
  for (const contributor of core.runtime.contributors) {
    authority.registerModule(contributor);
  }
  if (rosterAgentIds !== undefined) {
    authority.hostAfterCommand(
      "agent-runtime",
      "campaign.start",
      createCampaignStartActivationHook({ agentIds: rosterAgentIds, nowIso: () => core.host.nowIso() }),
    );
  }

  const reads = createReadPorts({
    host: core.host,
    storage: core.storage,
    runtime: core.runtime,
    authority,
    gameContent: core.gameContent,
    active,
  });
  if (core.active.agents !== null) {
    agents = new OnlineAgentHost({ core, active, reads, authority, approvals, onStateChange: () => app?.notifyWorldChanged() });
  }
  const disposeResources = (transportApp: ServerApp | null): Promise<void> => disposeInReverse([
    { label: "storage", dispose: () => core.storageStarted.dispose() },
    { label: "started modules", dispose: () => core.startedModules.dispose() },
    { label: "online Agents", dispose: async () => { await agents?.close(); } },
    ...(transportApp === null ? [] : [{ label: "transport", dispose: () => core.runtime.transport.close(transportApp) }]),
  ]);
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
    disposeResources,
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
  const modelLayouts = new ModelLayoutAdminPort(    core.loadContext,
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
  const writes = createRunWrites({
    host: core.host,
    storage: core.storage,
    content: core.content,
    definitions: options.moduleDefinitions ?? serverModuleDefinitions,
    contentVersion: core.contentVersion,
    loadRoster: (rosterRef) => loadRoster(rosterRef, core.loadContext),
    worldId: core.active.worldId,
    // loadAssembly 期望仓库根目录并在其下拼接 `config/assemblies`；
    // 宿主的 configRoot 指向配置目录本身，因此取其父目录作为仓库根。
    repoRoot: resolve(resolve(options.configRoot ?? "config"), ".."),
    artifacts: new StoredAgentArtifactStore(core.storage, core.host),
  });
  const evaluation = evaluationPort === null ? undefined : createEvaluationReadPort({
    storage: core.storage,
    evaluation: evaluationPort,
    scripts: core.content.index.scripts,
    lexicons: core.content.locale.lexicons,
    pricingVersion: core.active.manifest.models === undefined ? "unknown" : pricingVersionOf(core.active.manifest.models),
  });

  const transportApp = await createTransportApp({
    host: core.host,
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
    writes,
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
