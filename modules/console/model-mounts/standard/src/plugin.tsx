/**
 * 核心职责：呈现模型布局、连接、挂载与解析路由，并提供静态布局校验。
 * 交互契约：依赖 console API、当前角色与 React；不发起供应商连通性请求。
 * 约束与禁忌：禁止显示凭据正文，禁止在研究员角色下调用操作员校验入口。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析时会把 React/契约类型判成 any。 */
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  ConsoleActiveRole,
  ModelLayoutRoutesResponse,
  ModelLayoutValidateResponse,
  ModelLayoutView,
  ModuleCreateInput,
  ModuleInstance,
  SessionDescriptor,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
  readonly activeRole: ConsoleActiveRole;
}

interface ConsolePagePort extends BrowserViewPort {
  readonly title: string;
}

function draftFromView(layout: ModelLayoutView): unknown {
  return {
    schemaVersion: layout.schemaVersion,
    layoutId: layout.layoutId,
    connections: Object.fromEntries(Object.entries(layout.connections).map(([id, connection]) => [
      id,
      {
        adapterId: connection.adapterId,
        ...(connection.endpointHost === null ? {} : { endpoint: `https://${connection.endpointHost}` }),
        ...(connection.credentialRef === null ? {} : { credentialRef: connection.credentialRef }),
        ...(connection.rateLimitKey === null ? {} : { rateLimitKey: connection.rateLimitKey }),
      },
    ])),
    models: layout.models,
    mounts: layout.mounts,
    ...(layout.evaluator === undefined ? {} : { evaluator: layout.evaluator }),
  };
}

function ModelMountsPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [layoutIds, setLayoutIds] = useState<readonly string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layout, setLayout] = useState<ModelLayoutView | null>(null);
  const [routes, setRoutes] = useState<ModelLayoutRoutesResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<ModelLayoutValidateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void host.api.consoleModelLayouts().then((response) => {
      if (cancelled) return;
      setLayoutIds(response.layouts.map((entry) => entry.layoutId));
      setSelectedId((current) => current ?? response.layouts[0]?.layoutId ?? null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [host.api]);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    void Promise.all([
      host.api.consoleModelLayout(selectedId),
      host.api.consoleModelRoutes(selectedId),
    ]).then(([nextLayout, nextRoutes]) => {
      if (cancelled) return;
      setLayout(nextLayout);
      setRoutes(nextRoutes);
      setDraft(JSON.stringify(draftFromView(nextLayout), null, 2));
      setValidation(null);
      setError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [host.api, selectedId]);

  const validate = async (): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(draft);
      setValidation(await host.api.validateModelLayout(parsed));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="console-page" data-testid="console-page-model-mounts">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">模型装配</span>
          <h1>模型挂载与路由</h1>
          <p>连接只显示适配器、主机名与凭据引用名；路由来自当前冻结布局。</p>
        </div>
        <span className="branch-chip">{layoutIds.length} 个布局</span>
      </header>
      {error === null ? null : <div className="console-error" role="alert">{error}</div>}
      <div className="console-split model-layout-split">
        <section className="console-panel">
          <header><h2>布局</h2><span>仓库配置</span></header>
          <div className="assembly-list">
            {layoutIds.map((layoutId) => (
              <button
                type="button"
                key={layoutId}
                className={layoutId === selectedId ? "is-selected" : ""}
                onClick={() => {
                  setSelectedId(layoutId);
                }}
              >
                <span>{layoutId}</span>
                <small>{layoutId === selectedId ? "当前查看" : "打开详情"}</small>
              </button>
            ))}
          </div>
        </section>
        <section className="console-panel">
          <header><h2>{layout?.layoutId ?? "布局详情"}</h2><span>{routes?.routes.length ?? 0} 条路由</span></header>
          {layout === null ? <p className="console-empty">尚未选择布局。</p> : (
            <div className="model-layout-detail">
              <div className="console-kv">
                <div><dt>连接</dt><dd>{Object.keys(layout.connections).length}</dd></div>
                <div><dt>模型</dt><dd>{Object.keys(layout.models).length}</dd></div>
                <div><dt>挂载</dt><dd>{layout.mounts.length}</dd></div>
              </div>
              <div className="model-connection-grid">
                {Object.entries(layout.connections).map(([id, connection]) => (
                  <article key={id}>
                    <strong>{id}</strong>
                    <small>{connection.adapterId}</small>
                    <span>{connection.endpointHost ?? "环境变量端点"}</span>
                    <code>{connection.credentialRef ?? "无凭据引用"}</code>
                  </article>
                ))}
              </div>
              <div className="route-table">
                {routes?.routes.map((route) => (
                  <div key={`${route.agentId}:${route.purpose}`}>
                    <span>{route.agentId}</span>
                    <strong>{route.purpose}</strong>
                    <small>{route.externalModel}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      {host.activeRole === "operator" ? (
        <section className="console-panel model-validation-panel">
          <header><h2>静态校验</h2><span>不发起网络请求</span></header>
          <textarea
            aria-label="模型布局草稿"
            value={draft}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setDraft((event.target as unknown as { value: string }).value);
            }}
          />
          <div className="console-action-row">
            <button type="button" className="console-primary" onClick={() => void validate()}>校验布局</button>
            {validation === null ? null : (
              <span className={validation.ok ? "console-ok" : "console-error-text"}>
                {validation.ok ? "校验通过" : `${validation.errors.length} 个问题`}
              </span>
            )}
          </div>
          {validation?.errors.map((issue) => (
            <p className="console-error" key={`${issue.code}:${issue.message}`}>{issue.code} · {issue.message}</p>
          ))}
        </section>
      ) : null}
    </section>
  );
}

export function createModelMountsPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: ConsolePagePort = {
    title: "模型挂载",
    renderContribution: (): ReactNode => <ModelMountsPage />,
  };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    port,
  });
}
