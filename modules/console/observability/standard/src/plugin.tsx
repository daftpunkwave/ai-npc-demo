/**
 * 核心职责：呈现世界时间线、Agent 检查器、turn 证据与 trace 树。
 * 交互契约：依赖 console API、当前会话与 React；所有数据经服务端授权查询。
 * 约束与禁忌：不直接访问数据库，不把空数据或未归档 artifact 伪装成证据。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import {
  timelineResponseSchema,
  type AgentInspectorResponse,
  type AgentStatusView,
  type ModuleCreateInput,
  type ModuleInstance,
  type SessionDescriptor,
  type TimelineItem,
  type TraceResponse,
  type TurnDetail,
  type TurnSummary,
} from "@ai-npc/contracts";
import { StreamClient, type ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
}

function TraceNode({ node }: { readonly node: TraceResponse["root"] }): ReactNode {
  return (
    <li className="trace-node">
      <div className="trace-line">
        <strong>{node.name}</strong>
        <code>{node.spanId}</code>
        <span>{node.durationMs === null ? "open" : `${Math.round(node.durationMs)}ms`}</span>
      </div>
      <pre>{JSON.stringify(node.attrs, null, 2)}</pre>
      {node.children.length === 0 ? null : (
        <ul>{node.children.map((child) => <TraceNode key={child.spanId} node={child} />)}</ul>
      )}
    </li>
  );
}

function ObservabilityPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [events, setEvents] = useState<readonly TimelineItem[]>([]);
  const [agents, setAgents] = useState<readonly AgentStatusView[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [inspector, setInspector] = useState<AgentInspectorResponse | null>(null);
  const [turns, setTurns] = useState<readonly TurnSummary[]>([]);
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null);
  const [turnDetail, setTurnDetail] = useState<TurnDetail | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactBody, setArtifactBody] = useState<string | null>(null);
  const [artifactView, setArtifactView] = useState<"redacted" | "raw">("redacted");
  const artifactRequestSeq = useRef(0);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

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
      if (cancelled || reconnectTimer !== null) return;
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
        if (cancelled || generation !== connectionGeneration) return;
        stream?.close();
        stream = new StreamClient({
          url: host.api.webSocketUrl(ticket.ticket),
          channel: "console.timeline",
          fromStreamSeq: null,
          onMessage: (message) => {
            if (message.type !== "snapshot" || message.channel !== "console.timeline") return;
            try {
              const timeline = timelineResponseSchema.parse(message.data);
              if (!cancelled && generation === connectionGeneration) {
                setEvents(timeline.events);
                setTimelineError(null);
                setStreamError(null);
              }
            } catch (cause) {
              if (!cancelled && generation === connectionGeneration) setTimelineError(String(cause));
            }
          },
          onClose: () => {
            if (!cancelled && generation === connectionGeneration) scheduleReconnect();
          },
          onError: (cause) => {
            if (!cancelled && generation === connectionGeneration) setStreamError(String(cause));
          },
        });
      } catch (cause) {
        if (!cancelled && generation === connectionGeneration) {
          setStreamError(String(cause));
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
        if (!cancelled) setTimelineError(String(cause));
      }
      if (!cancelled) await connectStream();
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
    void host.api.consoleAgents(host.session.branchId).then((response) => {
      if (cancelled) return;
      setAgents(response.agents);
      setSelectedAgent((current) => current ?? response.agents[0]?.agentId ?? null);
      setAgentError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setAgentError(String(cause));
    });
    return () => { cancelled = true; };
  }, [host.api, host.session.branchId]);

  useEffect(() => {
    if (selectedAgent === null) return;
    let cancelled = false;
    setInspector(null);
    setTurns([]);
    setSelectedTurn(null);
    setTurnDetail(null);
    setTrace(null);
    void Promise.all([
      host.api.consoleInspector(selectedAgent, host.session.branchId),
      host.api.consoleTurns({ agentId: selectedAgent, branchId: host.session.branchId, limit: 20 }),
    ]).then(([nextInspector, nextTurns]) => {
      if (cancelled) return;
      setInspector(nextInspector);
      const branchTurns = nextTurns.turns.filter((turn) => turn.branchId === host.session.branchId);
      setTurns(branchTurns);
      setSelectedTurn((current) =>
        current !== null && branchTurns.some((turn) => turn.turnId === current)
          ? current
          : branchTurns[0]?.turnId ?? null);
      setDetailError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setDetailError(String(cause));
    });
    return () => { cancelled = true; };
  }, [host.api, host.session.branchId, selectedAgent]);

  useEffect(() => {
    if (selectedTurn === null) {
      setTurnDetail(null);
      setTrace(null);
      return;
    }
    artifactRequestSeq.current += 1;
    setTurnDetail(null);
    setTrace(null);
    setSelectedArtifactId(null);
    setArtifactBody(null);
    setArtifactView("redacted");
    let cancelled = false;
    void host.api.consoleTurn(selectedTurn).then(async (detail) => {
      if (cancelled) return;
      setTurnDetail(detail);
      setDetailError(null);
      if (detail.traceId === null) {
        setTrace(null);
        return;
      }
      try {
        const nextTrace = await host.api.consoleTrace(detail.traceId);
        if (!cancelled) setTrace(nextTrace);
      } catch (cause) {
        if (!cancelled) setDetailError(String(cause));
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setDetailError(String(cause));
    });
    return () => { cancelled = true; };
  }, [host.api, selectedTurn]);

  const selectedAgentView = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgent) ?? null,
    [agents, selectedAgent],
  );

  const readArtifact = async (artifactId: string, view: "redacted" | "raw"): Promise<void> => {
    const request = artifactRequestSeq.current + 1;
    artifactRequestSeq.current = request;
    try {
      const artifact = await host.api.consoleArtifact(artifactId, view);
      if (request !== artifactRequestSeq.current) return;
      setArtifactBody(artifact.body);
      setSelectedArtifactId(artifactId);
      setArtifactView(view);
      setDetailError(null);
    } catch (cause) {
      if (request !== artifactRequestSeq.current) return;
      setDetailError(String(cause));
    }
  };

  return (
    <section className="console-page" data-testid="console-page-observability">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">研究视图</span>
          <h1>事件、身份与证据</h1>
        </div>
        <span className="branch-chip">{host.session.branchId}</span>
      </header>
      {detailError === null ? null : <div className="console-error" role="alert">{detailError}</div>}
      <div className="console-split observability-split">
        <section className="console-panel">
          <header><h2>世界时间线</h2><span>{events.length} 条{streamError === null ? "" : " · 重连中"}</span></header>
          {timelineError === null ? null : <div className="console-error" role="alert">时间线读取失败：{timelineError}</div>}
          <div className="timeline-list">
            {events.length === 0 ? <p className="console-empty">当前分支尚无领域事件。</p> : events.map((event) => (
              <article
                className="timeline-row"
                key={event.eventId ?? [
                  "lifecycle",
                  event.worldSeq,
                  event.worldTick,
                  event.type,
                  event.principalId,
                  event.createdAt,
                ].join(":")}
              >
                <div><span>{event.worldSeq === null ? "lifecycle" : `#${event.worldSeq}`}</span><time>{event.worldTick === null ? "—" : `t${event.worldTick}`}</time></div>
                <strong>{event.type}</strong>
                <p>{event.summaryZh}</p>
                <small>{event.principalId ?? "system"} · {event.createdAt}</small>
              </article>
            ))}
          </div>
        </section>
        <section className="console-panel">
          <header><h2>Agent 状态</h2><span>{agents.length} 个激活</span></header>
          {agentError === null ? null : <div className="console-error" role="alert">Agent 状态读取失败：{agentError}</div>}
          <div className="agent-list">
            {agents.length === 0 ? <p className="console-empty">Agent 运行时尚未接入。</p> : agents.map((agent) => (
              <button
                type="button"
                className={`agent-row ${agent.agentId === selectedAgent ? "is-selected" : ""}`}
                key={agent.agentId}
                onClick={() => setSelectedAgent(agent.agentId)}
              >
                <div><strong>{agent.agentId}</strong><small>{agent.kind} · {agent.controllerKind}</small></div>
                <span>{agent.turnStatus}</span>
                <em>{agent.watermarkLag}</em>
              </button>
            ))}
          </div>
        </section>
      </div>
      <div className="console-two-column research-grid">
        <section className="console-panel">
          <header><h2>Agent 检查器</h2><span>{inspector?.location ?? selectedAgentView?.location ?? "未定位"}</span></header>
          {inspector === null ? <p className="console-empty">选择 Agent 后读取检查器。</p> : (
            <div className="agent-inspector">
              <div className="console-kv">
                <div><dt>memory rev</dt><dd>{inspector.memoryRevision}</dd></div>
                <div><dt>observation seq</dt><dd>{inspector.watermarks.observationSeq}</dd></div>
                <div><dt>derived tick</dt><dd>{inspector.watermarks.derivedThroughTick}</dd></div>
              </div>
              <h3>记忆</h3>
              {inspector.memoryRecords.slice(0, 8).map((record) => (
                <article key={record.memoryId}>
                  <strong>{record.kind} · {record.memoryId}</strong>
                  <small>{record.epistemic} · {record.status}</small>
                  <p>{JSON.stringify(record.content)}</p>
                </article>
              ))}
              <h3>关系与承诺</h3>
              {[...inspector.relations, ...inspector.commitments].map((item) => (
                <article key={JSON.stringify(item)}><pre>{JSON.stringify(item, null, 2)}</pre></article>
              ))}
            </div>
          )}
        </section>
        <section className="console-panel">
          <header><h2>turn 证据</h2><span>{turns.length} 个 turn</span></header>
          <div className="debug-turn-list">
            {turns.map((turn) => (
              <button type="button" key={turn.turnId} className={turn.turnId === selectedTurn ? "is-selected" : ""} onClick={() => setSelectedTurn(turn.turnId)}>
                <span>{turn.agentId}</span><strong>{turn.status}</strong><small>{turn.terminalReason ?? turn.turnId}</small>
              </button>
            ))}
            {turns.length === 0 ? <p className="console-empty">当前 Agent 尚无 turn。</p> : null}
          </div>
          {turnDetail === null ? null : (
            <div className="turn-detail">
              <div className="console-kv">
                <div><dt>trace</dt><dd>{turnDetail.traceId}</dd></div>
                <div><dt>stages</dt><dd>{turnDetail.stages.length}</dd></div>
                <div><dt>attempts</dt><dd>{turnDetail.attempts.length}</dd></div>
                <div><dt>tool calls</dt><dd>{turnDetail.toolCalls.length}</dd></div>
              </div>
              <h3>Attempts</h3>
              {turnDetail.attempts.map((attempt) => (
                <article key={attempt.attemptId}>
                  <strong>{attempt.purpose} · {attempt.modelId} · {attempt.status}</strong>
                  <small>{attempt.isEffective ? "effective" : "inactive"} · {attempt.attemptId}</small>
                  {attempt.requestArtifactId === null ? null : (
                    <button type="button" onClick={() => void readArtifact(attempt.requestArtifactId!, "redacted")}>读取请求</button>
                  )}
                </article>
              ))}
              {turnDetail.speech === null ? null : (
                <p className="turn-speech">{turnDetail.speech.text} <small>{turnDetail.speech.fallback ? "fallback" : "model"}</small></p>
              )}
            </div>
          )}
        </section>
      </div>
      <div className="console-two-column research-grid">
        <section className="console-panel">
          <header><h2>trace 树</h2><span>{trace === null ? "未加载" : trace.traceId}</span></header>
          {trace === null ? <p className="console-empty">选择 turn 后读取 trace。</p> : (
            <ul className="trace-tree"><TraceNode node={trace.root} /></ul>
          )}
        </section>
        <section className="console-panel">
          <header>
            <h2>Artifact</h2>
            <span>{artifactView === "raw" ? "原文已审计" : "默认脱敏"}</span>
          </header>
          <div className="artifact-view-actions">
            <button
              type="button"
              disabled={selectedArtifactId === null}
              onClick={() => {
                if (selectedArtifactId !== null) void readArtifact(selectedArtifactId, "redacted");
              }}
            >
              脱敏
            </button>
            <button
              type="button"
              disabled={selectedArtifactId === null}
              onClick={() => {
                if (selectedArtifactId !== null) void readArtifact(selectedArtifactId, "raw");
              }}
            >
              原文
            </button>
          </div>
          {artifactBody === null ? <p className="console-empty">从 turn attempt 选择请求 artifact。</p> : (
            <pre className="artifact-body">{artifactBody}</pre>
          )}
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
