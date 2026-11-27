/**
 * 核心职责：验证控制台在线名册休眠与唤醒：休眠先暂停在线时钟并让在线名额归零，实验 run 随后可以开局并完成；
 *   名额不足时唤醒整体拒绝、不留下部分激活的名册，名额腾出后同一 operationId 可重试成功；休眠期间在线时钟不能继续或单步，
 *   休眠状态跨宿主重启保持；在线分支被切换后按旧分支发出的请求被拒绝；幂等重放、前置状态、请求结构与角色权限按控制台运营契约裁决。
 * 交互契约：使用真实测试装配（确定性模型传输）、SQLite 临时目录与控制台 HTTP 接口；部署级计数按激活配额裁决的口径读取。
 * 约束与禁忌：名额占用只在“模拟实验占用”的独立分支上构造，不改写在线分支的激活行；断言读真实存储与公开接口。
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  errorResponseSchema,
  onlineRosterOperationResponseSchema,
  onlineRosterViewSchema,
  type AuthContext,
  type Json,
} from "@world-prism/contracts";
import { startHost, type RunningHost } from "@world-prism/app-server";
import { gameCommandEnvelope } from "./game-support";
import {
  activeAgentsOn,
  activeIdentityCount,
  createExperimentRuns,
  experimentHost,
  experimentSpec,
  researcherHeaders,
  startRun,
  tempRoot,
  waitForRunStatus,
  worldTickOf,
  type ExperimentTestResources,
} from "./experiment-runner-support";

const resources: ExperimentTestResources = { hosts: [], roots: [] };

afterEach(async () => {
  try {
    await Promise.all(resources.hosts.splice(0).map((host) => host.close()));
  } finally {
    for (const root of resources.roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

/** 以玩家身份开局：标准名册的 15 个身份在开局事务内激活并占满部署级名额。 */
function startOnlineCampaign(host: RunningHost): void {
  const auth: AuthContext = {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId, branchId: host.branchId,
    actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
  const receipt = host.authority.commands.execute(auth, gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001"));
  expect(receipt.commandStatus).toBe("accepted");
}

async function sessionHeaders(host: RunningHost, token: string, role: string | null): Promise<Record<string, string>> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  const { sessionToken } = response.json() as { readonly sessionToken: string };
  return { Authorization: `Bearer ${sessionToken}`, ...(role === null ? {} : { "X-Active-Role": role }) };
}

function post(host: RunningHost, headers: Record<string, string>, url: string, payload: Json) {
  return host.app.inject({ method: "POST", url, headers, payload });
}

async function rosterOf(host: RunningHost, headers: Record<string, string>) {
  const response = await host.app.inject({ method: "GET", url: "/api/v1/console/campaign/roster", headers });
  expect(response.statusCode, response.body).toBe(200);
  return onlineRosterViewSchema.parse(response.json());
}

function errorCode(body: unknown): string {
  return errorResponseSchema.parse(body).error.code;
}

function onlineActivationStatuses(host: RunningHost): readonly string[] {
  return host.storage.transact((tx) => tx.branch(host.branchId).table("agent_activations").list()
    .map((row) => String(row["status"])));
}

function rosterAudit(host: RunningHost): readonly { readonly type: string; readonly payload: Json }[] {
  return host.storage.transact((tx) => tx.all(
    "SELECT type, payload_json FROM lifecycle_events WHERE branch_id = ? AND type LIKE 'OnlineRoster%' ORDER BY seq",
    [host.branchId],
  ).map((row) => ({ type: String(row["type"]), payload: JSON.parse(String(row["payload_json"])) as Json })));
}

/** 模拟实验占用一个名额：独立的活动实验分支上有一个活动身份，计入部署级配额。 */
function occupyOneIdentity(host: RunningHost): string {
  const branchId = "br-occupant0001";
  host.storage.transact((tx) => {
    tx.rows("branches").put({
      branch_id: branchId, world_id: host.worldId, kind: "experiment", status: "active", parent_branch_id: null,
      forked_at_world_seq: null, run_id: null, profile_hash: null, created_at: new Date().toISOString(),
    });
    tx.branch(branchId).table("agent_activations").put({ agent_id: "human-independent", status: "active", updated_at: new Date().toISOString() });
  });
  return branchId;
}

describe("在线名册休眠与唤醒", () => {
  it("休眠释放在线名额让实验开局完成；名额不足时整体拒绝唤醒，腾出名额后同一 operationId 重试成功", async () => {
    const host = await experimentHost(resources, { rosterRef: "standard-15" });
    startOnlineCampaign(host);
    const operator = await sessionHeaders(host, "experiment-console", "operator");
    expect(await rosterOf(host, operator)).toEqual({
      branchId: host.branchId, state: "active", activeAgents: 15, dormantAgents: 0, deploymentActiveAgents: 15, deploymentLimit: 15,
    });

    // 时钟运行中发起休眠：先受控暂停，再释放名额。
    const before = await rosterClock(host, operator);
    const resumed = await post(host, operator, "/api/v1/console/campaign/resume", { operationId: "op-000000000701", expectedRunVersion: before.runVersion });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const hibernated = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000702", branchId: host.branchId });
    expect(hibernated.statusCode, hibernated.body).toBe(200);
    const hibernatedBody = onlineRosterOperationResponseSchema.parse(hibernated.json());
    expect(hibernatedBody.clock.mode).toBe("paused");
    expect(hibernatedBody.roster).toEqual({
      branchId: host.branchId, state: "hibernated", activeAgents: 0, dormantAgents: 15, deploymentActiveAgents: 0, deploymentLimit: 15,
    });
    expect(activeIdentityCount(host)).toBe(0);
    expect(rosterAudit(host)).toEqual([{
      type: "OnlineRosterHibernated",
      payload: expect.objectContaining({ operationId: "op-000000000702", worldTick: hibernatedBody.clock.worldTick }) as Json,
    }]);
    const released = (rosterAudit(host)[0]?.payload as Record<string, Json> | undefined)?.["agentIds"];
    if (!Array.isArray(released)) throw new Error("休眠审计缺少 agentIds");
    expect(released).toHaveLength(15);
    expect([...released].sort()).toEqual(released);

    // 同键重放返回首次结果且不再写入；新键在已休眠时按前置状态拒绝。
    const replay = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000702", branchId: host.branchId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(hibernated.json());
    expect(rosterAudit(host)).toHaveLength(1);
    const again = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000703", branchId: host.branchId });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again.json())).toBe("invalid-state");

    // 在线名额归零后，实验名册可以在开局事务内预留名额并执行到完成；完成后实验名册同样休眠。
    const researcher = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, researcher, experimentSpec({ experimentId: "exp-roster-hibernation-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    await startRun(host, researcher, runId, "op-000000000704");
    expect(await waitForRunStatus(host, runId, ["completed", "failed", "paused"], 120_000)).toBe("completed");
    expect(activeIdentityCount(host)).toBe(0);

    // 名额被实验占用：唤醒需要 15 个名额，整体拒绝且不激活任何在线身份，也不写入唤醒审计。
    const occupant = occupyOneIdentity(host);
    const refused = await post(host, operator, "/api/v1/console/campaign/roster/wake", { operationId: "op-000000000705", branchId: host.branchId });
    expect(refused.statusCode).toBe(429);
    expect(errorResponseSchema.parse(refused.json()).error).toMatchObject({ code: "budget-exhausted", retryable: true });
    expect(onlineActivationStatuses(host).filter((status) => status === "active")).toEqual([]);
    expect(activeIdentityCount(host)).toBe(1);
    expect(rosterAudit(host).map(({ type }) => type)).toEqual(["OnlineRosterHibernated"]);
    expect((await rosterOf(host, operator)).state).toBe("hibernated");

    // 实验释放名额后，可重试失败不锁定 operationId：同一请求重新执行并恢复全部在线身份，时钟保持暂停。
    host.storage.transact((tx) => {
      const row = tx.rows("branches").get({ branch_id: occupant });
      if (row === null) throw new Error("占用分支不存在");
      tx.rows("branches").put({ ...row, status: "archived" });
    });
    const woken = await post(host, operator, "/api/v1/console/campaign/roster/wake", { operationId: "op-000000000705", branchId: host.branchId });
    expect(woken.statusCode, woken.body).toBe(200);
    const wokenBody = onlineRosterOperationResponseSchema.parse(woken.json());
    expect(wokenBody.roster).toEqual({
      branchId: host.branchId, state: "active", activeAgents: 15, dormantAgents: 0, deploymentActiveAgents: 15, deploymentLimit: 15,
    });
    expect(wokenBody.clock.mode).toBe("paused");
    expect(activeAgentsOn(host, host.branchId)).toHaveLength(15);
    expect(rosterAudit(host).map(({ type }) => type)).toEqual(["OnlineRosterHibernated", "OnlineRosterWoken"]);

    // 唤醒后不再处于休眠：时钟可以继续。
    const continued = await post(host, operator, "/api/v1/console/campaign/resume", {
      operationId: "op-000000000706", expectedRunVersion: wokenBody.clock.runVersion,
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect((continued.json() as { readonly mode: string }).mode).toBe("running");
  }, 180_000);

  it("休眠期间在线时钟不能继续或单步，状态跨重启保持，唤醒后才恢复推进", async () => {
    const dataDir = tempRoot(resources, "world-prism-roster-hibernation-");
    const options = {
      dataDir, playerToken: "roster-player", consoleToken: "roster-console",
      assemblyRef: "local-slg-test-v1", rosterRef: "standard-15",
    } as const;
    const first = await startHost(options);
    resources.hosts.push(first);
    startOnlineCampaign(first);
    const operator = await sessionHeaders(first, "roster-console", "operator");
    const player = await sessionHeaders(first, "roster-player", null);
    const hibernated = await post(first, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000801", branchId: first.branchId });
    expect(hibernated.statusCode, hibernated.body).toBe(200);
    const { clock } = onlineRosterOperationResponseSchema.parse(hibernated.json());

    const blocked = [
      await post(first, operator, "/api/v1/console/campaign/resume", { operationId: "op-000000000802", expectedRunVersion: clock.runVersion }),
      await post(first, operator, "/api/v1/console/campaign/step", { operationId: "op-000000000803", expectedRunVersion: clock.runVersion, ticks: 1 }),
      await post(first, player, "/api/v1/campaign/resume", { operationId: "op-000000000804", expectedRunVersion: clock.runVersion }),
    ];
    for (const response of blocked) {
      expect(response.statusCode).toBe(409);
      expect(errorCode(response.json())).toBe("invalid-state");
    }
    expect(worldTickOf(first, first.branchId)).toBe(clock.worldTick);
    expect((await rosterClock(first, operator)).runVersion).toBe(clock.runVersion);

    // 休眠状态由在线分支的激活行派生，重启后仍拒绝继续时钟。
    const branchId = first.branchId;
    resources.hosts.splice(resources.hosts.indexOf(first), 1);
    await first.close();
    const second = await startHost(options);
    resources.hosts.push(second);
    expect(second.branchId).toBe(branchId);
    const restartedOperator = await sessionHeaders(second, "roster-console", "operator");
    expect((await rosterOf(second, restartedOperator)).state).toBe("hibernated");
    const restartedClock = await rosterClock(second, restartedOperator);
    const stillBlocked = await post(second, restartedOperator, "/api/v1/console/campaign/resume", {
      operationId: "op-000000000805", expectedRunVersion: restartedClock.runVersion,
    });
    expect(stillBlocked.statusCode).toBe(409);
    expect(errorCode(stillBlocked.json())).toBe("invalid-state");

    const woken = await post(second, restartedOperator, "/api/v1/console/campaign/roster/wake", { operationId: "op-000000000806", branchId: second.branchId });
    expect(woken.statusCode, woken.body).toBe(200);
    const stepped = await post(second, restartedOperator, "/api/v1/console/campaign/step", {
      operationId: "op-000000000807", expectedRunVersion: restartedClock.runVersion, ticks: 1,
    });
    expect(stepped.statusCode, stepped.body).toBe(200);
    expect((stepped.json() as { readonly mode: string }).mode).toBe("stepping");
  }, 60_000);

  it("其他会话恢复存档后，按旧在线分支发出的休眠与唤醒被拒绝，不暂停时钟也不改动新在线分支的名册", async () => {
    const host = await experimentHost(resources, { rosterRef: "standard-15" });
    startOnlineCampaign(host);
    const operator = await sessionHeaders(host, "experiment-console", "operator");
    const staleBranchId = host.branchId;

    // 存档后恢复：在线分支切换为后继分支，按旧视图操作的会话仍持有原分支。
    const snapshot = await post(host, operator, "/api/v1/console/campaign/snapshots", { operationId: "op-000000001001", label: "旧视图" });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const { snapshotId } = snapshot.json() as { readonly snapshotId: string };
    const restored = await post(host, operator, "/api/v1/console/campaign/restore", { operationId: "op-000000001002", snapshotId });
    expect(restored.statusCode, restored.body).toBe(200);
    const onlineBranchId = host.branchId;
    expect(onlineBranchId).not.toBe(staleBranchId);

    // 新在线分支运行中：按旧分支发出的休眠在暂停时钟之前就被拒绝，时钟与名册都不变。
    const paused = await rosterClock(host, operator);
    const resumed = await post(host, operator, "/api/v1/console/campaign/resume", {
      operationId: "op-000000001003", expectedRunVersion: paused.runVersion,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const running = await rosterClock(host, operator);
    expect(running.mode).toBe("running");
    const stale = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000001004", branchId: staleBranchId });
    expect(stale.statusCode).toBe(400);
    expect(errorCode(stale.json())).toBe("validation");
    expect(await rosterClock(host, operator)).toMatchObject({ mode: "running", runVersion: running.runVersion });
    expect(await rosterOf(host, operator)).toMatchObject({ branchId: onlineBranchId, state: "active", activeAgents: 15 });

    // 同一 operationId 改投当前在线分支：分支计入请求内容，按幂等冲突拒绝，不会作用到另一个分支。
    const replayedElsewhere = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000001004", branchId: onlineBranchId });
    expect(replayedElsewhere.statusCode).toBe(409);
    expect(errorCode(replayedElsewhere.json())).toBe("idempotency-conflict");
    expect((await rosterClock(host, operator)).mode).toBe("running");

    // 按当前在线分支休眠成功；唤醒同样核对分支，按旧分支唤醒被拒绝，名册保持休眠且没有唤醒审计。
    const hibernated = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000001005", branchId: onlineBranchId });
    expect(hibernated.statusCode, hibernated.body).toBe(200);
    expect(onlineRosterOperationResponseSchema.parse(hibernated.json()).roster).toMatchObject({ branchId: onlineBranchId, state: "hibernated" });
    const staleWake = await post(host, operator, "/api/v1/console/campaign/roster/wake", { operationId: "op-000000001006", branchId: staleBranchId });
    expect(staleWake.statusCode).toBe(400);
    expect(errorCode(staleWake.json())).toBe("validation");
    expect((await rosterOf(host, operator)).state).toBe("hibernated");
    expect(rosterAudit(host).map(({ type }) => type)).toEqual(["OnlineRosterHibernated"]);
  }, 60_000);

  it("前置状态、请求结构与角色权限：未开局与未休眠分别拒绝，只有 operator 可以变更，researcher 只读", async () => {
    const host = await experimentHost(resources, { rosterRef: "standard-15" });
    const operator = await sessionHeaders(host, "experiment-console", "operator");
    const researcher = await researcherHeaders(host);
    const player = await sessionHeaders(host, "experiment-player", null);

    // 未开局：名册为空，休眠在暂停时钟之前就被拒绝，时钟版本不变。
    expect((await rosterOf(host, researcher)).state).toBe("empty");
    const clockBefore = await rosterClock(host, operator);
    const notStarted = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000901", branchId: host.branchId });
    expect(notStarted.statusCode).toBe(409);
    expect(errorCode(notStarted.json())).toBe("invalid-state");
    expect(await rosterClock(host, operator)).toEqual(clockBefore);

    startOnlineCampaign(host);
    const notHibernated = await post(host, operator, "/api/v1/console/campaign/roster/wake", { operationId: "op-000000000902", branchId: host.branchId });
    expect(notHibernated.statusCode).toBe(409);
    expect(errorCode(notHibernated.json())).toBe("invalid-state");

    // 请求结构：多余字段与缺少发起方看到的在线分支都按契约拒绝。
    const invalidPayloads: readonly Json[] = [
      { operationId: "op-000000000903", branchId: host.branchId, extra: true },
      { operationId: "op-000000000907" },
    ];
    for (const payload of invalidPayloads) {
      const invalidBody = await post(host, operator, "/api/v1/console/campaign/roster/hibernate", payload);
      expect(invalidBody.statusCode).toBe(400);
      expect(errorCode(invalidBody.json())).toBe("validation");
    }

    const forbidden = [
      await post(host, researcher, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000904", branchId: host.branchId }),
      await post(host, { ...operator, "X-Active-Role": "evaluator" }, "/api/v1/console/campaign/roster/wake", { operationId: "op-000000000905", branchId: host.branchId }),
      await post(host, player, "/api/v1/console/campaign/roster/hibernate", { operationId: "op-000000000906", branchId: host.branchId }),
      await host.app.inject({ method: "GET", url: "/api/v1/console/campaign/roster", headers: player }),
    ];
    for (const response of forbidden) {
      expect(response.statusCode).toBe(403);
    }
    // 名册路由与其他控制台运营路由共用 branchId 查询参数守卫：与在线分支一致时放行，其他分支或空值按 400 拒绝。
    const sameBranch = await host.app.inject({
      method: "GET", url: `/api/v1/console/campaign/roster?branchId=${host.branchId}`, headers: researcher,
    });
    expect(sameBranch.statusCode, sameBranch.body).toBe(200);
    expect(onlineRosterViewSchema.parse(sameBranch.json()).branchId).toBe(host.branchId);
    const guarded = [
      await host.app.inject({ method: "GET", url: "/api/v1/console/campaign/roster?branchId=br-000000000999", headers: operator }),
      await host.app.inject({ method: "GET", url: "/api/v1/console/campaign/roster?branchId=", headers: operator }),
      await host.app.inject({
        method: "POST", url: "/api/v1/console/campaign/roster/hibernate?branchId=br-000000000999", headers: operator,
        payload: { operationId: "op-000000000908", branchId: host.branchId },
      }),
    ];
    for (const response of guarded) {
      expect(response.statusCode).toBe(400);
      expect(errorCode(response.json())).toBe("validation");
    }
    expect(onlineActivationStatuses(host).every((status) => status === "active")).toBe(true);
    expect(rosterAudit(host)).toEqual([]);
  }, 60_000);
});

/** 读取控制台健康摘要里的在线时钟。 */
async function rosterClock(
  host: RunningHost,
  headers: Record<string, string>,
): Promise<{ readonly mode: string; readonly runVersion: number; readonly worldTick: number }> {
  const response = await host.app.inject({ method: "GET", url: "/api/v1/console/health", headers });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as {
    readonly clock: { readonly mode: string; readonly runVersion: number; readonly worldTick: number };
  }).clock;
}
