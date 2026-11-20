/**
 * 实现灰盒等距坐标的正反变换，固定 64×32 网格并返回稳定屏幕坐标。
 * 依赖模块生命周期与纯算术；不读取相机、地图规则或世界状态。
 * 禁止用投影结果决定可达性、路径或服务器已接受的位置。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface ScreenProjectionPort {
  worldToScreen(x: number, y: number, height?: number): ScreenPoint;
  screenToWorld(px: number, py: number): ScreenPoint;
}

export const tileWidth = 64;
export const tileHeight = 32;

export function worldToScreen(x: number, y: number, height = 0): ScreenPoint {
  return {
    x: (x - y) * (tileWidth / 2),
    y: (x + y) * (tileHeight / 2) - height * 16,
  };
}

export function screenToWorld(px: number, py: number): ScreenPoint {
  return {
    x: px / tileWidth + py / tileHeight,
    y: py / tileHeight - px / tileWidth,
  };
}

export function createProjectionModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: ScreenProjectionPort = {
    worldToScreen: (x, y, height = 0) => worldToScreen(x, y, height),
    screenToWorld: (px, py) => screenToWorld(px, py),
  };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
