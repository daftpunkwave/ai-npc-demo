/**
 * 服务端进程入口：加载部署配置并交给启动编排，随后注册关闭信号与进程级异常处理。
 * 依赖部署配置解析、启动编排、关闭处理器与进程故障策略；不启动客户端，也不直接读写存储或凭据文件。
 * 禁止监听非回环地址、更换约定端口、吞掉启动失败、重复打印已配置令牌、让关闭失败静默退出，
 * 让连续到达的关闭信号重复执行关闭并覆盖退出码，或用空处理器掩盖未捕获异常并继续声称可用。
 */
import { loadDeploymentConfig } from "./config";
import { createProcessFaultHandlers, installProcessFaultHandlers } from "./process-faults";
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

// 未捕获异常不能交给 Node 默认行为：那会跳过 drain 直接消失，世界时钟、在途 turn 与 WS 会话
// 一起丢失且没有结构化记录。这里统一为「记录 → 标记不可信并降级退出 → 走同一条优雅关闭」。
installProcessFaultHandlers(process, createProcessFaultHandlers({
  logFault: (report) => {
    // 只写类型、错误消息与栈，不写可能含观察正文或凭据的整份上下文对象。
    console.error(`[ai-npc] 未捕获异常（${report.kind}）：${report.message}`);
    if (report.stack !== null) console.error(report.stack);
  },
  shutdown,
  setExitCode: (code) => {
    process.exitCode = code;
  },
}));
