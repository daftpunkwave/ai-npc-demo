/**
 * 读取授权时间线和 Agent 状态摘要，呈现当前分支的研究视图。
 * 依赖 console API 与 React；不改写事件、记忆或世界状态。
 * 禁止把未归档内容伪装成证据，或在空列表时填入示例事件。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  AgentStatusView,
  ModuleCreateInput,
  ModuleInstance,
  SessionDescriptor,
  TimelineItem,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
}

function ObservabilityPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [events, setEvents] = useState<readonly TimelineItem[]>([]);
  const [agents, setAgents] = useState<readonly AgentStatusView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      host.api.consoleTimeline({
        branchId: host.session.branchId,
        fromSeq: 0,
        limit: 100,
      }),
      host.api.consoleAgents(host.session.branchId),
    ])
      .then(([timeline, agentResponse]) => {
        if (!cancelled) {
          setEvents([...timeline.events].reverse());
          setAgents(agentResponse.agents);
          setError(null);
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
  }, [host.api, host.session.branchId]);

  if (error !== null) {
    return <div className="console-error" role="alert">{error}</div>;
  }
  return (
    <section className="console-page" data-testid="console-page-observability">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">研究视图</span>
          <h1>事件与身份</h1>
          <p>真值视角仅向后端研究员开放；页面不会向玩家或席位下发。</p>
        </div>
        <span className="branch-chip">{host.session.branchId}</span>
      </header>
      <div className="console-split observability-split">
        <section className="console-panel">
          <header><h2>世界时间线</h2><span>{events.length} 条</span></header>
          <div className="timeline-list">
            {events.length === 0 ? (
              <p className="console-empty">当前分支尚无领域事件。</p>
            ) : (
              events.map((event, index) => (
                <article className="timeline-row" key={`${event.worldSeq ?? "life"}-${event.type}-${index}`}>
                  <div>
                    <span>{event.worldSeq === null ? "lifecycle" : `#${event.worldSeq}`}</span>
                    <time>{event.worldTick === null ? "—" : `t${event.worldTick}`}</time>
                  </div>
                  <strong>{event.type}</strong>
                  <p>{event.summaryZh}</p>
                  <small>{event.principalId ?? "system"} · {event.createdAt}</small>
                </article>
              ))
            )}
          </div>
        </section>
        <section className="console-panel">
          <header><h2>Agent 状态</h2><span>{agents.length} 个激活</span></header>
          <div className="agent-list">
            {agents.length === 0 ? (
              <p className="console-empty">Agent 运行时尚未接入，当前没有激活身份。</p>
            ) : (
              agents.map((agent) => (
                <article className="agent-row" key={agent.agentId}>
                  <div>
                    <strong>{agent.agentId}</strong>
                    <small>{agent.kind} · {agent.controllerKind}</small>
                  </div>
                  <span>{agent.turnStatus}</span>
                  <em>{agent.watermarkLag}</em>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

export function createObservabilityPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port = {
    title: "可观测",
    renderContribution: (): ReactNode => <ObservabilityPage />,
  } satisfies BrowserViewPort & { readonly title: string };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
