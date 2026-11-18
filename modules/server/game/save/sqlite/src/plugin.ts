/**
 * 创建 SQLite 存档模块；端口提供快照创建、列出与恢复。
 * 依赖宿主注入的 StoragePort 与 ID/时间服务。
 * 禁止在 create 阶段创建快照或复制分支。
 */
import type { ModuleCreateInput, ModuleInstance, StoragePort } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
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

/** 存档模块实例暴露 save 服务。 */
export function createSaveModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.host.storage;
  if (!isStoragePort(storage)) {
    throw new Error("game.save.sqlite 需要宿主注入 StoragePort");
  }
  const save = new SqliteSaveService(storage, input.host);
  return createStatelessModule(input, { save });
}
