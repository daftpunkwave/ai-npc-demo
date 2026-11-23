/**
 * 核心职责：呈现当前时钟与快照，并通过控制台 API 执行暂停、继续、单步、存档和恢复。
 * 交互契约：依赖宿主生成 operationId、控制台会话与 React；不自行计算世界版本。
 * 约束与禁忌：禁止直接改世界状态、跳过服务端角色校验或假设请求成功。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析时会把 React/契约类型判成 any。 */
/* eslint-disable no-unused-vars -- 宿主端口方法参数名只表达调用契约，Codacy 未能解析。 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  ClockView,
  ModuleCreateInput,
  ModuleInstance,
  SessionDescriptor,
  SnapshotView,
} from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";

interface ConsoleHostPort {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
  operationId(): string;
  reload(): void;
  confirm(message: string): boolean;
  waitForClockSettled(ticks: number, signal: AbortSignal): Promise<ClockView>;
}

interface ConsolePagePort extends BrowserViewPort {
  readonly title: string;
}

function actionError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function FactionOpsPage(): ReactNode {
  const host = usePort<ConsoleHostPort>("host.console");
  const [clock, setClock] = useState<ClockView | null>(null);
  const [snapshots, setSnapshots] = useState<readonly SnapshotView[]>([]);
  const [ticks, setTicks] = useState(1);
  const [label, setLabel] = useState("manual-checkpoint");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = async (signal: AbortSignal): Promise<ClockView> => {
    const [health, nextSnapshots] = await Promise.all([
      host.api.consoleHealth(signal),
      host.api.consoleSnapshots(signal),
    ]);
    signal.throwIfAborted();
    setClock(health.clock);
    setSnapshots(nextSnapshots.snapshots);
    return health.clock;
  };

  useEffect(() => {
    const initial = new AbortController();
    activeRequest.current = initial;
    void refresh(initial.signal).catch((cause: unknown) => {
      if (!initial.signal.aborted) setError(`读取运营状态失败：${actionError(cause)}`);
    });
    return () => { activeRequest.current?.abort(); };
  }, [host.api]);

  const run = async (work: (signal: AbortSignal) => Promise<void>, stepTicks?: number): Promise<void> => {
    activeRequest.current?.abort();
    const current = new AbortController();
    activeRequest.current = current;
    const { signal } = current;
    setBusy(true);
    setError(null);
    setMessage(null);
    let operationFailure: string | null = null;
    try {
      await work(signal);
    } catch (cause) {
      operationFailure = actionError(cause);
      if (!signal.aborted) setError(operationFailure);
    }
    if (signal.aborted) return;

    try {
      const latestClock = await refresh(signal);
      if (operationFailure !== null && stepTicks !== undefined && latestClock.mode === "stepping") {
        const settled = await host.waitForClockSettled(stepTicks, signal);
        signal.throwIfAborted();
        setClock(settled);
      }
    } catch (cause) {
      if (signal.aborted) return;
      const refreshFailure = `刷新运营状态失败：${actionError(cause)}`;
      setError(operationFailure === null ? refreshFailure : `${operationFailure}。${refreshFailure}`);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  const control = (mode: "pause" | "resume"): Promise<void> => run(async (signal) => {
    if (clock === null) throw new Error("时钟尚未加载");
    const request = { operationId: host.operationId(), expectedRunVersion: clock.runVersion };
    const nextClock = mode === "pause"
      ? await host.api.consolePauseCampaign(request)
      : await host.api.consoleResumeCampaign(request);
    signal.throwIfAborted();
    setClock(nextClock);
    setMessage(mode === "pause" ? "时钟已暂停" : "时钟已继续");
  });

  const step = (): Promise<void> => run(async (signal) => {
    if (clock === null) throw new Error("时钟尚未加载");
    const next = await host.api.consoleStepCampaign({
      operationId: host.operationId(),
      expectedRunVersion: clock.runVersion,
      ticks,
    });
    signal.throwIfAborted();
    setClock(next);
    const settled = await host.waitForClockSettled(ticks, signal);
    signal.throwIfAborted();
    setClock(settled);
    setMessage(`已请求推进 ${ticks} tick`);
  }, ticks);

  const snapshot = (): Promise<void> => run(async (signal) => {
    await host.api.consoleCreateSnapshot({ operationId: host.operationId(), label });
    signal.throwIfAborted();
    setMessage("快照已创建");
  });

  const restore = (snapshotId: string): Promise<void> => run(async (signal) => {
    const preview = await host.api.consolePreviewSnapshotRestore({
      operationId: host.operationId(),
      snapshotId,
    }, signal);
    signal.throwIfAborted();
    if (!preview.ok) throw new Error(preview.checks.find((check) => !check.ok)?.message ?? "恢复预检未通过");
    if (!host.confirm("确认恢复该快照并切换在线分支？")) return;
    await host.api.consoleRestoreSnapshot({ operationId: host.operationId(), snapshotId });
    signal.throwIfAborted();
    host.reload();
  });

  return (
    <section className="console-page" data-testid="console-page-faction-ops">
      <header className="console-page-head">
        <div>
          <span className="console-eyebrow">运营控制</span>
          <h1>时钟与存档</h1>
        </div>
        <span className={clock?.mode === "paused" ? "branch-chip" : "health-chip"}>
          {clock === null ? "读取中" : `${clock.mode} · t${clock.worldTick}`}
        </span>
      </header>
      {error === null ? null : <div className="console-error" role="alert">{error}</div>}
      {message === null ? null : <div className="console-success" role="status">{message}</div>}
      <div className="console-two-column">
        <section className="console-panel">
          <header><h2>时钟</h2><span>version {clock?.runVersion ?? "-"}</span></header>
          <div className="ops-control-grid">
            <button type="button" disabled={busy || clock?.mode === "paused"} onClick={() => void control("pause")}>暂停</button>
            <button type="button" disabled={busy || clock?.mode === "running"} onClick={() => void control("resume")}>继续</button>
            <label>
              <span>推进 tick</span>
              <input
                type="number"
                min={1}
                max={24}
                value={ticks}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setTicks(Math.max(1, Math.min(24, Number((event.target as unknown as { value: string }).value) || 1)));
                }}
              />
            </label>
            <button type="button" disabled={busy || clock?.mode === "running"} onClick={() => void step()}>单步推进</button>
          </div>
          <div className="console-kv">
            <div><dt>游戏日</dt><dd>{clock?.day ?? "-"}</dd></div>
            <div><dt>小时</dt><dd>{clock?.hour ?? "-"}</dd></div>
            <div><dt>在线分支</dt><dd>{host.session.branchId}</dd></div>
          </div>
        </section>
        <section className="console-panel">
          <header><h2>创建快照</h2><span>{snapshots.length} 个存档</span></header>
          <div className="ops-snapshot-create">
            <input
              aria-label="快照标签"
              value={label}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setLabel((event.target as unknown as { value: string }).value);
              }}
            />
            <button type="button" className="console-primary" disabled={busy || label.trim().length === 0} onClick={() => void snapshot()}>
              创建
            </button>
          </div>
          <div className="snapshot-list">
            {snapshots.map((item) => (
              <article key={item.snapshotId}>
                <div>
                  <strong>{item.label}</strong>
                  <small>t{item.worldTick} · {item.createdAt}</small>
                </div>
                <code>{item.snapshotId}</code>
                <button type="button" disabled={busy} onClick={() => void restore(item.snapshotId)}>恢复</button>
              </article>
            ))}
            {snapshots.length === 0 ? <p className="console-empty">当前分支尚无快照。</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}

export function createFactionOpsPageModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: ConsolePagePort = {
    title: "势力运营",
    renderContribution: (): ReactNode => <FactionOpsPage />,
  };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: () => Promise.resolve(),
    drain: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    port,
  });
}
