/**
 * 维护玩家当前选择并对外暴露稳定快照，供场景、侧栏与对话共享。
 * 依赖模块生命周期与内存订阅；不发送命令、不预测服务器结果。
 * 禁止让选择状态写入授权投影或绕过输入权限。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";

export type Selection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "character"; readonly id: string }
  | { readonly kind: "team"; readonly id: string }
  | { readonly kind: "task"; readonly id: string };

export interface SelectionPort {
  subscribe(listener: (selection: Selection | null) => void): () => void;
  getSnapshot(): Selection | null;
  select(selection: Selection | null): void;
}

class SelectionController implements SelectionPort {
  private selection: Selection | null = null;
  private readonly listeners = new Set<(selection: Selection | null) => void>();

  subscribe = (listener: (selection: Selection | null) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Selection | null => this.selection;

  select(selection: Selection | null): void {
    this.selection = selection;
    for (const listener of [...this.listeners]) {
      listener(selection);
    }
  }
}

export function createInputModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port: new SelectionController(),
  });
}
