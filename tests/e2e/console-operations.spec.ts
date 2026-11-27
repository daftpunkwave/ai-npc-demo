/**
 * 核心职责：验证控制台运营页的异步刷新、错误展示、读请求取消、单步恢复、在线名额的休眠与恢复入口、
 *   在线名额轮询（反映其他会话的变化且迟到结果不覆盖操作结果），以及在线分支切换后标识、时钟与快照跟随。
 * 交互契约：使用真实控制台登录和浏览器，对运营 API 施加可控的失败与响应顺序。
 * 约束与禁忌：不改变共享测试世界，不以固定延时制造竞态。
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { consoleHealthResponseSchema, onlineRosterViewSchema, sessionDescriptorSchema, type ErrorCode } from "@world-prism/contracts";
import { deferred } from "./deferred";

const snapshotsApi = "**/api/v1/console/campaign/snapshots";
const snapshot = {
  snapshotId: "snap-000000000001", label: "最新快照", worldTick: 0,
  day: 1, createdAt: "2026-01-01T00:00:00.000Z", createdBy: "console-admin",
};

function domainFailure(code: ErrorCode, safeMessage: string) {
  return { error: { code, safeMessage, retryable: false, traceId: null, detailsArtifactRef: null } };
}

async function openOperations(page: Page) {
  await page.goto("http://127.0.0.1:3000/console/#token=e2e-console");
  await page.getByTestId("console-nav-faction-ops").click();
  return page.getByTestId("console-page-faction-ops");
}

for (const operationFails of [false, true]) {
  test(operationFails ? "操作和刷新均失败时保留两个错误" : "操作成功但刷新失败时分别展示结果", async ({ page }) => {
    let reads = 0;
    await page.route(snapshotsApi, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill(operationFails
          ? { status: 409, json: domainFailure("invalid-state", "创建快照冲突") }
          : { json: { snapshotId: snapshot.snapshotId, worldTick: snapshot.worldTick } });
      } else if (reads++ === 0) {
        await route.fulfill({ json: { snapshots: [] } });
      } else {
        await route.fulfill({ status: 503, json: domainFailure("not-ready", "存档列表暂不可用") });
      }
    });
    const operations = await openOperations(page);
    await expect(operations.getByText(/^version \d+$/)).toBeVisible();
    const create = operations.getByRole("button", { name: "创建", exact: true });
    await create.click();

    const alert = operations.getByRole("alert");
    await expect(alert).toContainText("刷新运营状态失败：存档列表暂不可用");
    if (operationFails) {
      await expect(alert).toContainText("创建快照冲突");
      await expect(operations.getByRole("status")).toHaveCount(0);
    } else {
      await expect(operations.getByRole("status")).toHaveText("快照已创建");
    }
    await expect(create).toBeEnabled();
    expect(reads).toBe(2);
  });
}

for (const switchRole of [false, true]) {
  test(switchRole ? "切换角色会取消运营页未完成的读取" : "新操作取消初次读取并展示最新快照", async ({ page }) => {
    const firstRead = deferred();
    let reads = 0;
    await page.route(snapshotsApi, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ json: { snapshotId: snapshot.snapshotId, worldTick: snapshot.worldTick } });
        return;
      }
      if (reads++ === 0) {
        firstRead.resolve();
        return;
      }
      await route.fulfill({ json: { snapshots: [snapshot] } });
    });
    const operations = await openOperations(page);
    await firstRead.promise;
    const cancelled = page.waitForEvent("requestfailed", {
      predicate: (request) => request.method() === "GET" && request.url().endsWith("/console/campaign/snapshots"),
    });
    if (switchRole) {
      const roles = page.getByTestId("console-role");
      await roles.selectOption("researcher");
      await expect(operations).toHaveCount(0);
      await cancelled;
      await roles.selectOption("operator");
      await page.getByTestId("console-nav-faction-ops").click();
    } else {
      await operations.getByRole("button", { name: "创建", exact: true }).click();
      await cancelled;
    }
    await expect(operations.getByText(snapshot.label)).toBeVisible();
    await expect(operations.getByRole("alert")).toHaveCount(0);
    expect(reads).toBe(2);
  });
}

