/**
 * 启动开发环境：服务端 :3000、玩家 Vite :5173 与控制台静态构建观察进程。
 * 依赖统一子进程管理；控制台不监听独立端口。
 * 禁止自动换端口、重启失败进程或在任一服务退出后继续运行。
 */
import {
  clientDevProcess,
  consoleWatchProcess,
  loadProjectEnvironment,
  serverProcess,
  supervise,
} from "./processes";

loadProjectEnvironment();
process.exitCode = await supervise([
  serverProcess(),
  clientDevProcess(),
  consoleWatchProcess(),
]);
