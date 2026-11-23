/**
 * 核心职责：验证切换到读取失败的布局时，页面清空上一个布局的详情和校验结果。
 * 交互契约：使用浏览器和真实控制台，控制所选布局详情请求的响应顺序。
 * 约束与禁忌：不改仓库布局，不请求外部供应商。
 */
import { expect, test } from "@playwright/test";
import { deferred } from "./deferred";

test("新布局加载期间及失败后均清空旧布局状态", async ({ page }) => {
  const badLayout = "shared-model-layout-v1";
  const requested = deferred();
  const completeRequest = deferred();
  await page.route(`**/api/v1/console/model-layouts/${badLayout}`, async (route) => {
    requested.resolve();
    await completeRequest.promise;
    await route.fulfill({
      status: 409,
      json: { error: {
        code: "invalid-state", safeMessage: "布局配置损坏", retryable: false,
        traceId: null, detailsArtifactRef: null,
      } },
    });
  });
  await page.goto("http://127.0.0.1:3000/console/#token=e2e-console");
  await page.getByTestId("console-nav-model-mounts").click();
  const view = page.getByTestId("console-page-model-mounts");
  const previous = "deterministic-model-layout-v1";
  await view.getByRole("button", { name: new RegExp(`^${previous}`) }).click();
  await expect(view.getByRole("heading", { name: previous })).toBeVisible();
  const draft = view.getByRole("textbox", { name: "模型布局草稿" });
  await expect(draft).toHaveValue(new RegExp(previous));
  await view.getByRole("button", { name: "校验布局" }).click();
  await expect(view.getByText("校验通过")).toBeVisible();

  await view.getByRole("button", { name: new RegExp(`^${badLayout}`) }).click();
  await requested.promise;
  try {
    await expect(view.getByRole("heading", { name: previous })).toHaveCount(0);
    await expect(view.getByText("0 条路由")).toBeVisible();
    await expect(draft).toHaveValue("");
    await expect(view.getByText("校验通过")).toHaveCount(0);
  } finally {
    completeRequest.resolve();
  }
  await expect(view.getByRole("alert")).toHaveText(`读取布局 ${badLayout} 失败：布局配置损坏`);
  await expect(draft).toHaveValue("");
  await expect(view.getByRole("button", { name: "校验布局" })).toBeDisabled();
});
