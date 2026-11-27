/**
 * 核心职责：验证 ApiClient 的请求期限与调用方取消：挂起的连接或正文按期限失败，取消原样抛出取消原因；
 * fetch 实现不遵守 AbortSignal（永不结束或期限后才交付）时结果同样按中止来源确定。
 * 交互契约：从公开入口构造客户端，注入遵守或忽略 AbortSignal 的 Fetch 替身，用假计时器推进期限。
 * 约束与禁忌：不访问网络；每个用例结束都恢复真实计时器，避免共享 worker 内的计时器状态泄漏。
 */
import { DomainError } from "@world-prism/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/index";
import { defaultRequestTimeoutMs, maxRequestTimeoutMs } from "../src/http/request";

const baseUrl = "http://127.0.0.1:3000";

/** 直到 signal 中止才以中止原因拒绝的挂起操作，模拟服务端挂起或半开连接。 */
function hangUntilAborted<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const hangingFetch = (): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>((_, init) => hangUntilAborted<Response>(init?.signal));

/** 永不结束且忽略 signal 的操作，模拟不遵守中止的 fetch 实现。 */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const loginPayload = {
  sessionToken: "fixture-session", principalId: "console-fixture",
  roles: ["operator"], expiresAt: "2026-01-01T00:00:00.000Z",
};

const pending = Symbol("pending");

/** 不推进计时器，取 promise 当前已落定的值；尚未落定时返回 pending。 */
function settledValue<T>(promise: Promise<T>): Promise<T | typeof pending> {
  return Promise.race([promise, Promise.resolve(pending)]);
}

/** 在 delayMs 后（按假计时器）兑现 value，期间忽略任何 signal。 */
function lateValue<T>(value: T, delayMs: number): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), delayMs);
  });
}

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
      .mockResolvedValueOnce(Response.json(loginPayload))
      .mockResolvedValueOnce(Response.json({ unexpected: true }));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null });

    await expect(api.login("fixture-login")).resolves.toMatchObject({ sessionToken: "fixture-session" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(api.content()).rejects.toMatchObject({ code: "plugin-failed" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("请求结束后移除竞速用的中止监听", async () => {
    const removals: ReturnType<typeof vi.spyOn>[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_, init) => {
      if (init?.signal) removals.push(vi.spyOn(init.signal, "removeEventListener"));
      return Promise.resolve(Response.json(loginPayload));
    });
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null });
    const caller = new AbortController();

    await api.login("fixture-login");
    await api.session(caller.signal).catch(() => undefined);

    expect(removals).toHaveLength(2);
    for (const removal of removals) {
      expect(removal).toHaveBeenCalledWith("abort", expect.any(Function));
    }
  });

  it.each([1, 1_000, maxRequestTimeoutMs])("接受 1 到上限之间的整数期限：%s", (requestTimeoutMs) => {
    expect(() => new ApiClient({ baseUrl, storage: null, requestTimeoutMs })).not.toThrow();
  });

  it.each([
    0, -1, -1_000, 0.5, 1.5, maxRequestTimeoutMs + 1, Number.MAX_SAFE_INTEGER,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN,
  ])("构造时拒绝超出范围或非整数的期限：%s", (requestTimeoutMs) => {
    expect(() => new ApiClient({ baseUrl, storage: null, requestTimeoutMs })).toThrow(expect.objectContaining({
      code: "validation",
      safeMessage: `requestTimeoutMs 必须是 1 到 ${maxRequestTimeoutMs} 之间的整数（毫秒）`,
    }));
  });

  it("上限期限按原值计时，不因 setTimeout 溢出而立即超时", async () => {
    const api = new ApiClient({ baseUrl, fetchImpl: hangingFetch(), storage: null, requestTimeoutMs: maxRequestTimeoutMs });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(settledValue(outcome)).resolves.toBe(pending);
    await vi.advanceTimersByTimeAsync(maxRequestTimeoutMs - 60_000);

    await expect(settledValue(outcome)).resolves.toMatchObject({
      code: "not-ready", details: { timeoutMs: maxRequestTimeoutMs },
    });
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

  it("取消原因优先于期限：两者在同一次派发中发生时调用方拿到自己的取消原因", async () => {
    const caller = new AbortController();
    const reason = new Error("页面已卸载");
    // 替身不响应 signal，只在期限触发的同一次 abort 派发中让调用方也取消：结果判定时两种中止都已发生。
    const fetchImpl = vi.fn<typeof fetch>((_, init) => {
      init?.signal?.addEventListener("abort", () => caller.abort(reason), { once: true });
      return new Promise<Response>(() => undefined);
    });
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, activeRole: "operator", requestTimeoutMs: 100 });
    const outcome = api.consoleHealth(caller.signal).catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(100);

    await expect(settledValue(outcome)).resolves.toBe(reason);
  });

  it("没有取消也没有超时的网络失败原样抛出，交给调用方既有的网络失败处理", async () => {
    const networkFailure = new TypeError("fetch failed");
    const api = new ApiClient({
      baseUrl, fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(networkFailure), storage: null,
    });

    await expect(api.session()).rejects.toBe(networkFailure);
  });
});

