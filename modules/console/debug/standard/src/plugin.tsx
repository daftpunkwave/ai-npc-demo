/**
 * 核心职责：展示调试队列、审计重放结果与调试唤醒入口。
 * 交互契约：依赖 console API、宿主生成的 operationId 与 React；所有写入由服务端守卫。
 * 约束与禁忌：禁止在浏览器重建请求、直接调用模型或把 hash 校验成功说成重新执行。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析时会把 React/契约类型判成 any。 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  DebugQueuesResponse,
  ModuleCreateInput,
  ModuleInstance,
  TurnReplayResponse,
  TurnSummary,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
  operationId(): string;
}

interface ConsolePagePort extends BrowserViewPort {
  readonly title: string;
}

function DebugPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [queues, setQueues] = useState<DebugQueuesResponse | null>(null);
  const [turns, setTurns] = useState<readonly TurnSummary[]>([]);
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null);
  const [replay, setReplay] = useState<TurnReplayResponse | null>(null);
  const [agentId, setAgentId] = useState("human-independent");
  const [reason, setReason] = useState("人工检查");
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const replayRequest = useRef(0);
  const loadRequest = useRef(0);

  const load = async (): Promise<void> => {
    const request = loadRequest.current + 1;
    loadRequest.current = request;
    setLoading(true);
    try {
      const [nextQueues, nextTurns] = await Promise.all([
        host.api.consoleDebugQueues(),
        host.api.consoleTurns({ limit: 30 }),
      ]);
      if (request !== loadRequest.current) return;
      setQueues(nextQueues);
      setTurns(nextTurns.turns);
      setSelectedTurn((current) =>
        current !== null && nextTurns.turns.some((turn) => turn.turnId === current)
          ? current
          : nextTurns.turns[0]?.turnId ?? null);
      setError(null);
    } catch (cause) {
      if (request !== loadRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { loadRequest.current += 1; };
  }, [host.api]);

  useEffect(() => {
    replayRequest.current += 1;
    setReplay(null);
  }, [selectedTurn]);

  const replayTurn = async (): Promise<void> => {
    if (selectedTurn === null) return;
    const request = replayRequest.current + 1;
    replayRequest.current = request;
    try {
      const response = await host.api.consoleReplayTurn(selectedTurn);
      if (request !== replayRequest.current) return;
      setReplay(response);
      setError(null);
    } catch (cause) {
      if (request !== replayRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const wake = async (): Promise<void> => {
    if (waking) return;
    setWaking(true);
    try {
      await host.api.consoleWakeAgent(agentId, reason, host.operationId());
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWaking(false);
    }
  };

  return (
    <section className="console-page" data-testid="console-page-debug">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">调试</span>
          <h1>队列、重放与唤醒</h1>
        </div>
        <span className="branch-chip">{turns.length} 个 turn</span>
      </header>
      {error === null ? null : <div className="console-error" role="alert">{error}</div>}
      <div className="console-stat-grid">
        <article>
          <span>调度队列</span><strong>{queues?.scheduler.queued ?? "-"}</strong>
          <small>运行中 {queues?.scheduler.running ?? "—"}</small>
        </article>
        <article>
          <span>模型运行中</span><strong>{queues?.modelPool.running ?? "-"}</strong>
          <small>排队 {queues === null ? "—" : (queues.modelPool.queued ?? "未知")}</small>
        </article>
        <article><span>维护队列</span><strong>{queues?.maintenance.queued ?? "-"}</strong></article>
        <article><span>最老活动</span><small>{queues?.modelPool.oldestAt ?? queues?.maintenance.oldestAt ?? "—"}</small></article>
      </div>
      <div className="console-action-row">
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? "刷新中" : "刷新队列"}
        </button>
      </div>
      <div className="console-two-column">
        <section className="console-panel">
          <header><h2>审计重放</h2><span>{selectedTurn ?? "未选择"}</span></header>
          <div className="debug-turn-list">
            {turns.map((turn) => (
              <button
                type="button"
                key={turn.turnId}
                className={turn.turnId === selectedTurn ? "is-selected" : ""}
                onClick={() => {
                  replayRequest.current += 1;
                  setSelectedTurn(turn.turnId);
                  setReplay(null);
                }}
              >
                <span>{turn.agentId}</span>
                <strong>{turn.status}</strong>
                <small>{turn.terminalReason ?? turn.turnId}</small>
              </button>
            ))}
          </div>
          <div className="console-action-row">
            <button type="button" className="console-primary" disabled={selectedTurn === null} onClick={() => void replayTurn()}>
              校验归档 hash
            </button>
            {replay === null ? null : (
              <span className={replay.requestHashMatch ? "console-ok" : "console-error-text"}>
                {replay.requestHashMatch ? "hash 一致" : `${replay.differences.length} 个差异`}
              </span>
            )}
          </div>
          {replay?.differences.map((difference) => (
            <p className="console-error" key={difference.path}>{difference.path}</p>
          ))}
        </section>
        <section className="console-panel">
          <header><h2>调试唤醒</h2><span>污染当前 run</span></header>
          <div className="debug-wake-form">
            <label>
              <span>Agent</span>
              <input
                value={agentId}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setAgentId((event.target as unknown as { value: string }).value);
                }}
              />
            </label>
            <label>
              <span>原因</span>
              <input
                value={reason}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setReason((event.target as unknown as { value: string }).value);
                }}
              />
            </label>
            <button
              type="button"
              className="console-primary"
              disabled={waking || agentId.trim().length === 0 || reason.trim().length === 0}
              onClick={() => void wake()}
            >
              {waking ? "提交中" : "注入 debug trigger"}
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

export function createDebugPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: ConsolePagePort = {
    title: "调试",
    renderContribution: (): ReactNode => <DebugPage />,
  };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    port,
  });
}
