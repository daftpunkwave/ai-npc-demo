/**
 * 核心职责：声明宿主启动编排对外暴露的状态类型：活动 run、恢复结果、首次启动的待提交状态、
 * 会话装配与启动聚合。
 * 交互契约：启动编排与它的各步骤模块共享这些类型；实现模块只依赖类型，不互相导入实现。
 * 约束与禁忌：不包含任何运行逻辑，也不在此读取配置、存储或模块目录。
 */
import type { AssemblyDescriptor, HostServices, ResolvedModuleSet, StoragePort } from "@world-prism/contracts";
import type { ConfigLoadContext, ContentPack, RunSpec } from "@world-prism/experiment";
import type { StartedInstances } from "@world-prism/kernel";
import type { GameClockPort, GameContent } from "@world-prism/module-sdk";
import type { AgentConfiguration } from "./agent-configuration";
import type { AgentRunModules } from "./agent-run-modules";
import type { ResolvedServerAssembly } from "./assembly";
import type { RunManifest } from "./manifest";
import type { ServerRuntime } from "./module-catalog";

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

/** 恢复或重开后的活动 run 与启动计划；执行迁移时携带源分支标识与原状态供失败补偿。 */
export interface ResumedRunState {
  readonly active: ActiveRunState;
  readonly startup: ResolvedServerAssembly;
  readonly migratedFromBranchId?: string;
  /** 迁移前的源分支状态；有 migratedFromBranchId 时必定给出，补偿时原样写回。 */
  readonly migratedSourceBranchStatus?: "active" | "paused";
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

/** 启动完成后的宿主启动聚合：已启动实例、运行期端口与冻结的在线 run。 */
export interface HostStartup {
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
