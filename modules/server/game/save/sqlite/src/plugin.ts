/**
 * 创建 SQLite 存档模块；实例公开端口是 SaveModulePort，宿主注入检查点查询后取得 SavePort。
 * 依赖解析计划注入的 platform.storage 端口与 ID/时间服务；分支 tick 与事件前沿查询由宿主在绑定时注入。
 * 禁止在 create 阶段创建快照或复制分支，也不向宿主暴露具体实现类。
 */
import type { ModuleCreateInput, ModuleInstance, StoragePort } from "@world-prism/contracts";
import { createStatelessModule, type SaveModulePort } from "@world-prism/module-sdk";
import { SqliteSaveService } from "./service";

function isStoragePort(value: unknown): value is StoragePort {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly transact?: unknown }).transact === "function" &&
    typeof (value as { readonly forkBranch?: unknown }).forkBranch === "function" &&
    typeof (value as { readonly backup?: unknown }).backup === "function"
  );
}

/** 存档模块实例暴露绑定端口；存储端口由装配按 requires 注入，检查点查询由宿主在绑定时注入。 */
export function createSaveModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.ports["platform.storage"];
  if (!isStoragePort(storage)) {
    throw new Error("game.save.sqlite 缺少 platform.storage 端口");
  }
  const port: SaveModulePort = {
    bind: (queries) => new SqliteSaveService(storage, queries, input.host),
  };
  return createStatelessModule(input, port);
}