describe("不遵守 signal 的 fetch 实现", () => {
  it("连接永不结束时在期限处失败为超时", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => never<Response>());
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, requestTimeoutMs: 1_000 });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(999);
    await expect(settledValue(outcome)).resolves.toBe(pending);
    await vi.advanceTimersByTimeAsync(1);

    await expect(settledValue(outcome)).resolves.toMatchObject({
      code: "not-ready", retryable: true, details: { timeoutMs: 1_000 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("正文在期限之后才交付时结果仍为超时，不交付迟到的成功响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => lateValue<unknown>(loginPayload, 2_000),
    } as unknown as Response));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, requestTimeoutMs: 500 });
    const outcome = api.login("fixture-login").catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(500);
    await expect(settledValue(outcome)).resolves.toMatchObject({ code: "not-ready", details: { timeoutMs: 500 } });

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(outcome).resolves.toBeInstanceOf(DomainError);
    expect(api.token).toBeNull();
  });

  it("响应头在期限之后才交付时结果仍为超时，且不再读取正文", async () => {
    const json = vi.fn(() => Promise.resolve<unknown>(loginPayload));
    const fetchImpl = vi.fn<typeof fetch>(() =>
      lateValue({ ok: true, status: 200, json } as unknown as Response, 2_000));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, requestTimeoutMs: 500 });
    const outcome = api.login("fixture-login").catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(500);
    await expect(settledValue(outcome)).resolves.toMatchObject({ code: "not-ready" });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(json).not.toHaveBeenCalled();
    expect(api.token).toBeNull();
  });

  it("期限之后 fetch 才失败时结果仍为超时，迟到的失败被丢弃", async () => {
    let failFetch: (cause: unknown) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((_, reject) => {
      failFetch = reject;
    }));
    const api = new ApiClient({ baseUrl, fetchImpl, storage: null, requestTimeoutMs: 100 });
    const outcome = api.session().catch((cause: unknown) => cause);

    await vi.advanceTimersByTimeAsync(100);
    await expect(settledValue(outcome)).resolves.toMatchObject({ code: "not-ready", details: { timeoutMs: 100 } });
    failFetch(new TypeError("fetch failed"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toMatchObject({ code: "not-ready" });
  });

  it("调用方取消时立即以取消原因结束，不等待永不结束的 fetch", async () => {
    const api = new ApiClient({
      baseUrl, fetchImpl: vi.fn<typeof fetch>(() => never<Response>()), storage: null, activeRole: "operator",
    });
    const caller = new AbortController();
    const reason = new Error("页面已卸载");
    const outcome = api.consoleHealth(caller.signal).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(0);

    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    await expect(settledValue(outcome)).resolves.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("调用方传入已中止的 signal 时立即以取消原因结束", async () => {
    const api = new ApiClient({
      baseUrl, fetchImpl: vi.fn<typeof fetch>(() => never<Response>()), storage: null, activeRole: "operator",
    });
    const reason = new Error("发出前已取消");

    const outcome = api.consoleHealth(AbortSignal.abort(reason)).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(0);

    await expect(settledValue(outcome)).resolves.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});
