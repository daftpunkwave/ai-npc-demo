/**
 * 核心职责：把 run 创建、启停控制、实验创建与导出组装成宿主可注入的写入端口，供控制台评估接口调用。
 * 交互契约：依赖宿主服务、存储、内容包、装配定义、配置加载上下文与 artifact 存储；各写操作各自独立完成。
 * 约束与禁忌：不启动 Agent 运行时、不推进时钟步进循环、不写世界状态；失败时不留下半个 run 或半个 artifact。
 */
import type { ContentPack, HostServices, Json, ModuleDefinition, Roster, StoragePort } from "@world-prism/contracts";
import type { ConfigLoadContext, LoadedConfig } from "@world-prism/experiment";
import { createRun, type RunCreateResult } from "./run-write";
import { exportRun } from "./run-export";
import { createExperiment, type ExperimentCreateResult } from "./experiment-write";
import { startRun, stopRun, type RunControlResult } from "./run-control";

/** 写入端口的输入；与读取端口共用同一份存储与内容视图。 */
export interface RunWritesInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly content: ContentPack;
  readonly definitions: readonly ModuleDefinition[];
  readonly contentVersion: string;
  /** 按引用加载名册；由宿主注入，使用与启动时相同的配置上下文。 */
  readonly loadRoster: (rosterRef: string) => LoadedConfig<Roster>;
  readonly worldId: string;
  readonly repoRoot: string;
  /** 配置加载上下文；实验规格解析与名册加载共用。 */
  readonly loadContext: ConfigLoadContext;
  /** artifact 存储；导出包的落盘目标。 */
  readonly artifacts: {
    put(input: { readonly runId: string | null; readonly kind: "export"; readonly value: Json }): Promise<{ readonly artifactId: string }>;
  };
}

/** 写入端口：控制台评估接口的写操作入口。 */
export interface RunWrites {
  /**
   * 创建 run。入参来自 HTTP 边界，因此按未知值接收：结构严格校验由 createRun
   * 用与配置文件相同的 RunSpec schema 完成，避免两个入口对同一字段形状给出不同结论。
   */
  createRun(runSpec: unknown): Promise<RunCreateResult>;
  /** 启动或恢复 run：置为 running 并确保分支时钟为运行态。 */
  startRun(runId: string, request: { readonly operationId: string; readonly principalId: string }): RunControlResult;
  /** 停止 run：置为 paused 并同步时钟。 */
  stopRun(runId: string, request: { readonly operationId: string; readonly principalId: string }): RunControlResult;
  /** 按实验规格展开并逐个创建 run；规格不合法时在创建前失败。 */
  createExperiment(request: {
    readonly experimentSpec: unknown;
  } | {
    readonly experimentRef: string;
  }): Promise<ExperimentCreateResult>;
  exportRun(request: {
    readonly runId: string;
    readonly redaction: "redacted" | "raw";
    readonly principalId: string;
  }): Promise<{ readonly artifactId: string }>;
}

/** 构造写入端口；各操作各自独立，互不共享中间状态。 */
export function createRunWrites(input: RunWritesInput): RunWrites {
  return {
    createRun: (runSpec) => createRun({
      host: input.host,
      storage: input.storage,
      content: input.content,
      definitions: input.definitions,
      contentVersion: input.contentVersion,
      loadRoster: input.loadRoster,
      worldId: input.worldId,
      repoRoot: input.repoRoot,
    }, runSpec),
    startRun: (runId, request) => startRun({ host: input.host, storage: input.storage, worldId: input.worldId }, runId, request),
    stopRun: (runId, request) => stopRun({ host: input.host, storage: input.storage, worldId: input.worldId }, runId, request),
    createExperiment: (request) => createExperiment({
      content: input.content,
      loadRoster: input.loadRoster,
      loadContext: input.loadContext,
      runWrite: {
        host: input.host,
        storage: input.storage,
        content: input.content,
        definitions: input.definitions,
        contentVersion: input.contentVersion,
        loadRoster: input.loadRoster,
        worldId: input.worldId,
        repoRoot: input.repoRoot,
      },
    }, request),
    exportRun: (request) => exportRun({
      host: input.host,
      storage: input.storage,
      artifacts: input.artifacts,
      principalId: request.principalId,
      worldId: input.worldId,
    }, request),
  };
}
