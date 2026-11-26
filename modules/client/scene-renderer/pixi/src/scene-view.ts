/**
 * 核心职责：维护 PixiJS 场景的显示树，投影变化时重建世界容器，相机变化时只更新容器变换。
 * 交互契约：依赖已授权的玩家投影、屏幕投影与选择端口，并通过注入的 render 回调请求一次重绘。
 * 约束与禁忌：相机与画布尺寸变化不重建显示对象，也不启动持续渲染循环；渲染结果不构成世界事实。
 */
import { Container, Graphics, Text, type FederatedPointerEvent } from "pixi.js";
import type { PlayerProjection } from "@world-prism/contracts";

export interface SceneCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface SceneScreenProjection {
  worldToScreen(x: number, y: number, height?: number): { readonly x: number; readonly y: number };
}

export interface SceneSelection {
  select(
    selection:
      | { readonly kind: "node"; readonly id: string }
      | { readonly kind: "character"; readonly id: string },
  ): void;
}

export interface SceneViewOptions {
  readonly root: Container;
  readonly render: () => void;
  readonly screenProjection: SceneScreenProjection;
  readonly selection: SceneSelection;
}

const colors = {
  roadOpen: 0x708284,
  roadRestricted: 0xd18b43,
  roadClosed: 0xa94d45,
  node: 0x243a38,
  nodeStroke: 0xd9c9a7,
  text: 0xf2ead8,
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

/** 相机只决定世界容器的位移与缩放，与显示对象的内容无关。 */
export function cameraTransform(camera: SceneCamera): { x: number; y: number; scale: number } {
  return { x: 420 + camera.x, y: 130 + camera.y, scale: camera.zoom };
}

export class SceneView {
  private world: Container | null = null;
  private camera: SceneCamera = { x: 0, y: 0, zoom: 1 };

  constructor(private readonly options: SceneViewOptions) {}

  /** 按最新投影重建显示树；重建后按当前相机变换绘制一次。 */
  rebuild(projection: PlayerProjection): void {
    const previous = this.world;
    const world = new Container();
    this.world = world;
    if (previous !== null) {
      this.options.root.removeChild(previous);
      previous.destroy({ children: true });
    }
    this.options.root.addChild(world);
    this.drawWorld(world, projection);
    this.applyCamera(world);
    this.options.render();
  }

  /** 相机变化只更新世界容器的 position/scale，并请求一次重绘。 */
  updateCamera(camera: SceneCamera): void {
    this.camera = camera;
    const world = this.world;
    if (world === null) {
      return;
    }
    this.applyCamera(world);
    this.options.render();
  }

  /** 画布尺寸变化后按需重绘一次；没有显示树时不需要重绘。 */
  resize(): void {
    if (this.world !== null) {
      this.options.render();
    }
  }

  dispose(): void {
    const world = this.world;
    this.world = null;
    if (world !== null) {
      this.options.root.removeChild(world);
      world.destroy({ children: true });
    }
  }

  private applyCamera(world: Container): void {
    const transform = cameraTransform(this.camera);
    world.position.set(transform.x, transform.y);
    world.scale.set(transform.scale);
  }

  private drawWorld(world: Container, projection: PlayerProjection): void {
    const screenProjection = this.options.screenProjection;
    const selection = this.options.selection;
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
}
