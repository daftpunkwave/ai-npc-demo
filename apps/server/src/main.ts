/**
 * 服务端进程入口：加载部署配置并交给启动编排，随后注册关闭信号处理。
 * 依赖部署配置解析、启动编排与关闭处理器；不启动客户端，也不直接读写存储或凭据文件。
 * 禁止监听非回环地址、更换约定端口、吞掉启动失败、重复打印已配置令牌、让关闭失败静默退出，
 * 或让连续到达的关闭信号重复执行关闭并覆盖退出码。
 */
import { loadDeploymentConfig } from "./config";
import { createShutdownHandler } from "./shutdown";
import { startServer } from "./startup";

const running = await startServer({ config: loadDeploymentConfig() });

const shutdown = createShutdownHandler({
  close: () => running.close(),
  logError: (line) => {
    console.error(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
});
// 两个信号共享同一个关闭任务：处理器保证重复调用不会重复关闭或覆盖退出码。
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
