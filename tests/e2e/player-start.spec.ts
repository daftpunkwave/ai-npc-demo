/**
 * 验证玩家从公社开局发言、收到已提交的确定性回复，并从会话读取失败恢复。
 * 依赖固定测试装配、无画面渲染器与玩家 DOM 列表；不请求真实模型。
 * 断言夹具生成并正式提交的对白及真实会话读取，不使用画布像素。
 */
import { expect, test } from "@playwright/test";

test("玩家开局后可收到岑雁的模型夹具回复，并重试读取会话", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173/#token=e2e-player");
  const start = page.getByTestId("faction-start-human-neutral");
  await expect(start).toBeVisible();
  await start.click();

  await expect(page.getByTestId("scene-renderer-null")).toBeVisible();
  await expect(page.getByTestId("list-character-human-independent")).toBeVisible();
  await page.getByTestId("list-character-human-independent").click();
  const greeting = "岑雁，可以帮我护送一趟吗？";
  const dialogue = page.getByTestId("dialogue-line");
  await page.getByTestId("dialogue-input").fill(greeting);
  await page.getByTestId("dialogue-send").click();

  await expect(dialogue.filter({ hasText: greeting })).toHaveCount(1);
  await expect(dialogue.filter({ hasText: "我知道了。" })).toHaveCount(1);
  await expect(dialogue.filter({ hasText: "我知道了。" }).locator("span")).toHaveText("岑雁");

  await page.route("**/api/v1/conversations/human-independent**", (route) => route.abort("failed"));
  await page.getByTestId("dialogue-input").fill("读取失败时不要补造第二条对白。");
  await page.getByTestId("dialogue-send").click();

  await expect(page.getByText(/对白读取失败/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重试读取" })).toBeVisible();
  await expect(dialogue).toHaveCount(2);
  await expect(page.getByText("读取失败时不要补造第二条对白")).toHaveCount(0);

  await page.unroute("**/api/v1/conversations/human-independent**");
  await page.getByRole("button", { name: "重试读取" }).click();
  await expect(dialogue.filter({ hasText: "读取失败时不要补造第二条对白。" })).toHaveCount(1);
  await expect(dialogue.filter({ hasText: greeting })).toHaveCount(0);
});
