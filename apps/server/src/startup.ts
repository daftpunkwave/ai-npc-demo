/**
 * 核心职责：编排服务端启动顺序：解析令牌、暂存凭据文件、启动宿主、监听、输出登录地址，最后原子发布凭据文件。
 * 交互契约：依赖部署配置与凭据模块、宿主启动函数和日志回调；返回已监听的宿主能力供入口注册关闭处理。
 * 约束与禁忌：凭据写入失败必须在开始监听前终止；监听失败必须丢弃暂存文件且不发布；不在此实现端口、路由或存储逻辑。
 */
import type { DeploymentConfig, StagedCredentialsFile } from "./config";
import { resolveCredentials, stageResolvedCredentials, startupLogLines } from "./config";
import { startHost } from "./host";
import type { HostOptions } from "./host/options";

/** 启动编排所需的宿主能力；生产 RunningHost 结构上满足，测试可注入等价替身。 */
export interface StartupHost {
  readonly transport: { readonly host: string; readonly port: number };
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** 启动编排输入；日志回调可注入，便于测试断言输出顺序且不让模块内部直接写控制台。 */
export interface StartServerOptions {
  readonly config: DeploymentConfig;
  readonly startHost?: (options: HostOptions) => Promise<StartupHost>;
  readonly logLine?: (line: string) => void;
  readonly logError?: (line: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 丢弃暂存凭据并报告清理失败；用于所有监听尚未成功的退出路径。 */
function discardStaged(staged: StagedCredentialsFile | null, logError: (line: string) => void): void {
  const cleanupError = staged?.discard() ?? null;
  if (cleanupError !== null) {
    logError(`[ai-npc] 丢弃凭据暂存文件失败：${cleanupError}`);
  }
}

/** 启动并监听服务端；关闭由返回的宿主调用方负责。 */
export async function startServer(options: StartServerOptions): Promise<StartupHost> {
  const { config } = options;
  const launchHost = options.startHost ?? startHost;
  const logLine = options.logLine ?? ((line: string): void => {
    console.info(line);
  });
  const logError = options.logError ?? ((line: string): void => {
    console.error(line);
  });

  // 先暂存令牌但不发布：写入或刷新磁盘失败时直接终止，不进入监听，旧凭据文件保持原样。
  const credentials = resolveCredentials(config, { persist: false });
  const staged = stageResolvedCredentials(config, credentials);

  let running: StartupHost;
  try {
    running = await launchHost({
      dataDir: config.dataDir,
      consoleStaticDir: config.consoleStaticDir,
      assemblyRef: config.assemblyRef,
      rosterRef: config.rosterRef,
      modelLayoutRef: config.modelLayoutRef,
      playerToken: credentials.tokens.player,
      consoleToken: credentials.tokens.console,
      ...(credentials.tokens.operator === undefined ? {} : { operatorToken: credentials.tokens.operator }),
      ...(credentials.tokens.researcher === undefined ? {} : { researcherToken: credentials.tokens.researcher }),
      ...(credentials.tokens.evaluator === undefined ? {} : { evaluatorToken: credentials.tokens.evaluator }),
      transportHost: config.serverHost,
      transportPort: config.serverPort,
      clientPort: config.clientPort,
      migrateOnlineRun: config.migrateOnlineRun,
    });
  } catch (error) {
    discardStaged(staged, logError);
    throw error;
  }

  try {
    await running.listen();
  } catch (error) {
    discardStaged(staged, logError);
    try {
      await running.close();
    } catch (closeError) {
      // 关闭失败不掩盖监听失败；两条错误都进入日志，调用方仍拿到原始监听失败原因。
      logError(`[ai-npc] 监听失败后关闭宿主失败：${errorMessage(closeError)}`);
    }
    throw new Error(`监听 ${running.transport.host}:${running.transport.port} 失败: ${errorMessage(error)}`);
  }

  // 先输出登录地址再发布：避免正式令牌已落盘却从未展示，导致下次启动无地址可用。
  for (const line of startupLogLines({ config, tokens: credentials.tokens, generated: credentials.generated })) {
    logLine(line);
  }
  if (staged !== null) {
    try {
      staged.publish();
    } catch (error) {
      // 凭据无法持久化时不能把“监听已就绪”当成成功：关闭宿主并让启动失败，旧凭据文件保持不变。
      try {
        await running.close();
      } catch (closeError) {
        logError(`[ai-npc] 凭据发布失败后关闭宿主失败：${errorMessage(closeError)}`);
      }
      throw new Error(`凭据文件原子发布失败，启动已终止：${errorMessage(error)}`, { cause: error });
    }
  }
  return running;
}
