/**
 * 核心职责：持有控制台会话的当前世界与在线分支身份，独立于页面定期以服务端会话描述核对，变化时通知订阅者。
 * 交互契约：依赖注入的会话读取函数与 client-protocol 的只读轮询调度；页面只能订阅身份或请求立即核对，身份只按服务端会话描述写入。
 * 约束与禁忌：禁止采用页面或流帧自报的身份；同一时刻最多一个在途核对；宿主卸载信号触发后不再读取或通知。
 */
import { startPolling, type PageVisibilitySource } from "@world-prism/client-protocol";

export interface OnlineBranchIdentity {
  readonly worldId: string;
  readonly branchId: string;
}

export interface OnlineBranchTracker {
  /** 当前已知的在线分支身份。 */
  readonly identity: OnlineBranchIdentity;
  /** 订阅身份变化；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void;
  /** 请求尽快向服务端核对一次；不接受调用方自报的身份。开始核对之前调用不做任何事。 */
  refresh(): void;
  /** 开始定期核对，直到 signal 中止；只应调用一次。 */
  start(signal: AbortSignal): void;
}

export interface OnlineBranchTrackerInput {
  /** 登录时会话描述携带的身份。 */
  readonly initial: OnlineBranchIdentity;
  /** 读取服务端当前会话描述；服务端按请求时的在线分支填写 branchId。 */
  readonly readSession: (signal: AbortSignal) => Promise<OnlineBranchIdentity>;
  readonly visibility?: PageVisibilitySource;
}

/** 两次核对的间隔：其他会话恢复存档或重新开局后，本会话最迟约这么久更新分支标识。 */
export const onlineBranchCheckIntervalMs = 5_000;
/** 连续核对失败时的最长等待。 */
export const onlineBranchMaxBackoffMs = 60_000;

/**
 * 创建在线分支跟踪器。
 * 身份来源只有一个：按序发出的会话核对。页面的流帧只能触发 refresh，不能直接写入身份——
 * 流帧与会话响应之间没有共同的先后序，两路各自写入时，较早发出的响应可能把较新的身份改回旧值。
 */
export function createOnlineBranchTracker(input: OnlineBranchTrackerInput): OnlineBranchTracker {
  let identity: OnlineBranchIdentity = { worldId: input.initial.worldId, branchId: input.initial.branchId };
  const listeners = new Set<() => void>();
  let requestCheck: () => void = () => undefined;

  const apply = (next: OnlineBranchIdentity): void => {
    if (next.worldId === identity.worldId && next.branchId === identity.branchId) return;
    identity = { worldId: next.worldId, branchId: next.branchId };
    for (const listener of [...listeners]) listener();
  };

  return {
    get identity(): OnlineBranchIdentity {
      return identity;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      requestCheck();
    },
    start(signal) {
      if (signal.aborted) return;
      // 核对失败时保留最近一次已知身份，由调度按退避重试；页面自己的请求会如实展示服务端错误。
      const polling = startPolling({
        read: async (readSignal) => {
          const next = await input.readSession(readSignal);
          if (!readSignal.aborted) apply(next);
        },
        intervalMs: onlineBranchCheckIntervalMs,
        maxBackoffMs: onlineBranchMaxBackoffMs,
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      });
      requestCheck = () => polling.refresh();
      signal.addEventListener("abort", () => {
        requestCheck = () => undefined;
        polling.stop();
        listeners.clear();
      }, { once: true });
    },
  };
}
