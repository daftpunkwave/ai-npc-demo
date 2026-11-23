/**
 * 核心职责：验证模型布局预检将合法 JSON 交给服务端校验并返回结构化问题。
 * 交互契约：依赖注入的 fetch 和控制台 API 客户端。
 * 约束与禁忌：不启动服务端、不访问真实模型供应商。
 */
import { expect, it, vi } from "vitest";
import { ApiClient } from "../src/http";

it.each([
  { layout: null },
  { layout: ["not-a-layout"] },
  { layout: { schemaVersion: 2 } },
])("将 JSON 草稿 $layout 交给布局校验接口", async ({ layout }) => {
  const issues = { ok: false, errors: [{ code: "schema", message: "布局结构不合法" }] };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(issues));
  const api = new ApiClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl, storage: null, activeRole: "operator" });

  await expect(api.validateModelLayout(layout)).resolves.toEqual(issues);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:3000/api/v1/console/model-layouts/validate",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ layout }) }),
  );
});
