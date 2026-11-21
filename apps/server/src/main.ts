/**
 * 服务端进程入口：加载部署配置并交给启动编排，随后注册关闭信号处理。
 * 依赖部署配置解析与启动编排；不启动客户端，也不直接读写存储或凭据文件。
 * 禁止监听非回环地址、更换约定端口、吞掉启动失败或重复打印已配置令牌。
 */
import { loadDeploymentConfig } from "./config";
import { startServer } from "./startup";

const running = await startServer({ config: loadDeploymentConfig() });

const shutdown = async (): Promise<void> => {
  await running.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
