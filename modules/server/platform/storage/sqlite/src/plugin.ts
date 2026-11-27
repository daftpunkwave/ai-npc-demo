/**
 * 创建 platform.storage.sqlite 的模块实例：校验配置、构造存储端口，在 start/dispose 中打开与关闭连接，
 * 在 start 后开始后台占用测量、并在配置了保留天数时调度可轮转观测表的清理，在 dispose 时先停止调度再关闭连接。
 * 依赖配置 schema、SqliteStorage 实现、保留期清理调度与公共契约的模块实例类型。
 * 禁止在 create 阶段访问文件系统、启动后台循环，或把数据库连接暴露到端口之外。
 */
import { DomainError, type ModuleCreateInput, type ModuleInstance } from "@world-prism/contracts";
import { storageConfigSchema } from "./definition";
import type { BackgroundPassSchedule } from "./sqlite/background-pass";
import { startRetentionSchedule } from "./sqlite/retention";
import { SqliteStorage } from "./sqlite/storage";

/** 模块工厂：配置已由宿主按 schema 校验，这里再解析一次以获得默认值后的强类型配置。 */
export function createSqliteStorageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = storageConfigSchema.parse(input.config);
  const storage = new SqliteStorage(config, input.host);
  let retention: BackgroundPassSchedule | null = null;
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async (signal) => {
      if (signal.aborted) {
        throw new DomainError("cancelled", "存储适配器启动已取消");
      }
      await storage.open();
      if (signal.aborted) {
        storage.close();
        throw new DomainError("cancelled", "存储适配器启动已取消");
      }
      // 首轮测量与首轮清理都排在启动之后异步分块执行，不阻塞宿主继续启动其他模块。
      storage.startFootprintMeasurement();
      retention ??= startRetentionSchedule({ storage, host: input.host, retentionDays: config.retentionDays });
    },
    drain: async () => {
      // 没有需要排空的在途写入：业务写入都在宿主事务内同步完成，保留期清理的每一批也是独立的同步短事务。
    },
    dispose: () => {
      retention?.stop();
      retention = null;
      // close 同时停止后台占用测量。
      storage.close();
      return Promise.resolve();
    },
    port: storage,
  });
}
