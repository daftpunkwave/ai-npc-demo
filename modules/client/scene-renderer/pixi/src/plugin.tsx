/**
 * 使用 PixiJS 绘制授权投影中的节点、道路、角色与队伍，场景名称取自客户端内容视图，并把点选写回共享选择端口。
 * 依赖客户端投影、内容视图、相机与等距投影端口；不读取未授权数据或预测服务器裁决。
 * 禁止把画布动画当成世界事实，也禁止遗漏卸载时的画布与事件资源清理。
 */
import {
  Application,
  Container,
  Graphics,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import { useEffect, useRef, type ReactNode } from "react";
import { usePort, usePortSubscription, type BrowserViewPort } from "@ai-npc/client-sdk";
import type { ClientContentView, ModuleCreateInput, ModuleInstance, PlayerProjection } from "@ai-npc/contracts";
import type { ProjectionState } from "@ai-npc/client-protocol";

interface WorldViewLike {
  subscribe(listener: (state: ProjectionState | null) => void): () => void;
  getSnapshot(): ProjectionState | null;
  getContent(): ClientContentView | null;
}

interface CameraLike {
  subscribe(listener: (state: { x: number; y: number; zoom: number }) => void): () => void;
  getSnapshot(): { x: number; y: number; zoom: number };
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

const colors = {
  roadOpen: 0x708284,
  roadRestricted: 0xd18b43,
  roadClosed: 0xa94d45,
  node: 0x243a38,
  nodeStroke: 0xd9c9a7,
  text: 0xf2ead8,
  player: 0xd6b35a,
  neutral: 0x879a8f,
} as const;

function factionColor(factionId: string): number {
  const palette: Readonly<Record<string, number>> = {
    "human-neutral": 0xd6b35a,
    "human-independent": 0xc0392b,
    "human-earth-alliance": 0x3e8b62,
    "human-pacifist": 0xc9a83d,
    "human-alien-accord": 0x7c6595,
    "species-fauna": 0xc97139,
    "species-flora": 0x419985,
    "species-extraterrestrial": 0x4d7fa8,
  };
  return palette[factionId] ?? colors.neutral;
}

function roadColor(status: "open" | "restricted" | "closed"): number {
  if (status === "closed") {
    return colors.roadClosed;
  }
  if (status === "restricted") {
    return colors.roadRestricted;
  }
  return colors.roadOpen;
}

function drawScene(
  root: Container,
  projection: PlayerProjection,
  camera: { x: number; y: number; zoom: number },
  screenProjection: ProjectionLike,
  selection: SelectionLike,
): void {
  root.removeChildren().forEach((child) => child.destroy({ children: true }));
  const world = new Container();
  world.position.set(420 + camera.x, 130 + camera.y);
  world.scale.set(camera.zoom);
  root.addChild(world);

  const nodes = new Map(projection.map.nodes.map((node) => [node.nodeId, node]));
  for (const road of projection.map.roads) {
    const from = nodes.get(road.fromNodeId);
    const to = nodes.get(road.toNodeId);
    if (from === undefined || to === undefined) {
      continue;
    }
    const a = screenProjection.worldToScreen(from.x, from.y);
    const b = screenProjection.worldToScreen(to.x, to.y);
    const line = new Graphics()
      .moveTo(a.x, a.y)
      .lineTo(b.x, b.y)
      .stroke({
        color: roadColor(road.status),
        width: 2 + road.risk,
        alpha: road.status === "closed" ? 0.9 : 0.62,
      });
    world.addChild(line);
  }

  for (const node of projection.map.nodes) {
    const point = screenProjection.worldToScreen(node.x, node.y);
    const shape = new Graphics()
      .poly([0, -16, 32, 0, 0, 16, -32, 0])
      .fill({ color: colors.node, alpha: 0.94 })
      .stroke({ color: colors.nodeStroke, width: 1.2, alpha: 0.8 });
    shape.position.set(point.x, point.y);
    shape.eventMode = "static";
    shape.cursor = "pointer";
    shape.on("pointertap", (_event: FederatedPointerEvent) => {
      selection.select({ kind: "node", id: node.nodeId });
    });
    const label = new Text({
      text: node.name,
      style: {
        fill: colors.text,
        fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif",
        fontSize: 12,
      },
    });
    label.anchor.set(0.5, 0);
    label.position.set(point.x, point.y + 18);
    world.addChild(shape, label);
  }

  const byNode = new Map<string, typeof projection.characters>();
  for (const character of projection.characters) {
    const group = byNode.get(character.nodeId) ?? [];
    group.push(character);
    byNode.set(character.nodeId, group);
  }
  for (const [nodeId, characters] of byNode) {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      continue;
    }
    const point = screenProjection.worldToScreen(node.x, node.y);
    characters.forEach((character, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, characters.length);
      const marker = new Graphics()
        .circle(0, 0, 5.5)
        .fill({ color: factionColor(character.factionId) })
        .stroke({ color: 0xf2ead8, width: 1, alpha: 0.85 });
      marker.position.set(point.x + Math.cos(angle) * 19, point.y - 5 + Math.sin(angle) * 9);
      marker.eventMode = "static";
      marker.cursor = "pointer";
      marker.on("pointertap", (_event: FederatedPointerEvent) => {
        selection.select({ kind: "character", id: character.agentId });
      });
      world.addChild(marker);
    });
  }
}

function PixiScene(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const camera = usePort<CameraLike>("client.camera");
  const projection = usePort<ProjectionLike>("client.screen-projection");
  const selection = usePort<SelectionLike>("client.input");
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  const cameraState = usePortSubscription<{ x: number; y: number; zoom: number }>("client.camera");
  const content = worldView.getContent();
  const hostRef = useRef<{ appendChild(node: unknown): unknown } | null>(null);
  const appRef = useRef<Application | null>(null);
  const rootRef = useRef<Container | null>(null);
  const stateRef = useRef(state);
  const cameraRef = useRef(cameraState);
  stateRef.current = state;
  cameraRef.current = cameraState;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    let cancelled = false;
    const app = new Application();
    void app
      .init({
        resizeTo: host as never,
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(
          2,
          (globalThis as unknown as { readonly window?: { readonly devicePixelRatio?: number } })
            .window?.devicePixelRatio ?? 1,
        ),
        autoDensity: true,
      })
      .then(() => {
        if (cancelled) {
          app.destroy(true);
          return;
        }
        host.appendChild(app.canvas as unknown);
        const root = new Container();
        app.stage.addChild(root);
        appRef.current = app;
        rootRef.current = root;
        const current = stateRef.current?.projection;
        if (current !== undefined) {
          drawScene(root, current, cameraRef.current, projection, selection);
        }
      });
    return () => {
      cancelled = true;
      rootRef.current = null;
      appRef.current = null;
      app.destroy(true);
    };
  }, [projection, selection]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null || state === null) {
      return;
    }
    drawScene(root, state.projection, cameraState, projection, selection);
  }, [state, cameraState, projection, selection, worldView]);

  return (
    <div className="scene-host" data-testid="scene-renderer-pixi">
      <div className="scene-canvas" ref={hostRef as never} />
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
