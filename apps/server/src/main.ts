/**
 * 服务端进程入口：加载部署配置并交给启动编排，随后注册关闭信号处理。
 * 依赖部署配置解析、启动编排与关闭函数；不启动客户端，也不直接读写存储或凭据文件。
 * 禁止监听非回环地址、更换约定端口、吞掉启动失败、重复打印已配置令牌，或让关闭失败静默退出。
 */
import { loadDeploymentConfig } from "./config";
import { shutdownServer } from "./shutdown";
import { startServer } from "./startup";

const running = await startServer({ config: loadDeploymentConfig() });

const shutdown = (): void => {
  void shutdownServer({
    close: () => running.close(),
    logError: (line) => {
      console.error(line);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
