/**
 * 服务端进程入口：加载部署配置与登录令牌、启动宿主、监听回环服务端口并打印登录地址。
 * 依赖部署配置解析与宿主启动；不启动客户端，也不直接读写存储。
 * 禁止监听非回环地址、更换约定端口、吞掉监听失败或重复打印已配置令牌。
 */
import { loadDeploymentConfig, resolveCredentials, startupLogLines } from "./config";
import { startHost } from "./host";

const config = loadDeploymentConfig();
const credentials = resolveCredentials(config);
const running = await startHost({
  dataDir: config.dataDir,
  assemblyRef: config.assemblyRef,
  playerToken: credentials.tokens.player,
  consoleToken: credentials.tokens.console,
  ...(credentials.tokens.operator === undefined ? {} : { operatorToken: credentials.tokens.operator }),
  ...(credentials.tokens.researcher === undefined ? {} : { researcherToken: credentials.tokens.researcher }),
  ...(credentials.tokens.evaluator === undefined ? {} : { evaluatorToken: credentials.tokens.evaluator }),
  transportHost: config.serverHost,
  transportPort: config.serverPort,
});
try {
  await running.listen();
} catch (error) {
  await running.close();
  throw new Error(`监听 ${running.transport.host}:${running.transport.port} 失败: ${error instanceof Error ? error.message : String(error)}`);
}

for (const line of startupLogLines({ config, tokens: credentials.tokens, generated: credentials.generated })) {
  console.info(line);
}

const shutdown = async (): Promise<void> => {
  await running.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
