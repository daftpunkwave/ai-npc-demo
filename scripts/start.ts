/**
 * 启动已构建的本地 Demo：服务端 :3000 与玩家 Vite preview :5173。
 * 依赖统一子进程管理；控制台由服务端现有静态目录提供。
 * 禁止在未构建时伪造控制台页面、自动换端口或留下孤儿进程。
 */
import {
  clientPreviewProcess,
  loadProjectEnvironment,
  serverProcess,
  supervise,
} from "./processes";

loadProjectEnvironment();
process.exitCode = await supervise([serverProcess(), clientPreviewProcess()]);