test("单步响应丢失后继续读取服务端时钟直到推进结束", async ({ page }) => {
  let lostStepResponse = false;
  let readsAfterLoss = 0;
  await page.route("**/api/v1/console/campaign/step", async (route) => {
    lostStepResponse = true;
    await route.abort("failed");
  });
  await page.route("**/api/v1/console/health", async (route) => {
    const readAfterLoss = lostStepResponse ? ++readsAfterLoss : 0;
    const response = await route.fetch();
    const health = consoleHealthResponseSchema.parse(await response.json());
    const clock = readAfterLoss > 0
      ? (readAfterLoss === 1
        ? { ...health.clock, mode: "stepping", runVersion: 11 }
        : { ...health.clock, mode: "paused", worldTick: 1, hour: 1, runVersion: 12 })
      : { ...health.clock, mode: "paused", runVersion: 10 };
    await route.fulfill({ response, json: { ...health, clock } });
  });
  const operations = await openOperations(page);
  await expect(operations.getByText("version 10")).toBeVisible();
  await operations.getByRole("button", { name: "单步推进" }).click();
  await expect(operations.getByText("version 12")).toBeVisible();
  await expect(operations.getByText("paused · t1")).toBeVisible();
  await expect(operations.getByRole("alert")).toBeVisible();
  expect(readsAfterLoss).toBe(2);
});

test("其他会话切换在线分支后，只打开运营页的会话更新侧栏与运营页的分支标识", async ({ page }) => {
  const restoredBranch = "br-e2e-restored";
  let restoredElsewhere = false;
  // 服务端在线分支被其他会话切换：会话描述从此返回新分支。用路由模拟，不改动共享测试世界。
  await page.route("**/api/v1/session", async (route) => {
    const response = await route.fetch();
    const descriptor = sessionDescriptorSchema.parse(await response.json());
    await route.fulfill({ response, json: restoredElsewhere ? { ...descriptor, branchId: restoredBranch } : descriptor });
  });
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  const operations = await openOperations(page);
  const sidebarBranch = page.getByTestId("console-branch");
  const operationsBranch = operations.getByTestId("console-ops-branch");
  await expect(operationsBranch).not.toHaveText("");
  const loginBranch = await operationsBranch.textContent();
  await expect(sidebarBranch).toHaveText(loginBranch ?? "");

  restoredElsewhere = true;

  await expect(sidebarBranch).toHaveText(restoredBranch);
  await expect(operationsBranch).toHaveText(restoredBranch);
  expect(sockets).toEqual([]);
});

test("在线分支切换后中止旧分支的在途读取，按新分支重新读取时钟与快照", async ({ page }) => {
  const restoredBranch = "br-e2e-ops-reread";
  const oldSnapshot = { ...snapshot, snapshotId: "snap-000000000002", label: "旧分支快照" };
  const newSnapshot = { ...snapshot, snapshotId: "snap-000000000003", label: "新分支快照" };
  let restoredElsewhere = false;
  // 其他会话切换了在线分支：会话描述、时钟与快照列表从此按新分支返回。用路由模拟，不改动共享测试世界。
  await page.route("**/api/v1/session", async (route) => {
    const switched = restoredElsewhere;
    const response = await route.fetch();
    const descriptor = sessionDescriptorSchema.parse(await response.json());
    await route.fulfill({ response, json: switched ? { ...descriptor, branchId: restoredBranch } : descriptor });
  });
  await page.route("**/api/v1/console/health", async (route) => {
    const switched = restoredElsewhere;
    const response = await route.fetch();
    const health = consoleHealthResponseSchema.parse(await response.json());
    await route.fulfill({ response, json: { ...health, clock: { ...health.clock, runVersion: switched ? 21 : 10 } } });
  });
  const heldOldReads: Route[] = [];
  let oldReads = 0;
  await page.route(snapshotsApi, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { snapshotId: oldSnapshot.snapshotId, worldTick: oldSnapshot.worldTick } });
    } else if (restoredElsewhere) {
      await route.fulfill({ json: { snapshots: [newSnapshot] } });
    } else if (oldReads++ === 0) {
      await route.fulfill({ json: { snapshots: [oldSnapshot] } });
    } else {
      // 旧分支上操作后的刷新读取：挂到分支切换之后，用来模拟旧分支的迟到结果。
      heldOldReads.push(route);
    }
  });
  const operations = await openOperations(page);
  const operationsBranch = operations.getByTestId("console-ops-branch");
  const create = operations.getByRole("button", { name: "创建", exact: true });
  await expect(operations.getByText(oldSnapshot.label)).toBeVisible();
  await expect(operations.getByText("version 10")).toBeVisible();
  const loginBranch = await operationsBranch.textContent();
  await create.click();
  await expect.poll(() => heldOldReads.length).toBe(1);
  await expect(create).toBeDisabled();

  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => request.method() === "GET" && request.url().endsWith("/console/campaign/snapshots"),
  });
  restoredElsewhere = true;

  await expect(operationsBranch).toHaveText(restoredBranch);
  await expect(operations.getByText("version 21")).toBeVisible();
  await expect(operations.getByText(newSnapshot.label)).toBeVisible();
  await cancelled;
  await expect(operations.getByText(oldSnapshot.label)).toHaveCount(0);
  await expect(create).toBeEnabled();
  await expect(operations.getByRole("alert")).toHaveCount(0);
  await expect(operations.getByRole("status")).toHaveCount(0);

  // 旧分支的结果迟到：浏览器已中止该请求，路由此时交付也不会出现在页面上。
  await heldOldReads[0]?.fulfill({ json: { snapshots: [oldSnapshot] } }).catch(() => undefined);
  await expect(operations.getByText(newSnapshot.label)).toBeVisible();
  await expect(operations.getByText(oldSnapshot.label)).toHaveCount(0);
  await expect(operations.getByText("version 10")).toHaveCount(0);
  expect(loginBranch).not.toBe(restoredBranch);
});

