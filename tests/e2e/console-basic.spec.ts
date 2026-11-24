/**
 * 验证控制台令牌登录、运行总览、研究页面导航与角色禁用状态。
 * 依赖固定双端口与服务端 403 边界；不访问真实观测原文。
 * 禁止把隐藏按钮或静态占位页当作授权通过。
 */
import { expect, test } from "@playwright/test";
import { agentInspectorResponseSchema } from "@ai-npc/contracts";

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
  // 评估角色现在有只读的「评估与对比」页面（实验列表与报告），因此不再落入无页面回退。
  await expect(page.getByTestId("console-nav-evaluation")).toBeEnabled();
  await expect(page.getByText("还没有实验记录。创建实验需要研究员角色并经服务端预检。")).toBeVisible();
  await page.getByTestId("console-role").selectOption("researcher");
  await expect(page.getByTestId("console-page-health")).toBeVisible();
  await expect(page.getByTestId("console-nav-health")).toHaveClass("is-active");
});

test("Agent 检查器显示实际位置和第九条记忆", async ({ page }) => {
  const agentId = "human-independent";
  await page.route(/\/api\/v1\/console\/agents\?/, (route) => route.fulfill({
    json: { agents: [{
      agentId, kind: "character", active: true, controllerKind: "agent",
      location: null, turnStatus: "idle", watermarkLag: 0,
    }] },
  }));
  await page.route(/\/api\/v1\/console\/agents\/human-independent\/inspector\?/, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const inspector = agentInspectorResponseSchema.parse(await response.json());
    const branchId = new URL(route.request().url()).searchParams.get("branchId");
    if (branchId === null) throw new Error("expected inspector branch");
    const memoryRecords = Array.from({ length: 9 }, (_, index) => ({
      memoryId: `mem-${String(index + 1).padStart(12, "0")}`,
      scope: { worldId: "wld-console-fixture", branchId, agentId: inspector.agentId },
      kind: "episodic",
      sourceObservationIds: [],
      contentRefs: [],
      status: "active",
      epistemic: "verified-event",
      releasePolicyId: "policy-1",
      validFromTick: 0,
      validUntilTick: null,
      revision: inspector.memoryRevision,
      content: { summary: `记忆记录 ${index + 1}` },
    }));
    await route.fulfill({ response, json: { ...inspector, location: "node-console-fixture", memoryRecords } });
  });
  await page.goto("http://127.0.0.1:3000/console/#token=e2e-console");
  await page.getByTestId("console-role").selectOption("researcher");
  await page.getByTestId("console-nav-observability").click();
  const inspector = page.locator("section.console-panel").filter({ has: page.getByRole("heading", { name: "Agent 检查器" }) });
  await expect(inspector.locator("header").getByText("node-console-fixture")).toBeVisible();
  await expect(page.getByText("episodic · mem-000000000009", { exact: true })).toBeVisible();
});
