/**
 * 创建 SQLite 存档模块；实例公开端口以 save 字段暴露 SavePort，宿主只经该端口使用存档能力。
 * 依赖解析计划注入的 platform.storage 端口与 ID/时间服务。
 * 禁止在 create 阶段创建快照或复制分支，也不向宿主暴露具体实现类。
 */
import type { ModuleCreateInput, ModuleInstance, StoragePort } from "@world-prism/contracts";
import { createStatelessModule, type SavePort } from "@world-prism/module-sdk";
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

/** 存档模块实例暴露 save 端口；存储端口由装配按 requires 注入。 */
export function createSaveModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.ports["platform.storage"];
  if (!isStoragePort(storage)) {
    throw new Error("game.save.sqlite 缺少 platform.storage 端口");
  }
  const save: SavePort = new SqliteSaveService(storage, input.host);
  return createStatelessModule(input, { save });
}
