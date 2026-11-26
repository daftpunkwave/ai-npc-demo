/**
 * 传输应用装配：把权威网关、只读端口、运营服务、生命周期与身份令牌接到传输 provider 的公开端口。
 * 依赖传输模块的 createApp、权限/存档/会话端口与宿主配置；不实现路由、不接触 Fastify 类型。
 * 禁止在传输层内重算授权、把内部错误细节交给客户端，或在创建失败后留下已启动资源。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Authority } from "@ai-npc/authority";
import { listRuleFailures, type RuleFailureRecord } from "@ai-npc/authority";
import type { AuthContext, ClientContentView, HostServices, ResolvedModuleSet, StartOption, StoragePort } from "@ai-npc/contracts";
import type { GameContent } from "@ai-npc/module-sdk";
import { consoleStaticDirRelativeToRoot } from "../config";
import { clockView } from "./clock-view";
import { logInternalError } from "./internal-error-log";
import type { HostLifecycle } from "./lifecycle";
import { switchLiveBranch, type LiveRunState } from "./live-state";
import type { OperationsFactory, ServerApp, ServerIdentity, ServerRuntime } from "./module-catalog";
import type { HostOptions } from "./options";
import type { HostReadPorts } from "./reads";
import type { SessionAssemblies } from "./startup";
import type { ModelLayoutAdminPort } from "./model-layout-admin";
import { createConsoleResearchPort } from "./console-research";
import type { EvaluationReadPort } from "./evaluation-read";
import type { RunWrites } from "./run-writes";

export interface TransportAppInput {
  readonly host: HostServices;
  readonly options: HostOptions;
  readonly runtime: ServerRuntime;
  readonly active: LiveRunState;
  readonly authority: Authority;
  /** 服务端 realm 的已解析模块集；只含模块身份与能力。 */
  readonly assembly: ResolvedModuleSet;
  readonly reads: HostReadPorts;
  readonly operations: ReturnType<OperationsFactory["create"]>;
  readonly lifecycle: HostLifecycle;
  readonly gameContent: GameContent;
  /** 客户端只读内容视图：章节名、时钟刻度与界面文字。 */
  readonly content: ClientContentView;
  readonly sessionAssembly: SessionAssemblies;
  /** 仓库模型布局只读端口；未注入时控制台模型页返回 not-ready。 */
  readonly modelLayouts?: ModelLayoutAdminPort;
  /** 评估只读端口；未注入时评估读取路由返回 not-ready。 */
  readonly evaluation?: EvaluationReadPort;
  /** 评估写入端口；不依赖评估模块，未注入时写入路由返回 not-ready。 */
  readonly writes?: RunWrites;
  /**
   * 已用尽尝试次数的记忆维护任务数；宿主未启动 Agent 运行时时不提供，
   * 健康摘要在这种情况下按 0 展示而不是编造数字。
   */
  readonly maintenanceQueued?: () => number;
  /** 测试或嵌入式宿主可覆盖控制台静态目录；生产默认使用仓库内生成目录。 */
  readonly consoleStaticDir?: string;
  /** 创建失败时释放已启动模块与存储；只记日志，保留原始错误。 */
  readonly disposeOnFailure: () => Promise<void>;
}

/** 健康摘要中的失败描述：只说明位置与状态，不携带处理器内部消息。 */
function failureSafeMessage(record: RuleFailureRecord): string {
  const state = record.status === "failed" ? "已停止重试" : "等待重试";
  switch (record.phase) {
    case "job":
      return `job ${record.subjectId} 连续失败，${state}`;
    case "event":
      return `事件消费者 ${record.subjectId} 处理事件 ${record.detail} 失败，${state}`;
    case "clock-step":
      return `时钟步骤 ${record.subjectId} 在 tick ${record.detail} 失败，${state}`;
    case "worker":
      return `tick worker 失败，${state}`;
  }
}

