/**
 * 读取授权时间线和 Agent 状态摘要，呈现当前分支的研究视图。
 * 依赖 console API 与 React；不改写事件、记忆或世界状态。
 * 禁止把未归档内容伪装成证据，或在空列表时填入示例事件。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import {
  timelineResponseSchema,
  type AgentStatusView,
  type ModuleCreateInput,
  type ModuleInstance,
  type SessionDescriptor,
  type TimelineItem,
} from "@ai-npc/contracts";
import { StreamClient, type ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
}

function ObservabilityPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [events, setEvents] = useState<readonly TimelineItem[]>([]);
  const [agents, setAgents] = useState<readonly AgentStatusView[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: StreamClient | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectionGeneration = 0;

    const clearReconnect = (): void => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer !== null) {
        return;
      }
      setStreamError("时间线实时连接已断开，正在重连");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectStream();
      }, 1_500);
    };

    async function connectStream(): Promise<void> {
      const generation = connectionGeneration + 1;
      connectionGeneration = generation;
      try {
        const ticket = await host.api.streamTicket();
        if (cancelled || generation !== connectionGeneration) {
          return;
        }
        stream?.close();
        stream = new StreamClient({
          url: host.api.webSocketUrl(ticket.ticket),
          channel: "console.timeline",
          fromStreamSeq: null,
          onMessage: (message) => {
            if (message.type !== "snapshot" || message.channel !== "console.timeline") {
              return;
            }
            try {
              const timeline = timelineResponseSchema.parse(message.data);
              if (!cancelled && generation === connectionGeneration) {
                setEvents(timeline.events);
                setTimelineError(null);
                setStreamError(null);
              }
            } catch (cause) {
              if (!cancelled && generation === connectionGeneration) {
                setTimelineError(cause instanceof Error ? cause.message : String(cause));
              }
            }
          },
          onClose: () => {
            if (!cancelled && generation === connectionGeneration) {
              scheduleReconnect();
            }
          },
          onError: (cause) => {
            if (!cancelled && generation === connectionGeneration) {
              setStreamError(cause instanceof Error ? cause.message : String(cause));
            }
          },
        });
      } catch (cause) {
        if (!cancelled && generation === connectionGeneration) {
          setStreamError(cause instanceof Error ? cause.message : String(cause));
          scheduleReconnect();
        }
      }
    }

    const start = async (): Promise<void> => {
      try {
        const timeline = await host.api.consoleTimeline({
          branchId: host.session.branchId,
          fromSeq: 0,
          limit: 100,
          order: "desc",
        });
        if (!cancelled) {
          setEvents(timeline.events);
          setTimelineError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setTimelineError(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (!cancelled) {
        await connectStream();
      }
    };

    void start();
    return () => {
      cancelled = true;
      connectionGeneration += 1;
      clearReconnect();
      stream?.close();
    };
  }, [host.api, host.session.branchId]);

  useEffect(() => {
    let cancelled = false;
    void host.api
      .consoleAgents(host.session.branchId)
      .then((agentResponse) => {
        if (cancelled) {
          return;
        }
        setAgents(agentResponse.agents);
        setAgentError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setAgentError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [host.api, host.session.branchId]);
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
          <header>
            <h2>世界时间线</h2>
            <span>{events.length} 条{streamError === null ? "" : " · 重连中"}</span>
          </header>
          {timelineError === null ? null : (
            <div className="console-error" role="alert">时间线读取失败：{timelineError}</div>
          )}
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
          {agentError === null ? null : (
            <div className="console-error" role="alert">Agent 状态读取失败：{agentError}</div>
          )}
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
