/**
 * 校验场景树只在投影变化时重建，相机变化只更新世界容器变换并请求一次重绘。
 * 依赖 PixiJS 的纯显示对象与注入的绘制回调；不创建 WebGL 上下文或渲染器。
 * 禁止把相机更新退化成整棵显示树重建。
 */
import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { PlayerProjection } from "@ai-npc/contracts";
import { SceneView, cameraTransform } from "../src/scene-view";

function projection(nodeName: string): PlayerProjection {
  return {
    campaign: null,
    clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
    map: {
      nodes: [{ nodeId: "nd-test-0001", name: nodeName, x: 2, y: 3, facilities: [] }],
      roads: [],
    },
    meters: null,
    stockpiles: [],
    teams: [],
    characters: [],
    tasks: [],
    agreements: [],
    invitations: [],
    conversations: [],
    inbox: [],
    notebook: [],
    awaitingReplyFrom: [],
    notifications: [],
  };
}

function worldOf(root: Container): Container {
  const world = root.children[0];
  if (world === undefined) {
    throw new Error("场景缺少世界容器");
  }
  return world;
}

const screenProjection = {
  worldToScreen: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
};

describe("SceneView", () => {
  it("相机变化只更新世界容器变换，不重建显示对象", () => {
    const root = new Container();
    let renders = 0;
    const view = new SceneView({
      root,
      render: () => {
        renders += 1;
      },
      screenProjection,
      selection: { select: () => undefined },
    });

    view.rebuild(projection("渡口"));
    const world = worldOf(root);
    const childrenBefore = world.children.length;
    expect(childrenBefore).toBeGreaterThan(0);
    expect(renders).toBe(1);

    view.updateCamera({ x: 4, y: -2, zoom: 1.5 });

    expect(worldOf(root)).toBe(world);
    expect(world.children.length).toBe(childrenBefore);
    expect(world.position.x).toBe(424);
    expect(world.position.y).toBe(128);
    expect(world.scale.x).toBe(1.5);
    expect(renders).toBe(2);
  });

  it("投影变化重建世界容器并释放旧显示对象", () => {
    const root = new Container();
    let renders = 0;
    const view = new SceneView({
      root,
      render: () => {
        renders += 1;
      },
      screenProjection,
      selection: { select: () => undefined },
    });

    view.rebuild(projection("渡口"));
    const first = worldOf(root);
    view.rebuild(projection("哨站"));
    const second = worldOf(root);

    expect(second).not.toBe(first);
    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(false);
    expect(root.children).toHaveLength(1);
    expect(renders).toBe(2);
  });

  it("画布尺寸变化只重绘已有场景，没有场景时不重绘", () => {
    const root = new Container();
    let renders = 0;
    const view = new SceneView({
      root,
      render: () => {
        renders += 1;
      },
      screenProjection,
      selection: { select: () => undefined },
    });

    view.resize();
    expect(renders).toBe(0);

    view.rebuild(projection("渡口"));
    view.resize();
    expect(renders).toBe(2);
  });

  it("释放场景后世界容器被销毁", () => {
    const root = new Container();
    const view = new SceneView({
      root,
      render: () => undefined,
      screenProjection,
      selection: { select: () => undefined },
    });

    view.rebuild(projection("渡口"));
    const world = worldOf(root);
    view.dispose();

    expect(world.destroyed).toBe(true);
    expect(root.children).toHaveLength(0);
  });
});

describe("cameraTransform", () => {
  it("只把相机位移叠加到场景偏移上并保留缩放", () => {
    expect(cameraTransform({ x: 10, y: 20, zoom: 2 })).toEqual({ x: 430, y: 150, scale: 2 });
  });
});
