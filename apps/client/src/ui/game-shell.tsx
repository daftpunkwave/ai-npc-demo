/**
 * 定义玩家端宿主布局与 slot 顺序，只根据授权投影决定开局页或游戏页。
 * 依赖客户端 SDK 的 slot 与投影端口；不渲染具体人物、HUD 或设置实现。
 * 禁止在宿主中复制业务模块内容或绕过投影判断 campaign。
 */
import type { ReactNode } from "react";
import {
  Slot,
  usePortSubscription,
} from "@world-prism/client-sdk";
import type { SessionDescriptor } from "@world-prism/contracts";
import type { ProjectionState } from "@world-prism/client-protocol";

export function GameShell({ session }: { readonly session: SessionDescriptor }): ReactNode {
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  if (state?.projection.campaign == null) {
    return (
      <div className="boot-frame">
        <Slot name="boot.screen" />
      </div>
    );
  }
  return (
    <div className="game-root">
      <header className="top-band">
        <Slot name="hud" />
      </header>
      <main className="game-workbench">
        <section className="scene-region" aria-label="灰港场景">
          <Slot name="scene" />
          <Slot name="overlay" />
        </section>
        <div className="sidebar-region">
          <Slot name="sidebar" />
        </div>
      </main>
      <div className="dialogue-region">
        <Slot name="dialogue" />
      </div>
      <Slot name="settings.section" />
      <Slot name="notification" />
      <div className="session-stamp" title="当前授权会话">
        <span>{session.principalId}</span>
        <span>{state.branchId.slice(0, 11)}</span>
      </div>
    </div>
  );
}