test("在线名额面板：休眠后继续与单步置灰，名额不足时提示原因，恢复名额后重新可用", async ({ page }) => {
  let hibernated = false;
  let wakeAttempts = 0;
  let onlineBranchId: string | null = null;
  const posted: { readonly url: string; readonly body: unknown }[] = [];
  const rosterView = (branchId: string) => ({
    branchId,
    state: hibernated ? "hibernated" : "active",
    activeAgents: hibernated ? 0 : 3,
    dormantAgents: hibernated ? 3 : 0,
    deploymentActiveAgents: hibernated ? 0 : 3,
    deploymentLimit: 15,
  });
  // 名册状态与两个操作都用路由模拟，不改动共享测试世界的激活状态与时钟；读取仍经服务端以取得真实在线分支。
  await page.route("**/api/v1/console/campaign/roster", async (route) => {
    const response = await route.fetch();
    onlineBranchId = onlineRosterViewSchema.parse(await response.json()).branchId;
    await route.fulfill({ response, json: rosterView(onlineBranchId) });
  });
  await page.route("**/api/v1/console/campaign/roster/*", async (route) => {
    const request = route.request();
    posted.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() as unknown });
    if (request.url().endsWith("/wake") && wakeAttempts++ === 0) {
      await route.fulfill({ status: 429, json: domainFailure("budget-exhausted", "部署级 Agent 名额不足，无法恢复在线名册") });
      return;
    }
    if (onlineBranchId === null) throw new Error("名册状态尚未读取");
    hibernated = request.url().endsWith("/hibernate");
    await route.fulfill({
      json: { roster: rosterView(onlineBranchId), clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 } },
    });
  });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  const operations = await openOperations(page);
  const state = operations.getByTestId("console-ops-roster-state");
  const hibernate = operations.getByRole("button", { name: "休眠并释放名额" });
  const wake = operations.getByRole("button", { name: "恢复名额" });
  const resume = operations.getByRole("button", { name: "继续" });
  const step = operations.getByRole("button", { name: "单步推进" });
  await expect(state).toHaveText("占用名额");
  await expect(wake).toBeDisabled();

  await hibernate.click();
  await expect(operations.getByRole("status")).toHaveText("在线名册已休眠，名额已释放");
  await expect(state).toHaveText("已休眠");
  await expect(operations.getByText("部署 0 / 15")).toBeVisible();
  await expect(resume).toBeDisabled();
  await expect(step).toBeDisabled();
  await expect(hibernate).toBeDisabled();

  await wake.click();
  await expect(operations.getByRole("alert")).toContainText("部署级 Agent 名额不足");
  await expect(state).toHaveText("已休眠");
  await expect(wake).toBeEnabled();

  await wake.click();
  await expect(operations.getByRole("status")).toHaveText("在线名额已恢复，时钟保持暂停");
  await expect(state).toHaveText("占用名额");
  await expect(step).toBeEnabled();
  expect(posted.map(({ url }) => url)).toEqual([
    "/api/v1/console/campaign/roster/hibernate",
    "/api/v1/console/campaign/roster/wake",
    "/api/v1/console/campaign/roster/wake",
  ]);
  // 每个操作都带上页面当前的在线分支，服务端据此拒绝按旧视图发出的请求。
  for (const { body } of posted) expect(body).toEqual({ operationId: expect.stringMatching(/^op-/), branchId: onlineBranchId });
});

