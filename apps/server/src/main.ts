/**
 * 服务端进程入口：读取环境变量、启动宿主、监听 127.0.0.1:3000 并打印登录地址。
 * 依赖 startHost 与 Node 进程信号；不启动客户端。
 * 禁止监听非回环地址、静默更换端口或吞掉启动失败。
 */
import { randomUUID } from "node:crypto";
import { startHost } from "./host";

const port = Number(process.env.PORT ?? "3000");
const hostname = process.env.HOST ?? "127.0.0.1";
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  console.error("端口不合法");
  process.exit(1);
}

const playerToken = process.env.PLAYER_TOKEN ?? `player-${randomUUID().slice(0, 18)}`;
const consoleToken = process.env.CONSOLE_TOKEN ?? `console-${randomUUID().slice(0, 18)}`;
const running = await startHost({
  dataDir: process.env.DATA_DIR ?? ".data",
  contentRoot: process.env.CONTENT_ROOT ?? "content",
  packId: process.env.CONTENT_PACK ?? "earth-2964-v1",
  playerToken,
  consoleToken,
});

try {
  await running.app.listen({ port, host: hostname });
} catch (error) {
  console.error(`监听 ${hostname}:${port} 失败`, error instanceof Error ? error.message : String(error));
  await running.close();
  process.exit(1);
}

console.info(`server ready: http://${hostname}:${port}`);
console.info(`player login: http://${hostname}:${port}/#token=${playerToken}`);
console.info(`console login: http://${hostname}:${port}/#token=${consoleToken}`);

const shutdown = async (): Promise<void> => {
  await running.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
