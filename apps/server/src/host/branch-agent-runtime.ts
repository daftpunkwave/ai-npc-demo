/**
 * 核心职责：为一个分支构造并启动 Agent 运行时：绑定世界读取、模块能力端口、turn 执行与命令提交入口。
 * 交互契约：依赖宿主启动聚合中已启动的部署级实例、run 的冻结 Agent 配置与已启动的 run 级调度/工具模块；
 * 命令经调用方给出的 run 命令网关提交，对白批准索引与该网关共用。
 * 约束与禁忌：只构造与启动，不负责释放 run 级模块；同一分支同一时刻只能有一个运行时实例。
 */
import { AgentRuntime, type SpeechApprovalIndex } from "@world-prism/agent-runtime";
import type { Authority } from "@world-prism/authority";
import type { AgentConfiguration } from "./agent-configuration";
import type { AgentRunModules } from "./agent-run-modules";
import { agentWorldReaders } from "./agent-world-read";
import type { HostReadPorts } from "./reads";
import type { HostStartup } from "./startup-types";

/** 打开分支运行时所需的输入。 */
export interface BranchAgentRuntimeInput {
  readonly core: HostStartup;
  readonly reads: HostReadPorts;
  readonly authority: Authority;
  readonly approvals: SpeechApprovalIndex;
  readonly agents: AgentConfiguration;
  readonly modules: AgentRunModules;
  readonly scope: { readonly worldId: string; readonly branchId: string };
  readonly runId: string;
  readonly runSeed: string;
  /** 探针沙盒的脚本标识；探针 turn 把回答写入 `probe_results` 时引用它。 */
  readonly probeScriptId?: string;
  readonly onStateChange: () => void;
}

/** 构造并启动分支的 Agent 运行时；启动失败时运行时自行释放已创建的槽位实例后抛出。 */
export async function openBranchAgentRuntime(input: BranchAgentRuntimeInput): Promise<AgentRuntime> {
  const { core, reads, authority, approvals, agents, modules, scope } = input;
  const { host, storage, content, gameContent } = core;
  const running = [...core.storageStarted.instances, ...core.startedModules.instances];
  const read = agentWorldReaders({ storage, reads, content: gameContent, scope });
  const ports = Object.fromEntries([...running, ...modules.started.instances]
    .flatMap((instance) => (agents.modules.get(instance.moduleId)?.provides ?? [])
      .map(({ capability }) => [capability, instance.port])));
  const runtime = new AgentRuntime({
    ...scope, runId: input.runId, storage, host, content,
    roster: agents.roster, profiles: agents.profiles, moduleDefinitions: agents.modules,
    scheduling: modules.scheduling, maxConcurrentTurns: modules.maxConcurrentTurns,
    ...(modules.patrolHour === undefined ? {} : { patrolHour: modules.patrolHour }),
    readWorlds: read.perception, onStateChange: input.onStateChange,
    turnExecution: {
      runSeed: input.runSeed, profileHashes: agents.profileHashes, tools: modules.tools,
      approvals, readWorld: read.decision, ports, model: modules.model,
      recordSpan: (span) => core.runtime.observability.recordSpan(span),
      executeCommand: (auth, envelope, operationId) => authority.commands.execute(auth, envelope, { operationId }),
      ...(input.probeScriptId === undefined ? {} : { probeScriptId: input.probeScriptId }),
    },
  });
  await runtime.start();
  return runtime;
}
