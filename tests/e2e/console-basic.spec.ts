/**
 * 验证控制台令牌登录、运行总览、研究页面导航与角色禁用状态。
 * 依赖固定双端口与服务端 403 边界；不访问真实观测原文。
 * 禁止把隐藏按钮或静态占位页当作授权通过。
 */
import { expect, test } from "@playwright/test";

test("控制台显示运行总览并在评估角色下禁用装配页", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/console/#token=e2e-console");
  await expect(page.getByTestId("console-page-health")).toBeVisible();
  await expect(page.getByRole("heading", { name: "灰港控制台" })).toBeVisible();

  const moduleNav = page.getByTestId("console-nav-module-admin");
  await expect(moduleNav).toBeEnabled();
  await page.getByTestId("console-role").selectOption("researcher");
  await page.getByTestId("console-nav-model-mounts").click();
  await expect(page.getByTestId("console-page-model-mounts")).toBeVisible();
  await page.getByTestId("console-nav-observability").click();
  await expect(page.getByTestId("console-page-observability")).toBeVisible();
  await page.getByTestId("console-nav-debug").click();
  await expect(page.getByTestId("console-page-debug")).toBeVisible();
  await page.getByTestId("console-role").selectOption("evaluator");
  await expect(moduleNav).toBeDisabled();
  await expect(page.getByTestId("console-role-denied")).toBeVisible();
});
