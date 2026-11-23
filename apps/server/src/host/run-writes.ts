/**
 * 核心职责：把 run 的创建与导出组装成宿主可注入的写入端口，供控制台评估接口调用。
 * 交互契约：依赖宿主服务、存储、内容包、装配定义与 artifact 存储；两个操作各自独立完成。
 * 约束与禁忌：不启动 Agent 运行时、不推进时钟、不写世界状态；失败时不留下半个 run 或半个 artifact。
 */
import type { HostServices, Json, ModuleDefinition, StoragePort } from "@ai-npc/contracts";
import type { ContentPack, LoadedConfig, Roster, RunSpec } from "@ai-npc/experiment";
import { createRun, type RunCreateResult } from "./run-write";
import { exportRun } from "./run-export";

/** 写入端口的输入；与读取端口共用同一份存储与内容视图。 */
export interface RunWritesInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly content: ContentPack;
  readonly definitions: readonly ModuleDefinition[];
  readonly contentVersion: string;
  readonly roster: LoadedConfig<Roster>;
  readonly worldId: string;
  readonly repoRoot: string;
  /** artifact 存储；导出包的落盘目标。 */
  readonly artifacts: {
    put(input: { readonly runId: string | null; readonly kind: "export"; readonly value: Json }): Promise<{ readonly artifactId: string }>;
  };
}

/** 写入端口：控制台评估接口的写操作入口。 */
export interface RunWrites {
  createRun(runSpec: RunSpec): Promise<RunCreateResult>;
  exportRun(request: {
    readonly runId: string;
    readonly redaction: "redacted" | "raw";
    readonly principalId: string;
  }): Promise<{ readonly artifactId: string }>;
}

/** 构造写入端口；两个操作各自独立，互不共享中间状态。 */
export function createRunWrites(input: RunWritesInput): RunWrites {
  return {
    createRun: (runSpec) => createRun({
      host: input.host,
      storage: input.storage,
      content: input.content,
      definitions: input.definitions,
      contentVersion: input.contentVersion,
      roster: input.roster,
      worldId: input.worldId,
      repoRoot: input.repoRoot,
    }, runSpec),
    exportRun: (request) => exportRun({
      host: input.host,
      storage: input.storage,
      artifacts: input.artifacts,
      principalId: request.principalId,
    }, request),
  };
}
