/**
 * 核心职责：经存档模块自己的 create 构造 SQLite 存档端口，供需要真实存档行为的集成测试使用。
 * 交互契约：依赖存档模块定义、游戏 harness 的真实 SQLite 存储、时钟端口与宿主服务，以及 authority 的分支事件前沿查询；
 *   与宿主组合根一样按 requires 注入存储端口、在绑定时注入世界 tick 与事件前沿查询，只返回模块实例公开的 SavePort。
 * 约束与禁忌：不直接实例化存档实现类，也不绕过模块公开端口读写快照。
 */
import type { StoragePort } from "@world-prism/contracts";
import { branchEventFrontier } from "@world-prism/authority";
import { saveModuleDefinition } from "@world-prism/mod-game-save-sqlite";
import type { SaveModulePort, SavePort } from "@world-prism/module-sdk";
import type { GameHarness } from "./game-support";

/**
 * 与宿主一样只取存档模块实例的公开端口。
 * storage 缺省为 harness 的存储；传入完整转发的包装存储可在指定写入点注入故障。
 */
export async function createSqliteSavePort(
  harness: GameHarness,
  storage: StoragePort = harness.storage,
): Promise<SavePort> {
  const instance = await saveModuleDefinition.create({
    moduleId: saveModuleDefinition.id,
    realm: "server",
    config: {},
    scope: { worldId: harness.worldId, branchId: harness.branchId },
    ports: { "platform.storage": storage },
    host: harness.host,
    signal: new AbortController().signal,
  });
  const port = instance.port as Partial<SaveModulePort> | undefined;
  if (typeof port?.bind !== "function") {
    throw new Error("存档模块实例没有通过公开端口暴露存档绑定");
  }
  return port.bind({
    eventFrontier: branchEventFrontier,
    worldTick: (tx, branchId) => harness.clock.readInTransaction(tx, branchId).worldTick,
  });
}
