/**
 * 核心职责：验证控制台各领域继续通过同一 ApiClient 会话发送和校验请求。
 * 交互契约：从公开入口构造客户端，使用注入的 Fetch 响应。
 * 约束与禁忌：不访问网络、不依赖浏览器存储或领域文件的导出结构。
 */
import { expect, it, vi } from "vitest";
import { ApiClient } from "../src/index";

const baseUrl = "http://127.0.0.1:3000";
const fixtureSession = {
  sessionToken: "fixture-session", principalId: "researcher-fixture",
  roles: ["operator", "researcher"], expiresAt: "2026-01-01T00:00:00.000Z",
};

it("模型、研究、调试和运营请求共享会话与当前角色", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fixtureSession))
    .mockResolvedValueOnce(Response.json({ layouts: [] }))
    .mockResolvedValueOnce(Response.json({ observations: [] }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ snapshots: [] }));
  const api = new ApiClient({ baseUrl, fetchImpl, storage: null, activeRole: "researcher" });

  await api.login("fixture-login");
  await expect(api.consoleModelLayouts()).resolves.toEqual({ layouts: [] });
  await expect(api.consoleObservations("agent/one", "branch a")).resolves.toEqual({ observations: [] });
  await expect(api.consoleWakeAgent("agent/one", "fixture", "op-000000000001")).resolves.toEqual({ ok: true });
  api.setActiveRole("operator");
  const signal = new AbortController().signal;
  await expect(api.consoleSnapshots(signal)).resolves.toEqual({ snapshots: [] });

  expect(fetchImpl.mock.calls.slice(1).map(([url, options]) => {
    const requestUrl = new URL(String(url));
    const headers = new Headers(options?.headers);
    return [requestUrl.pathname + requestUrl.search, headers.get("authorization"), headers.get("x-active-role")];
  })).toEqual([
    ["/api/v1/console/model-layouts", "Bearer fixture-session", "researcher"],
    ["/api/v1/console/agents/agent%2Fone/observations?branchId=branch+a&fromSeq=0&limit=100", "Bearer fixture-session", "researcher"],
    ["/api/v1/console/debug/agents/agent%2Fone/wake", "Bearer fixture-session", "researcher"],
    ["/api/v1/console/campaign/snapshots", "Bearer fixture-session", "operator"],
  ]);
  expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({
    method: "POST", body: JSON.stringify({ reason: "fixture", operationId: "op-000000000001" }),
  });
  expect(fetchImpl.mock.calls[4]?.[1]?.signal).toBe(signal);
});

it("领域请求复用响应校验和身份过期后的清理", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fixtureSession))
    .mockResolvedValueOnce(Response.json({ layouts: "invalid" }))
    .mockResolvedValueOnce(Response.json({ error: {
      code: "unauthenticated", safeMessage: "会话已过期", retryable: false, traceId: null, detailsArtifactRef: null,
    } }, { status: 401 }));
  const api = new ApiClient({ baseUrl, fetchImpl, storage: null });

  expect(() => api.consoleDebugQueues()).toThrow(expect.objectContaining({ code: "forbidden" }));
  expect(fetchImpl).not.toHaveBeenCalled();
  await api.login("fixture-login");
  api.setActiveRole("researcher");
  await expect(api.consoleModelLayouts()).rejects.toMatchObject({
    issues: [expect.objectContaining({ path: ["layouts"] })],
  });
  await expect(api.consoleTurns()).rejects.toMatchObject({ code: "unauthenticated", safeMessage: "会话已过期" });
  expect(api.token).toBeNull();
});
