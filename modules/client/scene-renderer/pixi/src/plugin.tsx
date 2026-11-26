/**
 * 使用 PixiJS 绘制授权投影中的节点、道路、角色与队伍，场景名称取自客户端内容视图，并把点选写回共享选择端口。
 * 依赖客户端投影、内容视图、相机与等距投影端口；不读取未授权数据或预测服务器裁决。
 * 禁止把画布动画当成世界事实，也禁止遗漏卸载时的画布与事件资源清理。
 */
import { Application, Container } from "pixi.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePort, usePortSubscription, type BrowserViewPort } from "@world-prism/client-sdk";
import type { ClientContentView, ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import type { ProjectionState } from "@world-prism/client-protocol";
import { SceneApplicationSession, bindSceneResize, sceneApplicationOptions } from "./application";
import { SceneFailureNotice } from "./scene-failure-notice";
import { SceneView } from "./scene-view";

interface WorldViewLike {
  subscribe(listener: (state: ProjectionState | null) => void): () => void;
  getSnapshot(): ProjectionState | null;
  getContent(): ClientContentView | null;
}

interface ProjectionLike {
  worldToScreen(x: number, y: number, height?: number): { x: number; y: number };
}

interface SelectionLike {
  subscribe(listener: (selection: unknown) => void): () => void;
  getSnapshot(): unknown;
  select(
    selection:
      | { readonly kind: "node"; readonly id: string }
      | { readonly kind: "character"; readonly id: string },
  ): void;
}

function devicePixelRatio(): number | undefined {
  return (globalThis as unknown as { readonly window?: { readonly devicePixelRatio?: number } }).window
    ?.devicePixelRatio;
}

function PixiScene(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const projection = usePort<ProjectionLike>("client.screen-projection");
  const selection = usePort<SelectionLike>("client.input");
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  const cameraState = usePortSubscription<{ x: number; y: number; zoom: number }>("client.camera");
  const content = worldView.getContent();
  const hostRef = useRef<{ appendChild(node: unknown): unknown } | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const app = new Application();
    const session = new SceneApplicationSession(app);
    let disposed = false;
    let unbindResize: (() => void) | null = null;
    void session.start(sceneApplicationOptions(host, devicePixelRatio())).then((result) => {
      if (disposed) {
        return;
      }
      if (result.status === "failed") {
        setFailure(result.reason);
        return;
      }
      if (result.status === "cancelled") {
        return;
      }
      host.appendChild(app.canvas as unknown);
      const root = new Container();
      app.stage.addChild(root);
      const view = new SceneView({
        root,
        render: () => app.render(),
        screenProjection: projection,
        selection,
      });
      unbindResize = bindSceneResize(app.renderer, () => view.resize());
      viewRef.current = view;
      setFailure(null);
      setViewVersion((version) => version + 1);
    });
    return () => {
      disposed = true;
      viewRef.current?.dispose();
      viewRef.current = null;
      if (unbindResize !== null) {
        unbindResize();
        unbindResize = null;
      }
      session.dispose();
    };
  }, [projection, selection]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || state === null) {
      return;
    }
    view.rebuild(state.projection);
  }, [state, projection, selection, viewVersion]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    view.updateCamera(cameraState);
  }, [cameraState, viewVersion]);

  return (
    <div className="scene-host" data-testid="scene-renderer-pixi">
      <div className="scene-canvas" ref={hostRef as never} />
      {failure === null ? null : <SceneFailureNotice reason={failure} />}
      <div className="scene-caption">
        {content === null ? null : <span>{content.ui.sceneLabel}</span>}
        <span>{state === null ? "等待投影" : `${state.projection.map.nodes.length} 个地点`}</span>
      </div>
    </div>
  );
}

export function createPixiSceneModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = {
    renderContribution: () => <PixiScene />,
  };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
