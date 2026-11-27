/**
 * 核心职责：验证 ApiClient 对非标准失败响应与不符合契约的成功响应给出登记错误码和安全文案。
 * 交互契约：从公开入口构造客户端，以注入的 Fetch 返回代理、静态层或协议漂移形态的响应。
 * 约束与禁忌：不访问网络与浏览器存储；断言 UI 可见文本中不出现 statusText、响应正文或 Zod 字段路径。
 */
import { DomainError } from "@world-prism/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/index";

const baseUrl = "http://127.0.0.1:3000";
const fixtureLogin = {
  sessionToken: "fixture-session", principalId: "console-fixture",
  roles: ["operator"], expiresAt: "2026-01-01T00:00:00.000Z",
};

function clientAnswering(response: Response): { readonly api: ApiClient; readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>> } {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fixtureLogin))
    .mockResolvedValueOnce(response);
  return { api: new ApiClient({ baseUrl, fetchImpl, storage: null, activeRole: "operator" }), fetchImpl };
}

async function failureOf(response: Response): Promise<DomainError> {
  const { api } = clientAnswering(response);
  await api.login("fixture-login");
  const failure: unknown = await api.campaign().then(
    () => { throw new Error("expected request to fail"); },
    (cause: unknown) => cause,
  );
  if (!(failure instanceof DomainError)) throw new Error(`expected DomainError, got ${String(failure)}`);
  return failure;
}

describe("没有统一错误信封的非 2xx 响应按状态码映射", () => {
  it.each([
    [400, "validation", false],
    [401, "unauthenticated", false],
    [403, "forbidden", false],
    [404, "not-found", false],
    [408, "not-ready", true],
    [409, "invalid-state", false],
    [422, "validation", false],
    [429, "budget-exhausted", true],
    [500, "plugin-failed", true],
    [502, "plugin-failed", true],
    [503, "not-ready", true],
  ] as const)("状态 %i 映射为 %s（可重试 %s）", async (status, code, retryable) => {
    const failure = await failureOf(new Response("<html>gateway page</html>", {
      status, statusText: "Upstream Says No", headers: { "content-type": "text/html" },
    }));

    expect(failure).toMatchObject({ code, retryable, details: { status }, traceId: null });
    expect(failure.message).toBe(failure.safeMessage);
    expect(failure.safeMessage).not.toContain("Upstream Says No");
    expect(failure.safeMessage).not.toContain("gateway page");
  });

  it("代理返回的非标准 403 被识别为 forbidden，而不是 validation", async () => {
    const failure = await failureOf(Response.json(
      { statusCode: 403, error: "Forbidden", message: "Origin rejected by proxy" },
      { status: 403, statusText: "Forbidden" },
    ));

    expect(failure).toMatchObject({
      code: "forbidden", retryable: false, safeMessage: "当前会话无权执行该请求", details: { status: 403 },
    });
  });

  it("非标准 401 同样清除本地会话", async () => {
    const { api } = clientAnswering(new Response(null, { status: 401 }));
    await api.login("fixture-login");
    expect(api.token).toBe("fixture-session");

    await expect(api.campaign()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(api.token).toBeNull();
  });

  it("带统一错误信封时以信封为准，不被状态码兜底覆盖", async () => {
    const failure = await failureOf(Response.json({ error: {
      code: "realm-violation", retryable: false, safeMessage: "当前会话不能读取控制台装配",
      traceId: "trc-000000000001", detailsArtifactRef: null,
    } }, { status: 403 }));

    expect(failure).toMatchObject({
      code: "realm-violation", safeMessage: "当前会话不能读取控制台装配", traceId: "trc-000000000001", details: null,
    });
  });
});

describe("成功响应不符合契约时抛出安全的领域错误", () => {
  it("缺少字段时只暴露统一文案，字段路径放进 details", async () => {
    const failure = await failureOf(Response.json({ starts: [] }));

    expect(failure).toMatchObject({
      code: "plugin-failed",
      retryable: false,
      safeMessage: "服务端响应不符合客户端协议，请刷新页面或联系维护者",
      details: { status: 200, issues: [expect.objectContaining({ path: "campaign" })] },
    });
    // UI 以 message 或 String(error) 渲染：两者都不能带出 Zod 原文或字段路径。
    for (const visible of [failure.message, String(failure)]) {
      expect(visible).not.toContain("campaign");
      expect(visible).not.toMatch(/ZodError|invalid_type|expected/i);
    }
  });

  it("2xx 正文不是 JSON 时同样按协议不一致处理", async () => {
    const failure = await failureOf(new Response("<html>ok</html>", { status: 200 }));

    expect(failure).toMatchObject({ code: "plugin-failed", retryable: false, details: { status: 200 } });
  });
});
