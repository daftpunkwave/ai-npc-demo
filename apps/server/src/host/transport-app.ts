/**
 * 传输应用装配：把权威网关、只读端口、运营服务、生命周期与身份令牌接到传输 provider 的公开端口。
 * 依赖传输模块的 createApp、权限/存档/会话端口与宿主配置；不实现路由、不接触 Fastify 类型。
 * 禁止在传输层内重算授权、把内部错误细节交给客户端，或在创建失败后留下已启动资源。
 */
import { randomUUID } from "node:crypto";
import type { Authority } from "@ai-npc/authority";
import type { AuthContext, HostServices, ResolvedModuleSet, StartOption } from "@ai-npc/contracts";
import type { GameContent } from "@ai-npc/module-sdk";
import { clockView } from "./clock-view";
import type { HostLifecycle } from "./lifecycle";
import type { LiveRunState } from "./live-state";
import type { OperationsFactory, ServerApp, ServerIdentity, ServerRuntime } from "./module-catalog";
import type { HostOptions } from "./options";
import type { HostReadPorts } from "./reads";
import type { SessionAssemblies } from "./core";

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
  readonly sessionAssembly: SessionAssemblies;
  /** 创建失败时释放已启动模块与存储；只记日志，保留原始错误。 */
  readonly disposeOnFailure: () => Promise<void>;
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
  const { host, options, runtime, active, authority, reads, operations, lifecycle, gameContent } = input;
  try {
    return await runtime.transport.createApp({
      authority,
      accessPolicy: runtime.accessPolicy,
      receipts: reads.receipts,
      worldId: active.worldId,
      branchId: active.branchId,
      assembly: input.assembly,
      sessionAssembly: input.sessionAssembly,
      starts: () => startOptions(gameContent),
      conversation: {
        worldTick: () => reads.conversation.worldTick(),
        conversationsOf: (principalId) => reads.conversation.conversationsOf(principalId),
        conversationMessages: (conversationId, limit) =>
          reads.conversation.conversationMessages(conversationId, limit),
        speakerName: (principalId) => reads.conversation.speakerName(principalId),
      },
      projection: () => reads.projection(),
      clock: () => clockView(lifecycle.clockState()),
      pause: (operationId, expected, principalId) =>
        operations.pause(expected, { operationId, principalId }),
      resume: (operationId, expected, principalId) =>
        operations.resume(expected, { operationId, principalId }),
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
      },
      reset: (operationId, principalId) => operations.reset({ operationId, principalId }),
      onBranchChanged: (nextBranchId) => {
        active.branchId = nextBranchId;
      },
      // 传输层只上报玩家连接数；暂停策略与审计留在宿主。
      onPlayerConnectionsChanged: (connected) => {
        lifecycle.handlePlayerConnections(connected);
      },
      identities: serverIdentities(options, active),
      ids: (prefix) => host.ids(prefix),
      tokens: (kind) => `${kind}-${randomUUID()}`,
      healthStatus: () => lifecycle.healthStatus(),
      onInternalError: (message, error) => {
        host.logger.error(message, { message: error instanceof Error ? error.message : String(error) });
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
