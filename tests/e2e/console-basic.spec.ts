/**
 * 验证控制台令牌登录、运行总览、研究页面导航、角色禁用状态，以及观测页流帧与宿主在线分支的协作。
 * 依赖固定双端口与服务端 403 边界；不访问真实观测原文。
 * 禁止把隐藏按钮或静态占位页当作授权通过。
 */
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import {
  agentInspectorResponseSchema,
  consoleStreamSnapshotMessageSchema,
  sessionDescriptorSchema,
} from "@world-prism/contracts";

/** 打开控制台并取宿主启动时读到的会话身份；流帧必须携带当前在线分支才会被观测页采用。 */
async function openConsole(page: Page) {
  const sessionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/session");
  await page.goto("http://127.0.0.1:3000/console/#token=e2e-console");
  return sessionDescriptorSchema.parse(await (await sessionResponse).json());
}

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
  let timelineRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/console/timeline") {
      timelineRequests += 1;
    }
  });
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/api\/v1\/streams\?/, (webSocket) => {
    socket = webSocket;
  });
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
      status: "active",
      epistemic: "verified-event",
      releasePolicyId: "policy-1",
      validFromTick: 0,
      validUntilTick: null,
      revision: index + 1,
      content: { summary: `记忆记录 ${index + 1}` },
    }));
    await route.fulfill({ response, json: { ...inspector, location: "node-console-fixture", memoryRecords } });
  });
  const session = await openConsole(page);
  await page.getByTestId("console-role").selectOption("researcher");
  await page.getByTestId("console-nav-observability").click();
  await expect(page.getByRole("heading", { name: "世界时间线" })).toBeVisible();
  const openSocket = socket as WebSocketRoute | null;
  if (openSocket === null) throw new Error("expected console timeline websocket");
  // 帧按公共契约构造：不符合 WS 协议的帧在传输层就被拒绝，到不了页面。
  openSocket.send(JSON.stringify(consoleStreamSnapshotMessageSchema.parse({
    type: "snapshot",
    channel: "console.timeline",
    streamSeq: 3,
    projectionVersion: 0,
    worldId: session.worldId,
    branchId: session.branchId,
    data: {
      events: [{
        kind: "domain",
        eventId: "evt-000000000003",
        type: "ConsoleFixture",
        summaryZh: "来自实时快照的时间线",
        worldSeq: 3,
        worldTick: 1,
        principalId: null,
        audience: null,
        payload: {},
        correlationId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    },
  })));
  await expect(page.getByText("来自实时快照的时间线", { exact: true })).toBeVisible();
  const inspector = page.locator("section.console-panel").filter({ has: page.getByRole("heading", { name: "Agent 检查器" }) });
  await expect(inspector.locator("header").getByText("node-console-fixture")).toBeVisible();
  await expect(page.getByText("episodic · mem-000000000009", { exact: true })).toBeVisible();
  expect(timelineRequests).toBe(0);
});

test("控制台时间线流连接受阻时回退到 REST 快照", async ({ page }) => {
  let timelineRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/console/timeline") timelineRequests += 1;
  });
  await page.routeWebSocket(/\/api\/v1\/streams\?/, (webSocket) => {
    void webSocket.close({ code: 1011, reason: "fixture unavailable" });
  });
  await page.goto("http://127.0.0.1:3000/console/#token=e2e-console");
  await page.getByTestId("console-role").selectOption("researcher");
  await page.getByTestId("console-nav-observability").click();

  await expect.poll(() => timelineRequests).toBe(1);
});

test("观测页收到其他分支的快照帧时只请宿主核对，宿主更新分支后按新分支重新订阅", async ({ page }) => {
  const switchedBranch = "br-e2e-switched";
  let switched = false;
  await page.route("**/api/v1/session", async (route) => {
    const response = await route.fetch();
    const descriptor = sessionDescriptorSchema.parse(await response.json());
    await route.fulfill({ response, json: switched ? { ...descriptor, branchId: switchedBranch } : descriptor });
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/v1\/streams\?/, (webSocket) => {
    sockets.push(webSocket);
  });
  const session = await openConsole(page);
  await page.getByTestId("console-role").selectOption("researcher");
  await page.getByTestId("console-nav-observability").click();
  await expect.poll(() => sockets.length).toBe(1);
  // 等宿主完成一次定期核对再发帧：下一次定期核对在 5 秒之后，
  // 下面 2.5 秒内的切换只能来自观测页对不一致帧发出的立即核对。
  await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/session");

  // 帧内身份只是提示：观测页不直接采用，宿主向服务端核对后才切换分支。
  switched = true;
  sockets[0]?.send(JSON.stringify(consoleStreamSnapshotMessageSchema.parse({
    type: "snapshot",
    channel: "console.timeline",
    streamSeq: 1,
    projectionVersion: 0,
    worldId: session.worldId,
    branchId: switchedBranch,
    data: { events: [] },
  })));

  await expect(page.getByTestId("console-branch")).toHaveText(switchedBranch, { timeout: 2_500 });
  await expect(page.getByTestId("console-page-observability").locator(".branch-chip")).toHaveText(switchedBranch);
  await expect.poll(() => sockets.length).toBe(2);
});
