/**
 * 完成控制台登录、当前角色选择、装配握手与页面模块启动，并向页面提供在线分支身份。
 * 依赖类型化 API、浏览器模块运行时、角色会话与在线分支跟踪器；不信任 URL 自报角色或页面自报分支。
 * 禁止让玩家会话进入控制台，也不在版本不匹配时继续加载页面。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  ModuleHostProvider,
  memoryPreferencePort,
  startBrowserModules,
  type StartedBrowserModules,
} from "@world-prism/client-sdk";
import { ApiClient, takeHashToken } from "@world-prism/client-protocol";
import { DomainError, type ClockView, type ConsoleActiveRole, type SessionDescriptor } from "@world-prism/contracts";
import { consoleModuleDefinitions } from "./module-catalog";
import { createOnlineBranchTracker } from "./online-branch";
import { ConsoleShell } from "../ui/console-shell";

interface ConsoleReady {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
  readonly runtime: StartedBrowserModules;
  readonly initialRole: ConsoleActiveRole;
}

function operationId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `op-${Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("")}`;
}

async function waitForClockSettled(api: ApiClient, ticks: number, signal: AbortSignal): Promise<ClockView> {
  // 单步按 20 秒/tick 推进；每 tick 预留 45 秒，避免页面在 24 tick 的单步中途误报超时。
  const attempts = Math.max(60, ticks * 90);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const clock = (await api.consoleHealth(signal)).clock;
    if (clock.mode !== "stepping") return clock;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, 500);
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
    signal.throwIfAborted();
  }
  throw new Error("单步推进超时，请重新读取时钟状态");
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
      // 在线分支以服务端为准：恢复/重开会切换分支，页面查询与界面标识必须跟随新分支。
      // 会话描述符里的 branchId 是登录时的快照，宿主独立于页面定期核对，
      // 因此无论打开的是哪个页面，其他会话切换分支后本会话都会更新。
      const onlineBranch = createOnlineBranchTracker({
        initial: { worldId: session.worldId, branchId: session.branchId },
        readSession: (signal) => api.session(signal),
      });
      const hostPort = {
        api,
        session,
        operationId,
        reload: () => window.location.reload(),
        confirm: (message: string) => window.confirm(message),
        waitForClockSettled: (ticks: number, signal: AbortSignal) => waitForClockSettled(api, ticks, signal),
        evaluation: {
          list: () => api.consoleExperiments().then((response) => response.experiments),
          experiment: (experimentId: string) => api.consoleExperiment(experimentId),
          // 只有「run 不存在」（404）才转成 null；其它失败保留给页面显示，不静默吞掉。
          report: async (runId: string) => {
            try {
              return await api.consoleRunReport(runId);
            } catch (cause: unknown) {
              // 只有 not-found 才表示「该 run 不存在」；其余错误保留给页面显示。
              if (cause instanceof DomainError && cause.code === "not-found") return null;
              throw cause;
            }
          },
        },
        get worldId(): string {
          return onlineBranch.identity.worldId;
        },
        get branchId(): string {
          return onlineBranch.identity.branchId;
        },
        /** 订阅在线分支变化；世界或分支任一变化都会通知。 */
        subscribeBranch(listener: () => void): () => void {
          return onlineBranch.subscribe(listener);
        },
        /** 页面发现流帧身份与当前分支不一致时调用：只触发一次向服务端的核对，不采用帧内身份。 */
        refreshBranchIdentity(): void {
          onlineBranch.refresh();
        },
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
        // 页面就绪后才开始核对：启动失败时不留后台请求，卸载时随 controller 一起停止。
        onlineBranch.start(controller.signal);
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
