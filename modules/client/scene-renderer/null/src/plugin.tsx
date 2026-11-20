/**
 * 用无 WebGL 的测试视图记录最近一次玩家场景，并保留可点击的 DOM 场景入口。
 * 依赖授权投影端口与浏览器全局测试日志；不绘制、不命中世界坐标或提交行动。
 * 禁止在测试日志中写入 Agent 私密记忆、凭据或未授权事件。
 */
import { useEffect, type ReactNode } from "react";
import { usePortSubscription, type BrowserViewPort } from "@ai-npc/client-sdk";
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { ProjectionState } from "@ai-npc/client-protocol";

interface SceneLogWindow {
  __aiNpcSceneLog?: {
    readonly projection: ProjectionState["projection"] | null;
  };
}

function sceneLogWindow(): SceneLogWindow | null {
  return (globalThis as unknown as { readonly window?: SceneLogWindow }).window ?? null;
}

function NullScene(): ReactNode {
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  useEffect(() => {
    const current = sceneLogWindow();
    if (current !== null) {
      current.__aiNpcSceneLog = { projection: state?.projection ?? null };
    }
  }, [state]);
  return (
    <div className="scene-null" data-testid="scene-renderer-null">
      <strong>规则测试视图</strong>
      <span>
        {state === null
          ? "等待授权投影"
          : `${state.projection.map.nodes.length} 个地点 · ${state.projection.characters.length} 个角色`}
      </span>
    </div>
  );
}

export function createNullSceneModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = {
    renderContribution: () => <NullScene />,
  };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => {
      const current = sceneLogWindow();
      if (current !== null) {
        delete current.__aiNpcSceneLog;
      }
    },
    port,
  });
}
