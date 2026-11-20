/**
 * 验证玩家从登录令牌进入公社开局、自动继续时钟、选择角色并提交第一句对白。
 * 依赖固定测试装配、无画面渲染器与玩家 DOM 列表；不请求真实模型。
 * 禁止把画布像素或模型逐字输出作为稳定断言。
 */
import { expect, test } from "@playwright/test";

test("玩家可以开局、选择岑雁并提交对白", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173/#token=e2e-player");
  const start = page.getByTestId("faction-start-human-neutral");
  await expect(start).toBeVisible();
  await start.click();

  await expect(page.getByTestId("scene-renderer-null")).toBeVisible();
  await expect(page.getByTestId("list-character-human-independent")).toBeVisible();
  await page.getByTestId("list-character-human-independent").click();
  await page.getByTestId("dialogue-input").fill("岑雁，请确认隘口今天的通行情况。");
  await page.getByTestId("dialogue-send").click();

  await expect(page.getByTestId("dialogue-line").last()).toContainText(
    "岑雁，请确认隘口今天的通行情况。",
  );
});
