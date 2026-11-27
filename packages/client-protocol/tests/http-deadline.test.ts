/**
 * 核心职责：验证 ApiClient 的请求期限与调用方取消：挂起的连接或正文按期限失败，取消原样抛出取消原因。
 * 交互契约：从公开入口构造客户端，注入遵守 AbortSignal 的 Fetch 替身，用假计时器推进期限。
 * 约束与禁忌：不访问网络；每个用例结束都恢复真实计时器，避免共享 worker 内的计时器状态泄漏。
 */
import { DomainError } from "@world-prism/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/index";
import { defaultRequestTimeoutMs } from "../src/http/request";

const baseUrl = "http://127.0.0.1:3000";

/** 直到 signal 中止才以中止原因拒绝的挂起操作，模拟服务端挂起或半开连接。 */
function hangUntilAborted<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const hangingFetch = (): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>((_, init) => hangUntilAborted<Response>(init?.signal));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("请求期限", () => {
  it("连接挂起时按配置的期限失败为可重试的 not-ready", async () => {
    const api = new ApiClient({ baseUrl, fetchImpl: hangingFetch(), storage: null, requestTimeoutMs: 1_000 });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(999);
    await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({
      code: "not-ready", retryable: true, safeMessage: "服务端响应超时，请稍后重试", details: { timeoutMs: 1_000 },
    });
  });

  it("未配置时使用缺省期限", async () => {
    const api = new ApiClient({ baseUrl, fetchImpl: hangingFetch(), storage: null });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(defaultRequestTimeoutMs - 1);
    await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({ code: "not-ready", details: { timeoutMs: defaultRequestTimeoutMs } });
  });

  it("响应头已到而正文挂起时同样按期限失败", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_, init) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => hangUntilAborted<unknown>(init?.signal),
    } as unknown as Response));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, requestTimeoutMs: 500 });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(500);

    await expect(outcome).resolves.toMatchObject({ code: "not-ready", retryable: true });
  });

  it("请求成功或失败后都清除期限计时器", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        sessionToken: "fixture-session", principalId: "console-fixture",
        roles: ["operator"], expiresAt: "2026-01-01T00:00:00.000Z",
      }))
      .mockResolvedValueOnce(Response.json({ unexpected: true }));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null });

    await expect(api.login("fixture-login")).resolves.toMatchObject({ sessionToken: "fixture-session" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(api.content()).rejects.toMatchObject({ code: "plugin-failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("拒绝非正数期限", () => {
    expect(() => new ApiClient({ baseUrl, storage: null, requestTimeoutMs: 0 }))
      .toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => new ApiClient({ baseUrl, storage: null, requestTimeoutMs: Number.NaN }))
      .toThrow(expect.objectContaining({ code: "validation" }));
  });
});

describe("调用方取消", () => {
  it("取消在途请求时原样抛出取消原因，并中止底层 fetch", async () => {
    const fetchImpl = hangingFetch();
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, activeRole: "operator" });
    const caller = new AbortController();
    const outcome = api.consoleHealth(caller.signal).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(0);

    const forwarded = fetchImpl.mock.calls[0]?.[1]?.signal;
    expect(forwarded?.aborted).toBe(false);
    caller.abort();

    const failure = await outcome;
    expect(forwarded?.aborted).toBe(true);
    expect(failure).not.toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("取消原因优先于期限：两者都已发生时调用方拿到自己的取消原因", async () => {
    // 替身不响应 signal，由用例决定何时失败，以便让期限与取消在 fetch 结束前都已发生。
    let failFetch: (cause: unknown) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((_, reject) => {
      failFetch = reject;
    }));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, activeRole: "operator", requestTimeoutMs: 100 });
    const caller = new AbortController();
    const reason = new Error("页面已卸载");
    const outcome = api.consoleHealth(caller.signal).catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(100);
    caller.abort(reason);
    failFetch(new TypeError("fetch failed"));

    await expect(outcome).resolves.toBe(reason);
  });

  it("期限已过但调用方未取消时，fetch 的失败归为超时", async () => {
    let failFetch: (cause: unknown) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((_, reject) => {
      failFetch = reject;
    }));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, requestTimeoutMs: 100 });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(100);
    failFetch(new TypeError("fetch failed"));

    await expect(outcome).resolves.toMatchObject({ code: "not-ready", details: { timeoutMs: 100 } });
  });

  it("没有取消也没有超时的网络失败原样抛出，交给调用方既有的网络失败处理", async () => {
    const networkFailure = new TypeError("fetch failed");
    const api = new ApiClient({
      baseUrl, fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(networkFailure), storage: null,
    });

    await expect(api.session()).rejects.toBe(networkFailure);
  });
});