/** 测试装配 core-3 名册的在线名额视图；deploymentActiveAgents 另计其他分支（实验）占用的名额。 */
function rosterViewOf(branchId: string, hibernated: boolean, otherBranchAgents = 0) {
  return {
    branchId,
    state: hibernated ? "hibernated" : "active",
    activeAgents: hibernated ? 0 : 3,
    dormantAgents: hibernated ? 3 : 0,
    deploymentActiveAgents: (hibernated ? 0 : 3) + otherBranchAgents,
    deploymentLimit: 15,
  };
}

test("其他运营者休眠在线名册、实验占用名额后，运营页按轮询更新名额面板与按钮", async ({ page }) => {
  let hibernatedElsewhere = false;
  let experimentAgents = 0;
  // 名册状态由路由模拟其他会话的变化，读取仍经服务端以取得真实在线分支；时钟固定为暂停，按钮可用性只随名册变化。
  await page.route("**/api/v1/console/campaign/roster", async (route) => {
    const response = await route.fetch();
    const { branchId } = onlineRosterViewSchema.parse(await response.json());
    await route.fulfill({ response, json: rosterViewOf(branchId, hibernatedElsewhere, experimentAgents) });
  });
  await page.route("**/api/v1/console/health", async (route) => {
    const response = await route.fetch();
    const health = consoleHealthResponseSchema.parse(await response.json());
    await route.fulfill({ response, json: { ...health, clock: { ...health.clock, mode: "paused" } } });
  });
  const operations = await openOperations(page);
  const state = operations.getByTestId("console-ops-roster-state");
  const resume = operations.getByRole("button", { name: "继续" });
  const step = operations.getByRole("button", { name: "单步推进" });
  const wake = operations.getByRole("button", { name: "恢复名额" });
  await expect(state).toHaveText("占用名额");
  await expect(operations.getByText("部署 3 / 15")).toBeVisible();
  await expect(resume).toBeEnabled();
  await expect(wake).toBeDisabled();

  // 本页没有任何操作：另一位运营者休眠了在线名册，随后实验 run 占用 12 个名额，下一次轮询读到后更新。
  hibernatedElsewhere = true;
  experimentAgents = 12;
  await expect(state).toHaveText("已休眠");
  await expect(operations.getByText("部署 12 / 15")).toBeVisible();
  await expect(resume).toBeDisabled();
  await expect(step).toBeDisabled();
  await expect(wake).toBeEnabled();
  await expect(operations.getByRole("alert")).toHaveCount(0);
});

test("名额轮询的迟到结果不覆盖休眠操作的结果", async ({ page }) => {
  let onlineBranchId: string | null = null;
  let holdReads = false;
  const heldReads: Route[] = [];
  await page.route("**/api/v1/console/campaign/roster", async (route) => {
    if (holdReads) {
      heldReads.push(route);
      return;
    }
    const response = await route.fetch();
    onlineBranchId = onlineRosterViewSchema.parse(await response.json()).branchId;
    await route.fulfill({ response, json: rosterViewOf(onlineBranchId, false) });
  });
  await page.route("**/api/v1/console/campaign/roster/hibernate", async (route) => {
    if (onlineBranchId === null) throw new Error("名册状态尚未读取");
    await route.fulfill({
      json: { roster: rosterViewOf(onlineBranchId, true), clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 } },
    });
  });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  const operations = await openOperations(page);
  const state = operations.getByTestId("console-ops-roster-state");
  await expect(state).toHaveText("占用名额");

  // 下一次轮询读取在休眠之前发出，挂起到休眠完成之后才返回休眠前的状态。
  holdReads = true;
  await expect.poll(() => heldReads.length).toBe(1);
  await operations.getByRole("button", { name: "休眠并释放名额" }).click();
  await expect(state).toHaveText("已休眠");
  if (onlineBranchId === null) throw new Error("名册状态尚未读取");
  await heldReads[0]?.fulfill({ json: rosterViewOf(onlineBranchId, false) });

  // 页面丢弃迟到结果，并在它结束后立即补读；补读发出时迟到结果已经处理完毕，名额面板仍为休眠。
  await expect.poll(() => heldReads.length).toBe(2);
  await expect(state).toHaveText("已休眠");
  await expect(operations.getByRole("button", { name: "恢复名额" })).toBeEnabled();
  await heldReads[1]?.fulfill({ json: rosterViewOf(onlineBranchId, true) });
  await expect(state).toHaveText("已休眠");
});
