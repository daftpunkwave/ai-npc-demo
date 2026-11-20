/**
 * 维护视口平移、缩放与跟随状态，向渲染和输入模块提供只读快照。
 * 依赖模块生命周期与浏览器内存状态；不读取世界权威或提交移动命令。
 * 禁止把相机变化解释为游戏世界位置变化。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";

export interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CameraPort {
  subscribe(listener: (state: CameraState) => void): () => void;
  getSnapshot(): CameraState;
  pan(dx: number, dy: number): void;
  zoomTo(zoom: number): void;
  follow(entityId: string | null): void;
}

class CameraController implements CameraPort {
  private state: CameraState = { x: 0, y: 0, zoom: 1 };
  private followed: string | null = null;
  private readonly listeners = new Set<(state: CameraState) => void>();

  subscribe = (listener: (state: CameraState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CameraState => this.state;

  pan(dx: number, dy: number): void {
    this.update({ ...this.state, x: this.state.x + dx, y: this.state.y + dy });
  }

  zoomTo(zoom: number): void {
    this.update({ ...this.state, zoom: Math.min(2, Math.max(0.5, zoom)) });
  }

  follow(entityId: string | null): void {
    this.followed = entityId;
  }

  followedEntity(): string | null {
    return this.followed;
  }

  private update(next: CameraState): void {
    this.state = next;
    for (const listener of [...this.listeners]) {
      listener(next);
    }
  }
}

export function createCameraModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const camera = new CameraController();
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port: camera,
  });
}
