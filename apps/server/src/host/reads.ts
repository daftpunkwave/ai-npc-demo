/**
 * 宿主只读端口：投影、命令回执、会话对白与按模块作用域绑定的只读事务。
 * 依赖 authority 的作用域规则、已启动模块的公开端口、存储事务与内容索引；不写入世界状态。
 * 禁止绕过已绑定的模块端口读取领域聚合；回执查询只访问命令网关写入的回执表。
 */
import { createScopedWorldTxFactory, systemPrincipalId, type Authority } from "@ai-npc/authority";
import { DomainError, commandReceiptSchema, type StoragePort, type StorageTransaction } from "@ai-npc/contracts";
import type { GameContent, GameModulePorts } from "@ai-npc/module-sdk";
import type { CommandReceiptReadPort, ConversationReadPort, ServerRuntime } from "./module-catalog";
import { clockView } from "./clock-view";
import type { LiveRunState } from "./live-state";
import { buildPlayerProjection } from "../projection";
import type { HostServices } from "@ai-npc/contracts";

export interface ReadPortsInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly runtime: ServerRuntime;
  readonly authority: Authority;
  readonly gameContent: GameContent;
  readonly active: LiveRunState;
}

/** 宿主对外提供的只读能力；传输层只经这些端口读取事实。 */
export interface HostReadPorts {
  /** 在调用方只读事务内绑定全部游戏端口；读取他人事实只能经各模块的 typed port。 */
  portsIn(storageTx: StorageTransaction): GameModulePorts;
  /** 命令回执只读查询；按会话主体、分支与命令 ID 定位。 */
  readonly receipts: CommandReceiptReadPort;
  /** 当前玩家投影；由游戏端口与时钟在同一只读事务内组装。 */
  projection(): ReturnType<typeof buildPlayerProjection>;
  /** 会话读取端口；分页与送达过滤在传输层完成。 */
  readonly conversation: ConversationReadPort;
}

/** 构造宿主只读端口；每个方法自行开启只读事务绑定已授权的模块端口。 */
export function createReadPorts(input: ReadPortsInput): HostReadPorts {
  const { host, storage, runtime, authority, gameContent, active } = input;
  const binder = runtime.binder;

  /**
   * 只读访问的模块事务工厂：与 authority 共用同一条作用域规则，
   * 按模块注册时声明的 ownsAggregates 授予作用域；未注册模块直接失败。
   */
  const readTxFor = (storageTx: StorageTransaction) =>
    createScopedWorldTxFactory({
      registry: authority.registry,
      storageTx,
      worldId: active.worldId,
      branchId: active.branchId,
      worldTick: runtime.clock.readInTransaction(storageTx, active.branchId).worldTick,
      principalId: systemPrincipalId,
      correlationId: (moduleId) => `host:${moduleId}:read`,
      host,
    });

  const portsIn = (storageTx: StorageTransaction): GameModulePorts =>
    binder(readTxFor(storageTx)) as GameModulePorts;

  const receipts: CommandReceiptReadPort = {
    read: (principalId, branchId, commandId) =>
      storage.transact((tx) => {
        const row = tx.branch(branchId).table("command_receipts").get({
          principal_id: principalId,
          command_id: commandId,
        });
        if (row === null) {
          return null;
        }
        const parsed = commandReceiptSchema.safeParse(row["receipt_json"]);
        if (!parsed.success) {
          throw new DomainError("invalid-state", "存储中的命令回执不符合契约");
        }
        return parsed.data;
      }),
  };

  const projection = () => storage.transact((tx) => {
    const ports = portsIn(tx);
    return buildPlayerProjection({
      content: gameContent,
      world: ports["game.world"],
      map: ports["game.map"],
      clock: clockView(runtime.clock.readInTransaction(tx, active.branchId)),
      comms: ports["game.comms"],
      resources: ports["game.resources"],
      actions: ports["game.actions"],
      agreements: ports["game.agreements"],
    });
  });

  const conversation: ConversationReadPort = {
    worldTick: () => runtime.clock.read(active.branchId).worldTick,
    conversationsOf: (principalId: string) =>
      storage.transact((tx) => portsIn(tx)["game.comms"].conversationsOf(principalId)),
    conversationMessages: (conversationId: string, limit: number) =>
      storage.transact((tx) => {
        const ports = portsIn(tx);
        return ports["game.comms"].conversationMessages(conversationId, limit);
      }),
    speakerName: (principalId: string) => gameContent.characters.get(principalId)?.name ?? principalId,
  };

  return { portsIn, receipts, projection, conversation };
}
