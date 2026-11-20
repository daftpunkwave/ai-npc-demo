/**
 * 展示后端模块目录、装配列表和选中装配的三 realm 解析结果。
 * 依赖 console API 与 React；不提交草稿或宣称模块已热替换。
 * 禁止向浏览器暴露模块工厂、凭据或服务端内存对象。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  AssemblyDetailResponse,
  AssemblySource,
  ModuleCreateInput,
  ModuleDescriptorView,
  ModuleInstance,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
}

function ModuleAdminPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [modules, setModules] = useState<readonly ModuleDescriptorView[]>([]);
  const [assemblies, setAssemblies] = useState<readonly { assemblyId: string; source: AssemblySource }[]>([]);
  const [selected, setSelected] = useState<AssemblyDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([host.api.consoleModules(), host.api.consoleAssemblies()])
      .then(async ([moduleResponse, assemblyResponse]) => {
        if (cancelled) {
          return;
        }
        setModules(moduleResponse.modules);
        setAssemblies(assemblyResponse.assemblies);
        const first = assemblyResponse.assemblies[0];
        if (first !== undefined) {
          const detail = await host.api.consoleAssembly(first.assemblyId);
          if (!cancelled) {
            setSelected(detail);
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [host.api]);

  if (error !== null) {
    return <div className="console-error" role="alert">{error}</div>;
  }
  return (
    <section className="console-page" data-testid="console-page-module-admin">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">模块与装配</span>
          <h1>当前可信目录</h1>
          <p>目录只展示描述符与已解析配置摘要；变更仍需新 run 与预检。</p>
        </div>
        <span className="module-count">{modules.length} modules</span>
      </header>
      <div className="console-split">
        <section className="console-panel">
          <header><h2>仓库装配</h2><span>{assemblies.length}</span></header>
          <div className="assembly-list">
            {assemblies.map((assembly) => (
              <button
                type="button"
                key={assembly.assemblyId}
                className={selected?.descriptor.assemblyId === assembly.assemblyId ? "is-selected" : ""}
                onClick={() => {
                  void host.api.consoleAssembly(assembly.assemblyId).then(setSelected).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <span>{assembly.assemblyId}</span>
                <small>{assembly.source}</small>
              </button>
            ))}
          </div>
          {selected === null ? null : (
            <dl className="console-kv">
              {(["server", "client", "console"] as const).map((realm) => (
                <div key={realm}>
                  <dt>{realm}</dt>
                  <dd>{selected.resolved[realm].modules.length} 模块</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
        <section className="console-panel">
          <header><h2>模块目录</h2><span>server / client / console</span></header>
          <div className="module-list">
            {modules.map((module) => (
              <article key={module.moduleId} className="module-row">
                <div>
                  <code>{module.moduleId}</code>
                  <span>{module.realm} · {module.kind} · v{module.version}</span>
                </div>
                <div>
                  <small>提供</small>
                  <p>{module.provides.map((item) => item.capability).join(" · ")}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

export function createModuleAdminPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port = {
    title: "模块装配",
    renderContribution: (): ReactNode => <ModuleAdminPage />,
  } satisfies BrowserViewPort & { readonly title: string };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
