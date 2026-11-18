/**
 * 创建 SQLite 存档模块；端口提供快照创建、列出与恢复。
 * 依赖宿主注入的 StoragePort 与 ID/时间服务。
 * 禁止在 create 阶段创建快照或复制分支。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将宿主存储类型误判为 any。 */
import type { ModuleCreateInput, ModuleInstance, StoragePort } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { SqliteSaveService } from "./service";

/** 存档模块实例暴露 save 服务。 */
export function createSaveModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.host.storage as StoragePort | undefined;
  if (storage === undefined) {
    throw new Error("game.save.sqlite 需要宿主注入 StoragePort");
  }
  const save = new SqliteSaveService(storage, (prefix) => input.host.ids(prefix), () => input.host.nowIso());
  return createStatelessModule(input, { save });
}