/** 汇总最近失败；健康摘要只读存储，不触发重试或推进。 */
function recentFailures(storage: StoragePort, branchId: string) {
  return listRuleFailures(storage, branchId, 10).map((record) => ({
    code: record.reasonCode,
    safeMessage: failureSafeMessage(record),
    occurredAt: record.updatedAt,
    traceId: null,
  }));
}

/** 预算摘要条目上限：按用途聚合后取用量最大的若干条，避免列表随用途数无界增长。 */
const budgetSummaryLimit = 20;

/**
 * 控制台静态目录的宿主级缺省值：与导入该模块的源文件位置绑定，而不是进程工作目录。
 * 本文件位于 apps/server/src/host/，源文件目录到仓库根要上溯四级（host → src → server → apps → 根），
 * 再拼上仓库内的相对构建输出位置。嵌入式宿主（测试、脚本）没有经过部署配置时仍指向同一目录。
 */
function consoleStaticDirFromProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..", consoleStaticDirRelativeToRoot);
}

/**
 * 在一次事务内读取健康摘要需要的队列计数与预算聚合。
 *
 * 运行 ID 由 `branches.run_id` 给出：内存里的在线状态只保存分支，运行归属始终以存储为准。
 * 预算取 `budget_ledger` 的实际用量，未结算条目按预留量计入（与预算裁决口径一致），
 * 使控制台在模型调用发生后看到真实消耗，而不是恒为空的列表。
 * 两者合并在一个事务里，是因为健康摘要由 2 秒广播驱动，多开一次事务是纯额外开销。
 */
function healthStorageSummary(storage: StoragePort, branchId: string) {
  const chargedTokens = "COALESCE(actual_input, reserved_input) + COALESCE(actual_output, reserved_output)";
  return storage.transact((tx) => {
    const turnsQueued = tx.rows("turn_runs").count({ branch_id: branchId, status: "queued" });
    const runId = tx.rows("branches").get({ branch_id: branchId })?.["run_id"];
    if (typeof runId !== "string" || runId.length === 0) {
      return { turnsQueued, budgets: [] };
    }
    const budgets = tx
      .all(
        `SELECT purpose,
                SUM(${chargedTokens}) AS tokens
           FROM budget_ledger
          WHERE run_id = ?
          GROUP BY purpose
          ORDER BY tokens DESC
          LIMIT ?`,
        [runId, budgetSummaryLimit],
      )
      .map((row) => ({
        scope: "purpose" as const,
        key: String(row["purpose"]),
        used: Number(row["tokens"] ?? 0),
        limit: null,
        unit: "tokens" as const,
      }));
    return { turnsQueued, budgets };
  });
}

/** 开局选项：只列出内容中启用的开局，派系名、首个委托与接触角色都取自内容包索引。 */
function startOptions(content: GameContent): StartOption[] {
  return [...content.starts.values()]
    .filter((start) => start.enabled !== false)
    .map((start) => ({
      factionId: start.factionId,
      name: content.factions.get(start.factionId)?.name ?? start.factionId,
      commission: start.commission,
      contacts: start.contacts.map((agentId) => {
        const character = content.characters.get(agentId);
        const faction = content.factions.get(agentId);
        return {
          agentId,
          name: character?.name ?? faction?.leaderName ?? agentId,
        };
      }),
    }));
}

/** 按启动令牌构造传输层身份；主体和角色只来自宿主配置。 */
function createIdentity(
  token: string,
  principalId: string,
  kind: AuthContext["kind"],
  roles: readonly string[],
  worldId: string,
  branchId: string,
): ServerIdentity {
  return {
    token,
    auth: {
      principalId,
      kind,
      roles: [...roles],
      worldId,
      branchId,
      actingAsAgentId: null,
      controllerEpoch: null,
      turnLeaseEpoch: null,
      turnId: null,
    },
  };
}

