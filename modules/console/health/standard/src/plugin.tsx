/**
 * 读取控制台健康摘要与客户端内容视图，呈现端口、装配、时钟、队列、模块、失败计数、热路径耗时与存储占用。
 * 依赖注入的 console API、当前角色、client-protocol 的轮询调度与 React；页面标题取自内容视图，不伪造 Agent 或预算数据。
 * 禁止在服务失败时保留过期页面并声称运行正常，禁止在上一次读取未结束时叠加请求，也禁止在页面不可见时继续请求。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@world-prism/client-sdk";
import type {
  ClientContentView,
  ConsoleHealthResponse,
  ModuleCreateInput,
  ModuleInstance,
} from "@world-prism/contracts";
import { startPolling, type ApiClient } from "@world-prism/client-protocol";
import { healthSummary } from "./health-summary";
import { storageSummary, type StorageSummaryView } from "./storage-summary";

export interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly activeRole: "operator" | "researcher" | "evaluator";
}

/** 健康摘要成功后到下一次读取的间隔。 */
const healthPollIntervalMs = 2_000;
/** 内容视图读取失败后的首次重试基数。 */
const contentRetryIntervalMs = 3_000;
/** 连续失败时的最长等待；服务恢复后最多这么久就能重新读到。 */
const maxRetryBackoffMs = 30_000;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 存储占用面板：测量由服务端在后台定期执行，面板标出测量时刻，避免把旧值读成实时值。 */
function StoragePanels({ storage }: { readonly storage: StorageSummaryView }): ReactNode {
  if (storage.status === "pending") {
    return (
      <section className="console-panel" data-testid="console-health-storage">
        <header>
          <h2>存储占用</h2>
        </header>
        <p className="console-empty">首轮测量尚未完成。</p>
      </section>
    );
  }
  return (
    <div className="console-two-column" data-testid="console-health-storage">
      <section className="console-panel">
        <header>
          <h2>存储占用</h2>
          <span>测量于 {storage.measuredAt}</span>
        </header>
        <dl className="console-kv">
          <div><dt>主库</dt><dd>{storage.databaseText}</dd></div>
          <div><dt>空闲页</dt><dd>{storage.freeText}</dd></div>
          <div><dt>artifact 正文</dt><dd>{storage.artifactText}</dd></div>
          <div><dt>保留策略</dt><dd>{storage.retentionText}</dd></div>
        </dl>
      </section>
      <section className="console-panel">
        <header>
          <h2>表行数</h2>
          <span>{storage.tables.length} tables</span>
        </header>
        <dl className="console-kv">
          {storage.tables.map((entry) => (
            <div key={entry.table}><dt>{entry.table}</dt><dd>{entry.rowsText}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function HealthPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [content, setContent] = useState<ClientContentView | null>(null);
  const [health, setHealth] = useState<ConsoleHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  // 内容静态：与健康轮询分开读取，失败时退避重试直到读到，且不阻塞健康数据。
  useEffect(() => {
    const loading = startPolling({
      read: async (signal) => {
        const value = await host.api.content(signal);
        setContent(value);
        setContentError(null);
      },
      intervalMs: contentRetryIntervalMs,
      maxBackoffMs: maxRetryBackoffMs,
      stopAfterSuccess: true,
      onError: (cause) => setContentError(errorText(cause)),
    });
    return () => loading.stop();
  }, [host.api]);

  // 上一次读取结束后才排下一次，服务端挂起时不会叠加在途请求；卸载或切换角色时中止在途读取。
  // 页面切到后台时暂停，切回前台立即补读，恢复可见后看到的是当前状态而不是离开时的快照。
  useEffect(() => {
    const polling = startPolling({
      read: async (signal) => {
        const value = await host.api.consoleHealth(signal);
        setHealth(value);
        setError(null);
      },
      intervalMs: healthPollIntervalMs,
      maxBackoffMs: maxRetryBackoffMs,
      onError: (cause) => setError(errorText(cause)),
    });
    return () => polling.stop();
  }, [host.api, host.activeRole]);

  if (error !== null) {
    return <div className="console-error" role="alert">{error}</div>;
  }
  if (health === null) {
    return <div className="console-loading">读取运行状态…</div>;
  }
  const summary = healthSummary(health);
  const storage = storageSummary(health);
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
      {summary.hotPaths === null || summary.hotPaths.length === 0 ? null : (
        <section className="console-panel" data-testid="console-health-hot-paths">
          <header>
            <h2>热路径耗时</h2>
            <span>进程内统计</span>
          </header>
          <div className="console-table">
            {summary.hotPaths.map((row) => (
              <div className="console-table-row" key={row.name}>
                <code>{row.name}</code>
                <span>{row.countText}</span>
                <b>{row.latencyText}</b>
              </div>
            ))}
          </div>
        </section>
      )}
      {storage === null ? null : <StoragePanels storage={storage} />}
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
