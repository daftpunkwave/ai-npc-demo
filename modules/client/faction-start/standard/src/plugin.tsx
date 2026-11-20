/**
 * 展示当前获准的公社开局，并调用世界视图端口提交 campaign.start 与继续时钟。
 * 依赖授权 campaign 选项与 React 交互；不预写世界状态或自动选择其他派系。
 * 禁止在命令失败后关闭开局页或伪造进入游戏。
 */
import { useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@ai-npc/client-sdk";
import type { CampaignResponse, ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";

interface WorldViewLike {
  getCampaign(): CampaignResponse | null;
  subscribe(listener: (state: unknown) => void): () => void;
  getSnapshot(): unknown;
  startCampaign(factionId: string): Promise<void>;
}

function FactionStartView(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campaign = worldView.getCampaign();
  if (campaign?.campaign != null) {
    return null;
  }
  const start = campaign?.starts.find((option) => option.factionId === "human-neutral");
  const startCampaign = async (): Promise<void> => {
    if (start === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await worldView.startCampaign(start.factionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="start-screen">
      <section className="start-briefing">
        <div className="start-orbit" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="eyebrow">序章 / 第一周</span>
        <h1>水闸之前</h1>
        <p className="start-lead">
          你是灰港公社党魁。七日之内，粮仓、果园与迁徙通道会同时逼近临界点。
          对话会留下记录，承诺会改变关系，公开广播无法收回。
        </p>
        {start === undefined ? (
          <div className="start-unavailable" role="alert">
            当前装配没有启用公社开局，无法进入世界。
          </div>
        ) : (
          <button
            type="button"
            className="start-command"
            data-testid={`faction-start-${start.factionId}`}
            disabled={busy}
            onClick={() => void startCampaign()}
          >
            <span>
              <small>唯一开放席位</small>
              <strong>{start.name}</strong>
            </span>
            <span className="start-commission">{start.commission}</span>
            <span className="start-enter">{busy ? "正在建立世界…" : "进入灰港"}</span>
          </button>
        )}
        <div className="start-contacts">
          <span>首批接触</span>
          {start?.contacts.map((contact) => (
            <b key={contact.agentId}>{contact.name}</b>
          ))}
        </div>
        {error === null ? null : <p className="inline-error" role="alert">{error}</p>}
        <footer>
          <span>单玩家</span>
          <span>20 秒 / 游戏小时</span>
          <span>t168 评估</span>
        </footer>
      </section>
      <aside className="start-thesis">
        <span>本周必须完成</span>
        <ol>
          <li>确认三项城市读数何时越过临界值</li>
          <li>把对话转成可执行、可追责的任务与协议</li>
          <li>在 t144 前为程序案争取足够支持</li>
        </ol>
      </aside>
    </div>
  );
}

export function createFactionStartModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = { renderContribution: () => <FactionStartView /> };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
