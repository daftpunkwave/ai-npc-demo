/**
 * 读取控制台健康摘要与客户端内容视图，呈现端口、装配、时钟、队列、模块与失败计数。
 * 依赖注入的 console API、当前角色与 React；页面标题取自内容视图，不伪造 Agent 或预算数据。
 * 禁止在服务失败时保留过期页面并声称运行正常。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  ClientContentView,
  ConsoleHealthResponse,
  ModuleCreateInput,
  ModuleInstance,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";
import { healthSummary } from "./health-summary";

export interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly activeRole: "operator" | "researcher" | "evaluator";
}

function HealthPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [content, setContent] = useState<ClientContentView | null>(null);
  const [health, setHealth] = useState<ConsoleHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  // 内容静态：与健康轮询分开读取；失败时按固定间隔重试，且不阻塞健康数据。
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    const load = (): void => {
      void host.api
        .content()
        .then((value) => {
          if (cancelled) {
            return;
          }
          setContent(value);
          setContentError(null);
          if (retryTimer !== null) {
            clearInterval(retryTimer);
            retryTimer = null;
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setContentError(cause instanceof Error ? cause.message : String(cause));
          }
        });
    };
    load();
    retryTimer = setInterval(load, 3_000);
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        clearInterval(retryTimer);
      }
    };
  }, [host.api]);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void host.api
        .consoleHealth()
        .then((value) => {
          if (!cancelled) {
            setHealth(value);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        });
    };
    load();
    const timer = setInterval(load, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [host.api, host.activeRole]);

  if (error !== null) {
    return <div className="console-error" role="alert">{error}</div>;
  }
  if (health === null) {
    return <div className="console-loading">读取运行状态…</div>;
  }
  const summary = healthSummary(health);
  return (
    <section className="console-page" data-testid="console-page-health">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">运行总览</span>
          <h1>{content?.ui.consoleTitle ?? ""}</h1>
          <p>只显示已装配模块、授权队列与当前在线分支。</p>
          {contentError === null ? null : <p className="console-error" role="status">{contentError}</p>}
        </div>
        <span className={summary.statusClass} data-testid="console-health-status">
          {summary.statusLabel}
        </span>
      </header>
      <div className="console-stat-grid">
        <article>
          <span>客户端端口</span>
          <strong>{health.ports.client}</strong>
          <small>only loopback</small>
        </article>
        <article>
          <span>服务端口</span>
          <strong>{health.ports.server}</strong>
          <small>API + /console</small>
        </article>
        <article>
          <span>世界时钟</span>
          <strong>t{health.clock.worldTick}</strong>
          <small>第 {health.clock.day} 天 · {health.clock.mode}</small>
        </article>
        <article>
          <span>待处理</span>
          <strong>{summary.queuedText}</strong>
          <small>{summary.queueDetail}</small>
        </article>
      </div>
      <div className="console-two-column">
        <section className="console-panel">
          <header>
            <h2>运行模块</h2>
            <span>{health.modules.length}</span>
          </header>
          <div className="console-table">
            {health.modules.map((module) => (
              <div className="console-table-row" key={module.moduleId}>
                <code>{module.moduleId}</code>
                <span>{module.version}</span>
                <b>{module.status}</b>
              </div>
            ))}
          </div>
        </section>
        <section className="console-panel">
          <header>
            <h2>运行边界</h2>
            <span>{health.realms.length} realms</span>
          </header>
          <dl className="console-kv">
            <div><dt>装配摘要</dt><dd>{health.assemblyHash.slice(0, 18)}…</dd></div>
            <div><dt>水位落后</dt><dd>{summary.laggingText}</dd></div>
            <div><dt>预算条目</dt><dd>{health.budgets.length}</dd></div>
            <div><dt>最近失败</dt><dd>{health.recentFailures.length}</dd></div>
          </dl>
        </section>
      </div>
    </section>
  );
}

export function createHealthPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port = {
    title: "运行总览",
    renderContribution: (): ReactNode => <HealthPage />,
  } satisfies BrowserViewPort & { readonly title: string };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
