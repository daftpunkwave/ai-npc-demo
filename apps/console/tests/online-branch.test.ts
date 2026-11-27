/**
 * 核心职责：验证控制台宿主独立于页面维护在线分支身份：其他会话切换分支后按会话核对更新，且身份只有一个写入来源。
 * 交互契约：使用真实 ApiClient 与模拟服务端会话端点的 Fetch 替身，注入可见性替身，用假计时器推进核对间隔。
 * 约束与禁忌：不访问网络、不建立 WS 连接、不渲染页面；每个用例结束都恢复真实计时器。
 */
import { ApiClient, type PageVisibilitySource } from "@world-prism/client-protocol";
import type { SessionDescriptor } from "@world-prism/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOnlineBranchTracker,
  onlineBranchCheckIntervalMs,
  type OnlineBranchIdentity,
} from "../src/host/online-branch";

const worldId = "wld-console-fixture";
const loginBranch = "br-000000000001";
const restoredBranch = "br-000000000002";

function sessionDescriptor(branchId: string): SessionDescriptor {
  return {
    principalId: "console-operator",
    roles: ["operator"],
    worldId,
    branchId,
    protocolVersion: "1",
    serverAssembly: { realm: "server", protocolVersion: "1", modules: [], capabilities: [], assemblyHash: "fixture-hash" },
    clientAssembly: null,
  };
}

/** 只提供 `GET /api/v1/session` 的服务端替身；在线分支可由“其他会话”改写。 */
function sessionServer(): {
  readonly api: ApiClient;
  readonly requests: string[];
  switchOnlineBranch(branchId: string): void;
} {
  let onlineBranchId = loginBranch;
  const requests: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>((url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path !== "/api/v1/session") return Promise.reject(new Error(`unexpected request ${path}`));
    return Promise.resolve(Response.json(sessionDescriptor(onlineBranchId)));
  });
  return {
    api: new ApiClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl, storage: null, activeRole: "operator" }),
    requests,
    switchOnlineBranch(branchId) {
      onlineBranchId = branchId;
    },
  };
}

function fakeVisibility(initial: string): { readonly source: PageVisibilitySource; set(next: string): void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      current: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface PendingSession {
  readonly signal: AbortSignal;
  resolve(identity: OnlineBranchIdentity): void;
  reject(cause: unknown): void;
}

function controlledSessions(): {
  readonly readSession: (signal: AbortSignal) => Promise<OnlineBranchIdentity>;
  readonly calls: PendingSession[];
} {
  const calls: PendingSession[] = [];
  return {
    calls,
    readSession: (signal) => new Promise<OnlineBranchIdentity>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    }),
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("控制台在线分支跟踪", () => {
  it("其他会话恢复快照切换在线分支后，只打开运营页的会话按会话核对更新分支标识", async () => {
    const server = sessionServer();
    const tracker = createOnlineBranchTracker({
      initial: { worldId, branchId: loginBranch },
      readSession: (signal) => server.api.session(signal),
      visibility: fakeVisibility("visible").source,
    });
    // 运营页与侧栏都只订阅宿主身份；这里没有任何时间线 WS 连接。
    const operationsPage = vi.fn();
    const sidebar = vi.fn();
    tracker.subscribe(operationsPage);
    tracker.subscribe(sidebar);
    const host = new AbortController();
    tracker.start(host.signal);
    await flush();
    expect(tracker.identity).toEqual({ worldId, branchId: loginBranch });

    server.switchOnlineBranch(restoredBranch);
    await vi.advanceTimersByTimeAsync(onlineBranchCheckIntervalMs - 1);
    expect(tracker.identity.branchId).toBe(loginBranch);
    await vi.advanceTimersByTimeAsync(1);

    expect(tracker.identity).toEqual({ worldId, branchId: restoredBranch });
    expect(operationsPage).toHaveBeenCalledTimes(1);
    expect(sidebar).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(onlineBranchCheckIntervalMs * 3);
    expect(operationsPage).toHaveBeenCalledTimes(1);
    expect(new Set(server.requests)).toEqual(new Set(["GET /api/v1/session"]));
    host.abort();
  });

  it("页面请求核对时，切换前发出的旧响应不会覆盖切换后的身份", async () => {
    const { readSession, calls } = controlledSessions();
    const tracker = createOnlineBranchTracker({
      initial: { worldId, branchId: loginBranch },
      readSession,
      visibility: fakeVisibility("visible").source,
    });
    const listener = vi.fn();
    tracker.subscribe(listener);
    const host = new AbortController();
    tracker.start(host.signal);
    expect(calls).toHaveLength(1);

    // 在线分支切换后，观测页看到新分支的流帧并请求核对；此时切换前发出的核对仍在途。
    tracker.refresh();
    expect(calls).toHaveLength(1);
    calls[0]?.resolve({ worldId, branchId: loginBranch });
    await flush();
    expect(calls).toHaveLength(2);
    expect(tracker.identity.branchId).toBe(loginBranch);

    calls[1]?.resolve({ worldId, branchId: restoredBranch });
    await flush();
    expect(tracker.identity.branchId).toBe(restoredBranch);
    expect(listener).toHaveBeenCalledTimes(1);
    host.abort();
  });

  it("核对失败时保留已知身份并退避重试", async () => {
    const { readSession, calls } = controlledSessions();
    const tracker = createOnlineBranchTracker({
      initial: { worldId, branchId: loginBranch },
      readSession,
      visibility: fakeVisibility("visible").source,
    });
    const listener = vi.fn();
    tracker.subscribe(listener);
    const host = new AbortController();
    tracker.start(host.signal);

    calls[0]?.reject(new Error("服务端暂不可用"));
    await flush();
    expect(tracker.identity.branchId).toBe(loginBranch);
    await vi.advanceTimersByTimeAsync(onlineBranchCheckIntervalMs * 2 - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    calls[1]?.resolve({ worldId, branchId: restoredBranch });
    await flush();
    expect(tracker.identity.branchId).toBe(restoredBranch);
    expect(listener).toHaveBeenCalledTimes(1);
    host.abort();
  });

  it("页面隐藏时暂停核对，恢复可见立即核对", async () => {
    const { readSession, calls } = controlledSessions();
    const visibility = fakeVisibility("visible");
    const tracker = createOnlineBranchTracker({
      initial: { worldId, branchId: loginBranch },
      readSession,
      visibility: visibility.source,
    });
    const host = new AbortController();
    tracker.start(host.signal);
    calls[0]?.resolve({ worldId, branchId: loginBranch });
    await flush();

    visibility.set("hidden");
    await vi.advanceTimersByTimeAsync(onlineBranchCheckIntervalMs * 10);
    expect(calls).toHaveLength(1);
    visibility.set("visible");
    expect(calls).toHaveLength(2);
    host.abort();
  });

  it("宿主卸载后中止在途核对，迟到的响应不再改写身份或通知", async () => {
    const { readSession, calls } = controlledSessions();
    const tracker = createOnlineBranchTracker({
      initial: { worldId, branchId: loginBranch },
      readSession,
      visibility: fakeVisibility("visible").source,
    });
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.refresh();
    expect(calls).toHaveLength(0);
    const host = new AbortController();
    tracker.start(host.signal);

    host.abort();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve({ worldId, branchId: restoredBranch });
    await vi.advanceTimersByTimeAsync(onlineBranchCheckIntervalMs * 10);
    tracker.refresh();

    expect(calls).toHaveLength(1);
    expect(tracker.identity.branchId).toBe(loginBranch);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
