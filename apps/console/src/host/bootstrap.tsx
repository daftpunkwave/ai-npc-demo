/**
 * 完成控制台登录、当前角色选择、装配握手与页面模块启动。
 * 依赖类型化 API、浏览器模块运行时与角色会话；不信任 URL 自报角色。
 * 禁止让玩家会话进入控制台，也不在版本不匹配时继续加载页面。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  ModuleHostProvider,
  memoryPreferencePort,
  startBrowserModules,
  type StartedBrowserModules,
} from "@ai-npc/client-sdk";
import { ApiClient, takeHashToken } from "@ai-npc/client-protocol";
import type { ConsoleActiveRole, SessionDescriptor } from "@ai-npc/contracts";
import { consoleModuleDefinitions } from "./module-catalog";
import { ConsoleShell } from "../ui/console-shell";

interface ConsoleReady {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
  readonly runtime: StartedBrowserModules;
  readonly initialRole: ConsoleActiveRole;
}

function chooseRole(session: SessionDescriptor): ConsoleActiveRole {
  if (session.roles.includes("operator")) {
    return "operator";
  }
  if (session.roles.includes("researcher")) {
    return "researcher";
  }
  if (session.roles.includes("evaluator")) {
    return "evaluator";
  }
  throw new Error("当前会话没有控制台角色");
}

export function ConsoleBootstrap(): ReactNode {
  const [ready, setReady] = useState<ConsoleReady | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let runtime: StartedBrowserModules | null = null;
    void (async () => {
      const api = new ApiClient();
      const token = takeHashToken();
      if (token) {
        await api.login(token);
      } else if (!api.token) {
        throw new Error("缺少控制台登录令牌");
      }
      const session = await api.session();
      const role = chooseRole(session);
      api.setActiveRole(role);
      const assembly = await api.assembly("console");
      const roleState = { activeRole: role };
      const hostPort = {
        api,
        session,
        get activeRole(): ConsoleActiveRole {
          return roleState.activeRole;
        },
        setActiveRole(next: ConsoleActiveRole): void {
          roleState.activeRole = next;
          api.setActiveRole(next);
        },
      };
      runtime = await startBrowserModules({
        definitions: consoleModuleDefinitions,
        resolved: assembly,
        fixedPorts: { "host.console": hostPort },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setReady({ api, session, runtime, initialRole: roleState.activeRole });
      }
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => {
      controller.abort();
      if (runtime !== null) {
        void runtime.dispose();
      }
    };
  }, []);

  if (error !== null) {
    return (
      <main className="console-fatal">
        <span>控制台未就绪</span>
        <h1>无法建立研究会话</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (ready === null) {
    return <main className="console-fatal"><p>正在校验控制台装配…</p></main>;
  }
  return (
    <ModuleHostProvider
      value={{
        ports: ready.runtime.ports,
        contributions: ready.runtime.contributions,
        preferences: memoryPreferencePort(),
      }}
    >
      <ConsoleShell
        api={ready.api}
        session={ready.session}
        runtime={ready.runtime}
        initialRole={ready.initialRole}
      />
    </ModuleHostProvider>
  );
}
