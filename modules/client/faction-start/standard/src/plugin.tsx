/**
 * 展示当前获准的公社开局，章节名、开场白与时钟刻度取自客户端内容视图，并调用世界视图端口提交 campaign.start 与继续时钟。
 * 依赖授权 campaign 选项、内容视图与 React 交互；不预写世界状态或自动选择其他派系。
 * 禁止在命令失败后关闭开局页或伪造进入游戏。
 */
import { useState, type ReactNode } from "react";
import { usePort, type BrowserViewPort } from "@world-prism/client-sdk";
import type { CampaignResponse, ClientContentView, ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";

interface WorldViewLike {
  getCampaign(): CampaignResponse | null;
  getContent(): ClientContentView | null;
  subscribe(listener: (state: unknown) => void): () => void;
  getSnapshot(): unknown;
  startCampaign(factionId: string): Promise<void>;
}

function FactionStartView(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = worldView.getContent();
  if (content === null) {
    // 模块只在 bootstrap 成功后挂载；缺内容时不退回硬编码文案。
    return null;
  }
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
        <span className="eyebrow">{content.ui.chapterKicker}</span>
        <h1>{content.chapterTitle}</h1>
        <p className="start-lead">{content.ui.startBriefing}</p>
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
          <span>{content.clock.secondsPerTick} 秒 / 游戏小时</span>
          <span>t{content.clock.evaluationTick} 评估</span>
        </footer>
      </section>
      <aside className="start-thesis">
        <span>本周必须完成</span>
        <ol>
          <li>确认三项城市读数何时越过临界值</li>
          <li>把对话转成可执行、可追责的任务与协议</li>
          <li>在 t{content.clock.motionTick} 前为程序案争取足够支持</li>
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
