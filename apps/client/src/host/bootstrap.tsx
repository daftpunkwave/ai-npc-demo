/**
 * 完成登录、会话与装配握手，启动客户端模块运行时并向 React 宿主提供受控端口。
 * 依赖类型化 API/命令客户端、浏览器模块目录与模块生命周期；不渲染服务端私有数据。
 * 禁止在版本不匹配时继续加载，或在页面卸载后遗留 WebSocket 与模块订阅。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  ModuleHostProvider,
  startBrowserModules,
  type StartedBrowserModules,
} from "@ai-npc/client-sdk";
import {
  ApiClient,
  CommandClient,
  takeHashToken,
} from "@ai-npc/client-protocol";
import type { SessionDescriptor } from "@ai-npc/contracts";
import { clientModuleDefinitions } from "./module-catalog";
import { localPreferencePort } from "./preferences";
import { GameShell } from "../ui/game-shell";

interface ReadyState {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
  readonly runtime: StartedBrowserModules;
}

function ErrorScreen({ message }: { readonly message: string }): ReactNode {
  return (
    <main className="fatal-screen">
      <span className="eyebrow">玩家端未就绪</span>
      <h1>无法建立灰港会话</h1>
      <p>{message}</p>
      <small>检查服务端 :3000 与客户端 :5173 是否启动，再刷新本页。</small>
    </main>
  );
}

export function ClientBootstrap(): ReactNode {
  const [ready, setReady] = useState<ReadyState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let started: StartedBrowserModules | null = null;
    void (async () => {
      const api = new ApiClient();
      const token = takeHashToken();
      if (token !== null) {
        await api.login(token);
      } else if (api.token === null) {
        throw new Error("缺少登录令牌。请使用服务端启动时打印的玩家登录地址。");
      }
      const session = await api.session();
      const assembly = await api.assembly("client");
      const command = new CommandClient({ api });
      const runtime = await startBrowserModules({
        definitions: clientModuleDefinitions,
        resolved: assembly,
        fixedPorts: {
          "host.api": api,
          "host.command": command,
          "host.session": session,
        },
        signal: controller.signal,
      });
      started = runtime;
      const worldView = runtime.ports["client.world-view"] as {
        bootstrap(): Promise<void>;
      };
      await worldView.bootstrap();
      if (!controller.signal.aborted) {
        setReady({ api, session, runtime });
      }
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => {
      controller.abort();
      if (started !== null) {
        void started.dispose();
      }
    };
  }, []);

  if (error !== null) {
    return <ErrorScreen message={error} />;
  }
  if (ready === null) {
    return (
      <main className="loading-screen">
        <span className="loading-mark" />
        <p>正在校验模块版本并读取授权投影…</p>
      </main>
    );
  }
  return (
    <ModuleHostProvider
      value={{
        ports: ready.runtime.ports,
        contributions: ready.runtime.contributions,
        preferences: localPreferencePort(),
        reportContributionError: (cause, contribution) => {
          console.error(`模块贡献 ${contribution.extensionId} 渲染失败`, cause);
        },
      }}
    >
      <GameShell session={ready.session} />
    </ModuleHostProvider>
  );
}