/** 构造浏览器与服务端共用的身份表；可选单角色令牌只发放对应角色。 */
export function serverIdentities(options: HostOptions, active: LiveRunState): readonly ServerIdentity[] {
  return [
    createIdentity(options.playerToken, "player-1", "player", ["player"], active.worldId, active.branchId),
    createIdentity(
      options.consoleToken,
      "console-admin",
      "operator",
      ["operator", "researcher", "evaluator"],
      active.worldId,
      active.branchId,
    ),
    ...(options.operatorToken === undefined
      ? []
      : [createIdentity(options.operatorToken, "console-operator", "operator", ["operator"], active.worldId, active.branchId)]),
    ...(options.researcherToken === undefined
      ? []
      : [createIdentity(options.researcherToken, "console-researcher", "researcher", ["researcher"], active.worldId, active.branchId)]),
    ...(options.evaluatorToken === undefined
      ? []
      : [createIdentity(options.evaluatorToken, "console-evaluator", "evaluator", ["evaluator"], active.worldId, active.branchId)]),
  ];
}

/** 创建传输应用；调用方负责之后监听端口并在关闭时释放。 */
export async function createTransportApp(input: TransportAppInput): Promise<ServerApp> {
  const { host, options, runtime, active, authority, reads, operations, lifecycle, gameContent, evaluation, writes } = input;
  // 静态目录必须由部署参数给出：调用方缺省时按项目根下的固定构建输出位置解析，
  // 不读 process.cwd()，否则从仓库根以外的工作目录启动会挂载到一个空的 console-static。
  const consoleStaticDir = resolve(
    input.consoleStaticDir ?? options.consoleStaticDir ?? consoleStaticDirFromProjectRoot(),
  );
  try {
    // 开发宿主与控制台构建并行启动：目录先存在，静态路由按请求路径读盘，构建完成后无需重启服务端。
    mkdirSync(consoleStaticDir, { recursive: true });
    const research = createConsoleResearchPort({
      runtime,
      reads,
      currentWorldId: () => active.worldId,
      content: gameContent,
    });
    const modelLayouts = input.modelLayouts;
    return await runtime.transport.createApp({
      ...(options.rateLimits === undefined ? {} : { rateLimits: options.rateLimits }),
      authority,
      accessPolicy: runtime.accessPolicy,
      receipts: reads.receipts,
      worldId: active.worldId,
      branchId: active.branchId,
      assembly: input.assembly,
      sessionAssembly: input.sessionAssembly,
      starts: () => startOptions(gameContent),
      content: () => input.content,
      conversation: {
        worldTick: () => reads.conversation.worldTick(),
        conversationsOf: (principalId) => reads.conversation.conversationsOf(principalId),
        conversationMessages: (conversationId, limit) =>
          reads.conversation.conversationMessages(conversationId, limit),
        speakerName: (principalId) => reads.conversation.speakerName(principalId),
      },
      console: {
        health: () => {
          const status = lifecycle.healthStatus();
          const summary = healthStorageSummary(runtime.storage, active.branchId);
          // createApp 只在全部模块启动成功后创建；能出现在装配集里即表示已就绪。
          const modules = [
            ...input.assembly.modules,
            ...input.sessionAssembly.client.modules,
            ...input.sessionAssembly.console.modules,
          ].map((module) => ({
            moduleId: module.moduleId,
            version: module.version,
            status: "ready" as const,
          }));
          return {
            status,
            ports: { client: options.clientPort ?? 5173, server: options.transportPort ?? 3000 },
            realms: ["server", "client", "console"] as const,
            assemblyHash: input.assembly.assemblyHash,
            modules,
            clock: clockView(lifecycle.clockState()),
            // turnsRunning、modelQueue 与 laggingAgents 尚无数据来源，省略而不是填 0。
            queues: {
              turnsQueued: summary.turnsQueued,
              maintenanceQueued: input.maintenanceQueued?.() ?? 0,
            },
            budgets: summary.budgets,
            recentFailures: recentFailures(runtime.storage, active.branchId),
          };
        },
        modules: (realm) => runtime.moduleAdmin.modules(realm),
        assemblies: () => runtime.moduleAdmin.assemblies(),
        assembly: (assemblyId) => runtime.moduleAdmin.assembly(assemblyId),
        timeline: (query) =>
          runtime.observability.timeline({
            ...query,
            branchId: query.branchId ?? active.branchId,
          }),
        agents: (branchId) => runtime.observability.agents(branchId),
        ...(modelLayouts === undefined ? {} : {
          modelLayouts: () => modelLayouts.list(),
          modelLayout: (layoutId: string) => modelLayouts.layout(layoutId),
          modelRoutes: (layoutId: string) => modelLayouts.routes(layoutId),
          validateModelLayout: (layout: unknown) => modelLayouts.validate(layout),
        }),
        inspector: research.inspector,
        memory: research.memory,
        memoryDiff: research.memoryDiff,
        observations: research.observations,
        turns: research.turns,
        turn: research.turn,
        artifact: research.artifact,
        trace: research.trace,
        branchCompare: research.branchCompare,
        debugQueues: research.debugQueues,
        replayTurn: research.replayTurn,
        debugWake: research.debugWake,
        ...(evaluation === undefined ? {} : {
          evaluation: {
            runs: (query: { readonly status?: string; readonly limit?: number }) => evaluation.runs(query),
            run: (runId: string) => evaluation.run(runId),
            report: (runId: string) => evaluation.report(runId),
            experiment: (experimentId: string) => evaluation.experiment(experimentId),
            experiments: () => evaluation.experiments(),
          },
        }),
        // 写入与读取分开装配：评估模块未绑定时写接口仍然可用。
        ...(writes === undefined ? {} : { evaluationWrites: writes }),
      },
      projection: () => reads.projection(),
      campaign: () => reads.campaign(),
      clock: () => clockView(lifecycle.clockState()),
      pause: (operationId, expected, principalId) =>
        operations.pause(expected, { operationId, principalId }),
      resume: (operationId, expected, principalId) =>
        operations.resume(expected, { operationId, principalId }),
      step: (operationId, expected, ticks, principalId) =>
        operations.step(expected, ticks, { operationId, principalId }),
      save: {
        createSnapshot: (snapshotInput) =>
          operations.snapshot(snapshotInput.label, snapshotInput.createdBy, {
            operationId: snapshotInput.operationId,
            principalId: snapshotInput.principalId,
          }),
        listSnapshots: () => runtime.save.listSnapshots(),
        restoreSnapshot: (restoreInput) =>
          operations.restore(restoreInput.snapshotId, restoreInput.createdBy, restoreInput.runId, {
            operationId: restoreInput.operationId,
            principalId: restoreInput.principalId,
          }),
        validateRestore: (snapshotId) => operations.validateRestore(snapshotId),
      },
      reset: (operationId, principalId) => operations.reset({ operationId, principalId }),
      onBranchChanged: (nextBranchId) => switchLiveBranch(active, nextBranchId),
      // 传输层只上报玩家连接数；暂停策略与审计留在宿主。
      onPlayerConnectionsChanged: (connected) => {
        lifecycle.handlePlayerConnections(connected);
      },
      identities: serverIdentities(options, active),
      ids: (prefix) => host.ids(prefix),
      tokens: (kind) => `${kind}-${randomUUID()}`,
      healthStatus: () => lifecycle.healthStatus(),
      recordSpan: (span) =>
        runtime.observability.recordSpan({
          ...span,
          parentSpanId: null,
          runId: null,
          branchId: active.branchId,
          agentId: null,
          turnId: null,
          moduleId: "transport.http-ws.fastify",
          moduleVersion: "1.0.0",
        }),
      consoleStaticDir,
      // 入口文件是否存在由宿主判定：传输层不读文件系统，只在确认可回退时才发送 index.html。
      consoleEntryExists: () => existsSync(join(consoleStaticDir, "index.html")),
      onInternalError: (message, error) => {
        logInternalError(host.logger, message, error);
      },
    });
  } catch (error) {
    // 创建传输应用失败：先释放已启动模块，再释放存储；清理失败只记日志。
    try {
      await input.disposeOnFailure();
    } catch (cleanupError) {
      host.logger.error("传输创建失败后的清理未全部完成", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
}
