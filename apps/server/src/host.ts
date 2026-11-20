/**
 * 打开服务端宿主：依次完成核心启动（内容/装配/存储/在线 run/模块）、权威网关装配、
 * 只读端口、运营编排、生命周期与传输应用，并返回可监听、可关闭的运行实例。
 * 依赖 host 子模块与 authority；不启动浏览器端，也不直接引用模块实现。
 * 禁止绕过解析计划引用模块实现、按当前入参重建已冻结的在线 run，或重复实现时钟状态与路由。
 */
import { Authority } from "@ai-npc/authority";
import type { StoragePort } from "@ai-npc/contracts";
import { catchUpWorldTick } from "./tick";
import { createHostCore } from "./host/core";
import { disposeInReverse } from "./host/dispose";
import { createLifecycle } from "./host/lifecycle";
import type { LiveRunState } from "./host/live-state";
import { clockConfigOf, type ServerApp, type TransportPort } from "./host/module-catalog";
import type { HostOptions } from "./host/options";
import { OperationJournal } from "./host/operation-journal";
import { createOperationsHost } from "./host/operations";
import { createReadPorts } from "./host/reads";
import { createTransportApp } from "./host/transport-app";

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

/** 打开并启动服务端宿主；调用方负责监听端口与优雅关闭。 */
export async function startHost(options: HostOptions): Promise<RunningHost> {
  const core = await createHostCore(options);
  const active: LiveRunState = { branchId: core.active.branchId, worldId: core.active.worldId };
  const journal = new OperationJournal(core.storage, () => core.host.nowIso(), (message, error) => {
    core.host.logger.error(message, { message: error instanceof Error ? error.message : String(error) });
  });

  const authority = new Authority({
    storage: core.storage,
    host: core.host,
    content: core.gameContent,
    moduleBinder: core.runtime.binder,
    runSeed: core.active.runSpec.seed,
  });
  for (const contributor of core.runtime.contributors) {
    authority.registerModule(contributor);
  }

  const reads = createReadPorts({
    host: core.host,
    storage: core.storage,
    runtime: core.runtime,
    authority,
    gameContent: core.gameContent,
    active,
  });
  const lifecycle = createLifecycle({
    host: core.host,
    storage: core.storage,
    runtime: core.runtime,
    authority,
    active,
    autoPauseAfterDisconnectMs: clockConfigOf(core.activeStartup.plan).autoPauseAfterDisconnectMs,
    disposeResources: (app) =>
      disposeInReverse([
        { label: "storage", dispose: () => core.storageStarted.dispose() },
        { label: "started modules", dispose: () => core.startedModules.dispose() },
        ...(app === null
          ? []
          : [{ label: "transport", dispose: () => core.runtime.transport.close(app) }]),
      ]),
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
    clockState: () => lifecycle.clockState(),
    control: (mode, expectedRunVersion) => lifecycle.control(mode, expectedRunVersion),
    catchUpCurrentTick: () =>
      catchUpWorldTick({
        storage: core.storage,
        clock: core.runtime.clock,
        authority,
        branchId: active.branchId,
      }),
  });

  const app = await createTransportApp({
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
    sessionAssembly: core.sessionAssembly,
    disposeOnFailure: () =>
      disposeInReverse([
        { label: "storage", dispose: () => core.storageStarted.dispose() },
        { label: "started modules", dispose: () => core.startedModules.dispose() },
      ]),
  });

  lifecycle.attachApp(app);
  lifecycle.start();

  return {
    app,
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
    listen: () => core.runtime.transport.listen(app),
    close: () => lifecycle.close(),
  };
}
