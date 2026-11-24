/**
 * 渲染玩家授权投影中的时间、三项读数、水闸分配与资源余额，并调用服务端时钟控制。
 * 品牌、章节名与连接状态文案取自客户端内容视图；依赖世界视图端口与浏览器 React 视图，不直接访问存储或真相事件。
 * 禁止把按钮点击当成立即成功，也禁止在错误时显示虚假的“已保存”。
 */
import { useSyncExternalStore, useState, type ReactNode } from "react";
import {
  usePort,
  usePortSubscription,
  type BrowserViewPort,
} from "@ai-npc/client-sdk";
import type { ClientContentView, ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { ProjectionState } from "@ai-npc/client-protocol";

interface WorldViewConnectionState {
  readonly kind: "connecting" | "connected" | "reconnecting" | "session-expired";
  readonly attempt: number;
  readonly retryInMs: number | null;
  readonly error: string | null;
}

interface WorldViewLike {
  subscribe(listener: (state: ProjectionState | null) => void): () => void;
  getSnapshot(): ProjectionState | null;
  getContent(): ClientContentView | null;
  subscribeConnection(listener: (state: WorldViewConnectionState) => void): () => void;
  getConnectionState(): WorldViewConnectionState;
  pause(): Promise<void>;
  resume(): Promise<void>;
  save(label: string): Promise<void>;
}

const meterLabels = {
  relayStability: "中继",
  orchardWater: "果园",
  migrationSafety: "迁徙",
} as const;

const levelLabels = {
  critical: "危急",
  strained: "紧张",
  stable: "稳定",
} as const;

function amountText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * 重连提示的类名：带错误原因时追加限宽折行类，避免可变长文案撑破 HUD 布局。
 * 单独导出以便在无 DOM 环境下验证分支选择，不必为此引入浏览器测试环境。
 */
export function connectionNoticeClassName(error: string | null): string {
  const base = "hud-connection";
  return error === null || error.length === 0 ? base : `${base} hud-connection-with-reason`;
}

function HudView(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  // 外部状态订阅在订阅时重新读取快照，避免首次渲染与 effect 之间漏掉连接状态。
  const connection = useSyncExternalStore(
    worldView.subscribeConnection,
    worldView.getConnectionState,
    worldView.getConnectionState,
  );
  const [working, setWorking] = useState<"pause" | "resume" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const content = worldView.getContent();
  const projection = state?.projection;
  const clock = projection?.clock;

  const runAction = async (kind: "pause" | "resume" | "save"): Promise<void> => {
    setWorking(kind);
    setMessage(null);
    try {
      if (kind === "pause") {
        await worldView.pause();
      } else if (kind === "resume") {
        await worldView.resume();
      } else {
        await worldView.save(`玩家手动存档 · t${clock?.worldTick ?? 0}`);
      }
      setMessage(kind === "save" ? "存档已创建" : "时钟状态已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(null);
    }
  };

  const delegation = projection?.stockpiles.find((stockpile) => stockpile.delegation !== null)?.delegation;
  return (
    <div className="hud">
      {content === null ? null : (
        <div className="hud-brand">
          <span className="hud-kicker">{content.ui.hudKicker}</span>
          <strong>{content.chapterTitle}</strong>
        </div>
      )}
      <div className="hud-clock">
        <span>第 {clock?.day ?? 1} 天 {String(clock?.hour ?? 0).padStart(2, "0")} 时</span>
        <span className={`clock-state clock-${clock?.mode ?? "paused"}`}>
          {clock?.mode === "running" ? "运行中" : clock?.mode === "stepping" ? "推进中" : "已暂停"}
        </span>
      </div>
      {content === null ? null : connection.kind === "reconnecting" ? (
        <div
          className={connectionNoticeClassName(connection.error)}
          role="status"
          data-testid="stream-status"
        >
          {content.ui.reconnecting}
          {/* 服务端 error 帧的 safeMessage 由连接状态携带，让玩家能区分「正在重连」与具体原因。 */}
          {connection.error === null ? null : <small> {connection.error}</small>}
        </div>
      ) : connection.kind === "session-expired" ? (
        <div
          className="hud-connection hud-connection-expired"
          role="alert"
          data-testid="stream-status"
        >
          {content.ui.sessionExpired}
        </div>
      ) : null}
      <div className="hud-meters" aria-label="局势读数">
        {projection?.meters === null || projection?.meters === undefined ? (
          <span className="muted">开局后显示局势读数</span>
        ) : (
          (Object.keys(meterLabels) as Array<keyof typeof meterLabels>).map((key) => {
            const meter = projection.meters?.[key];
            if (meter === undefined) {
              return null;
            }
            return (
              <div className={`hud-meter meter-${meter.level}`} key={key}>
                <span>{meterLabels[key]}</span>
                <strong>{amountText(meter.value)}</strong>
                <small>{levelLabels[meter.level]}</small>
              </div>
            );
          })
        )}
      </div>
      <div className="hud-resources">
        {delegation === null || delegation === undefined ? (
          <span className="muted">尚无委托余额</span>
        ) : (
          <>
            <span>供给 <b>{amountText(delegation.remaining.supply)}</b></span>
            <span>能源 <b>{amountText(delegation.remaining.energy)}</b></span>
            <span>医疗 <b>{amountText(delegation.remaining.medical)}</b></span>
          </>
        )}
      </div>
      <div className="hud-actions">
        {clock?.mode === "running" ? (
          <button
            type="button"
            data-testid="hud-pause"
            disabled={working !== null}
            onClick={() => void runAction("pause")}
          >
            {working === "pause" ? "暂停中" : "暂停"}
          </button>
        ) : (
          <button
            type="button"
            data-testid="hud-resume"
            disabled={working !== null || projection?.campaign === null}
            onClick={() => void runAction("resume")}
          >
            {working === "resume" ? "继续中" : "继续"}
          </button>
        )}
        <button
          type="button"
          data-testid="hud-save"
          disabled={working !== null || projection?.campaign === null}
          onClick={() => void runAction("save")}
        >
          {working === "save" ? "保存中" : "存档"}
        </button>
      </div>
      {message === null ? null : <div className="hud-message" role="status">{message}</div>}
    </div>
  );
}

export function createHudModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = { renderContribution: () => <HudView /> };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
