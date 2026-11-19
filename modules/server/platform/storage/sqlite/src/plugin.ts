/**
 * 创建 platform.storage.sqlite 的模块实例：校验配置、构造存储端口，并在 start/dispose 中打开与关闭连接。
 * 依赖配置 schema、SqliteStorage 实现与公共契约的模块实例类型。
 * 禁止在 create 阶段访问文件系统、启动后台循环，或把数据库连接暴露到端口之外。
 */
import { DomainError, type ModuleCreateInput, type ModuleInstance } from "@ai-npc/contracts";
import { storageConfigSchema } from "./definition";
import { SqliteStorage } from "./sqlite/storage";

/** 模块工厂：配置已由宿主按 schema 校验，这里再解析一次以获得默认值后的强类型配置。 */
export function createSqliteStorageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = storageConfigSchema.parse(input.config);
  const storage = new SqliteStorage(config, input.host);
  return Promise.resolve({
    moduleId: input.moduleId,
    start: (signal) => {
      if (signal.aborted) {
        // eslint-disable-next-line prefer-promise-reject-errors -- DomainError 继承 Error，静态分析无法解析跨包继承。
        return Promise.reject(new DomainError("cancelled", "存储适配器启动已取消"));
      }
      storage.open();
      return Promise.resolve();
    },
    drain: async () => {
      // 存储适配器没有需要排空的在途任务：所有写入都在宿主事务内同步完成。
    },
    dispose: () => {
      storage.close();
      return Promise.resolve();
    },
    port: storage,
  });
}
