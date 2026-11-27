/**
 * 核心职责：验证实验执行器的配额与失败路径：探针期间名册休眠并在结束后重新预留、配额不足时开局失败、
 * 探针 turn 失败记为无效样本、运行中停止与恢复、收敛超时与不支持的脚本或装配显式失败、宿主重启归位遗留执行。
 * 交互契约：使用真实测试装配、SQLite 与控制台接口；模型路径只用确定性传输与测试自带夹具，不访问网络。
 * 约束与禁忌：配额前置状态只按部署级统计口径构造；断言读真实存储与公开接口，不替换执行器内部实现。
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimentDetailResponseSchema, runReportResponseSchema, type AuthContext, type Json } from "@world-prism/contracts";
import type { RunningHost } from "@world-prism/app-server";
import { gameCommandEnvelope } from "./game-support";
import {
  activeAgentsOn,
  activeIdentityCount,
  branchOf,
  createExperimentRuns,
  eventTypes,
  experimentAudit,
  experimentHost,
  experimentSpec,
  probeResults,
  researcherHeaders,
  runRow,
  sandboxesOf,
  startRun,
  stopRun,
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

/** 以玩家身份开启在线世界：在线名册在开局事务内激活并占用部署级配额。 */
function startOnlineCampaign(host: RunningHost): void {
  const auth: AuthContext = {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId, branchId: host.branchId,
    actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
  const receipt = host.authority.commands.execute(auth, gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001"));
  expect(receipt.commandStatus).toBe("accepted");
}

/**
 * 在一个事务里依次落下停止与再次启动两次控制的持久化效果，写法与 run-control 的两次提交相同：
 * 停止把 run 与时钟置为暂停并递增时钟版本，启动再置为运行并递增一次。
 * 两次 HTTP 控制之间执行器可能被调度，无法确定性地落在同一等待里，因此直接写存储。
 */
function stopAndRestartAtOnce(host: RunningHost, runId: string, branchId: string): void {
  host.storage.transact((tx) => {
    const run = tx.rows("runs").get({ run_id: runId });
    const clocks = tx.branch(branchId).table("clock");
    const clock = clocks.get({});
    if (run === null || clock === null) throw new Error("run 或实验分支时钟不存在");
    const now = new Date().toISOString();
    const stopped = { ...clock, mode: "paused", run_version: Number(clock["run_version"]) + 1, updated_at: now };
    clocks.put(stopped);
    tx.rows("runs").put({ ...run, status: "paused" });
    clocks.put({ ...stopped, mode: "running", run_version: stopped.run_version + 1, updated_at: now });
    tx.rows("runs").put({ ...run, status: "running" });
  });
}

function failureCode(host: RunningHost, runId: string): Json | undefined {
  const failed = experimentAudit(host, branchOf(host, runId)).find(({ type }) => type === "ExperimentRunFailed");
  return (failed?.payload as Record<string, Json> | undefined)?.["code"];
}

/**
 * 无触发主体的自主唤醒（巡检等）不说话；与仓库默认夹具的同名一条相同。
 * 替换夹具时必须保留：传输的默认决策响应要求受众非空，否则巡检 turn 全部失败，
 * 报告会因这些与被测对象无关的失败把 run 记为无效。
 */
const autonomousNoDialogue: Json = {
  id: "autonomous-no-dialogue",
  match: { purpose: "decision", triggerPrincipalCount: 0 },
  response: { finishReason: "tool_calls", toolCalls: [{ name: "decision_submit", arguments: {
    stance: "none",
    dialogueIntent: { kind: "none", audience: [], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
    noteworthy: [], citedMemoryIds: [], decisionNote: "",
  } }] },
};

/** 复制仓库配置并替换确定性模型夹具（用例给出的在前，自主唤醒不说话一条在后），供需要特定模型输出的用例使用。 */
function fixtureConfig(lines: readonly Json[]): string {
  const root = tempRoot(resources, "world-prism-experiment-fixtures-");
  const config = join(root, "config");
  cpSync("config", config, { recursive: true });
  const fixtures = join(root, "tests", "fixtures", "model");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "default.jsonl"), [...lines, autonomousNoDialogue].map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return config;
}

describe("实验执行器的配额与失败路径", () => {
  it("探针期间释放实验名册，只为被问 Agent 占用名额，结束后重新预留", async () => {
    const host = await experimentHost(resources, { rosterRef: "standard-15" });
    startOnlineCampaign(host);
    expect(activeIdentityCount(host)).toBe(15);
    // 运营让出三个在线名额后只剩 3 个空位：实验名册占满后，沙盒必须借用实验名册让出的名额才能提问。
    host.storage.transact((tx) => {
      const activations = tx.branch(host.branchId).table("agent_activations");
      for (const agentId of ["species-fauna", "species-flora", "species-extraterrestrial"]) {
        const row = activations.get({ agent_id: agentId });
        if (row === null) throw new Error(`在线名册缺少 ${agentId}`);
        activations.put({ ...row, status: "dormant" });
      }
    });
    expect(activeIdentityCount(host)).toBe(12);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({ experimentId: "exp-runner-quota-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    await startRun(host, headers, runId, "op-000000000401");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    const [probe] = probeResults(host, runId);
    expect(probe).toMatchObject({ valid: 1, invalid_reason: null });
    // 完成后实验名册休眠、沙盒归档，部署级计数回到在线世界自己的 12 个。
    expect(activeIdentityCount(host)).toBe(12);
    expect(sandboxesOf(host, branchOf(host, runId)).map((row) => row["status"])).toEqual(["archived"]);
  }, 120_000);

  it("在线名册占满配额时实验暂停在开局前，腾出名额后继续执行到完成", async () => {
    const host = await experimentHost(resources, { rosterRef: "standard-15" });
    startOnlineCampaign(host);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({ experimentId: "exp-runner-full-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const branchId = branchOf(host, runId);
    await startRun(host, headers, runId, "op-000000000501");
    // 配额不足是外部条件：run 暂停而不是作废，实验分支没有开局，在线名额保持原样。
    await vi.waitFor(() => expect(experimentAudit(host, branchId).at(-1)?.type).toBe("ExperimentRunStopped"), { timeout: 30_000, interval: 20 });
    expect(runRow(host, runId)["status"]).toBe("paused");
    expect(experimentAudit(host, branchId).at(-1)?.payload).toMatchObject({ status: "paused", reason: "quota-unavailable" });
    expect(eventTypes(host, branchId)).toEqual([]);
    expect(activeAgentsOn(host, branchId)).toEqual([]);
    expect(activeIdentityCount(host)).toBe(15);

    // 运营让出在线名额后，研究员继续同一个 run：开局用新的命令 ID，不重放上一次的拒绝回执。
    host.storage.transact((tx) => {
      const activations = tx.branch(host.branchId).table("agent_activations");
      for (const agentId of ["human-independent", "human-earth-alliance", "human-alien-accord"]) {
        const row = activations.get({ agent_id: agentId });
        if (row === null) throw new Error(`在线名册缺少 ${agentId}`);
        activations.put({ ...row, status: "dormant" });
      }
    });
    await startRun(host, headers, runId, "op-000000000502");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    expect(probeResults(host, runId)).toHaveLength(1);
    expect(activeIdentityCount(host)).toBe(12);
  }, 120_000);

  it("探针 turn 失败时写入 turn-failed 无效样本，报告不把它计入正确率分母", async () => {
    const host = await experimentHost(resources, {
      configRoot: fixtureConfig([{
        id: "probe-decision-rejected",
        match: { purpose: "decision", inputIncludes: ["做到了吗"] },
        response: { error: { kind: "bad-request" } },
      }]),
    });
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({
      experimentId: "exp-runner-turn-failure-v1", commonPatchRefs: [], variants: ["memory-m0-window"],
    }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    await startRun(host, headers, runId, "op-000000000601");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    const [probe] = probeResults(host, runId);
    expect(probe).toMatchObject({ probe_id: "p-recall-promise", valid: 0, invalid_reason: "turn-failed", answer_text: null });
    const completed = experimentAudit(host, branchOf(host, runId)).find(({ type }) => type === "ExperimentProbeCompleted")?.payload;
    expect(completed).toMatchObject({ turnStatus: "failed", valid: false, invalidReason: "turn-failed" });
    const report = runReportResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers,
    })).json());
    expect(report.invalidProbeCounts["turn-failed"]).toBe(1);
    expect(report.metrics.find(({ metric }) => metric === "recall-accuracy")).toMatchObject({ denominator: null, value: null });
    expect(report.validity).toMatchObject({ valid: false, invalidReasons: ["all-probes-invalid"] });
  }, 120_000);

  it("实验分支上的 turn 失败时 run 照常完成，但报告与汇总把它记为无效样本", async () => {
    const host = await experimentHost(resources, {
      configRoot: fixtureConfig([
        // 探针在前：它的输入里也有第 60 tick 的请求，必须先按探针问题匹配，让探针本身有效。
        {
          id: "probe-answers",
          match: { purpose: "decision", inputIncludes: ["做到了吗"] },
          response: { finishReason: "tool_calls", toolCalls: [{ name: "decision_submit", arguments: {
            stance: "none",
            dialogueIntent: { kind: "acknowledge", audience: ["player-1"], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
            noteworthy: [], citedMemoryIds: [], decisionNote: "",
          } }] },
        },
        {
          id: "escort-plea-rejected",
          match: { purpose: "decision", inputIncludes: ["护送隘口"] },
          response: { error: { kind: "bad-request" } },
        },
      ]),
    });
    const headers = await researcherHeaders(host);
    const experimentId = "exp-runner-agent-turn-failure-v1";
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({
      experimentId, commonPatchRefs: [], variants: ["memory-m0-window"],
    }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const branchId = branchOf(host, runId);
    await startRun(host, headers, runId, "op-000000000651");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    // 只有第 60 tick 的请求触发的 turn 失败：触发已被消费，该输入没有得到决策。
    const failedTurns = host.storage.transact((tx) => tx.all(
      "SELECT agent_id, created_tick FROM turn_runs WHERE branch_id = ? AND status IN ('failed', 'budget-exhausted')",
      [branchId],
    ));
    expect(failedTurns).toEqual([{ agent_id: "human-independent", created_tick: 60 }]);
    expect(probeResults(host, runId)[0]).toMatchObject({ valid: 1, invalid_reason: null });

    const report = runReportResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers,
    })).json());
    expect(report.validity).toMatchObject({ valid: false, evidenceComplete: true, invalidReasons: ["agent-turn-failed"] });
    expect(report.metrics.find(({ metric }) => metric === "recall-accuracy")?.denominator).toBe(1);
    const results = host.storage.transact((tx) => tx.rows("experiment_results").list({ run_id: runId }));
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(row["details_json"]).toMatchObject({ validity: { valid: false, invalidReasons: ["agent-turn-failed"] } });
    }
    expect(experimentAudit(host, branchId).at(-1)).toMatchObject({ type: "ExperimentRunCompleted", payload: { valid: false } });
    // 失败保留在总样本中：汇总把这个 run 的指标计为无效样本，而不是有效样本或无机会。
    const detail = experimentDetailResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/experiments/${experimentId}`, headers,
    })).json());
    expect(detail.cells[0]?.metrics.find(({ metric }) => metric === "recall-accuracy"))
      .toMatchObject({ validSamples: 0, invalidSamples: 1 });
  }, 120_000);

  it("运行中停止会暂停时钟并释放名册，恢复后从当前 tick 继续且不重复注入脚本命令", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({ experimentId: "exp-runner-stop-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const branchId = branchOf(host, runId);
    await startRun(host, headers, runId, "op-000000000701");
    await vi.waitFor(() => expect(worldTickOf(host, branchId)).toBeGreaterThanOrEqual(3), { timeout: 30_000, interval: 5 });
    await stopRun(host, headers, runId, "op-000000000702");
    // 执行器在下一次收敛检查或注入前停下，收尾完成后写入 ExperimentRunStopped。
    await vi.waitFor(() => expect(experimentAudit(host, branchId).at(-1)?.type).toBe("ExperimentRunStopped"), { timeout: 30_000, interval: 20 });
    expect(runRow(host, runId)["status"]).toBe("paused");
    const stoppedTick = worldTickOf(host, branchId);
    expect(stoppedTick).toBeLessThan(62);
    expect(host.storage.transact((tx) => tx.branch(branchId).table("clock").get({})?.["mode"])).toBe("paused");
    expect(activeAgentsOn(host, branchId)).toEqual([]);
    expect(host.storage.transact((tx) => tx.all(
      "SELECT 1 FROM turn_runs WHERE branch_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'budget-exhausted')",
      [branchId],
    ))).toHaveLength(0);

    await startRun(host, headers, runId, "op-000000000703");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    expect(worldTickOf(host, branchId)).toBe(62);
    const injected = experimentAudit(host, branchId).filter(({ type }) => type === "ExperimentStepSubmitted")
      .map(({ payload }) => (payload as Record<string, Json>)["declarationIndex"]);
    expect([...injected].sort()).toEqual([0, 1, 2, 3]);
    // 每条脚本命令在实验分支上只有一张玩家回执（加开局一共 5 张）。
    expect(host.storage.transact((tx) => tx.branch(branchId).table("command_receipts").list({ principal_id: "player-1" }))).toHaveLength(5);
    expect(probeResults(host, runId)).toHaveLength(1);
  }, 120_000);

  it("探针进行中停止后立即再次启动：旧执行被取代且不写终态，新执行接手完成", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({ experimentId: "exp-runner-restart-race-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const branchId = branchOf(host, runId);
    await startRun(host, headers, runId, "op-000000000711");
    // 旧执行停在探针沙盒里等待时，同一同步段内落下停止与再次启动：它在两次控制之间没有机会读到 paused，
    // 恢复后看到的 run 仍是 running，只有时钟版本不同。
    await vi.waitFor(() => {
      expect(sandboxesOf(host, branchId).some((row) => row["status"] === "active")).toBe(true);
      stopAndRestartAtOnce(host, runId, branchId);
    }, { timeout: 60_000, interval: 1 });

    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    const audit = experimentAudit(host, branchId);
    expect(audit.map(({ type }) => type)).not.toContain("ExperimentRunFailed");
    expect(audit.filter(({ type }) => type === "ExperimentRunStarted")).toHaveLength(2);
    // 旧执行只记一条被取代的审计，不改 run 状态、名册与时钟。
    expect(audit.filter(({ type }) => type === "ExperimentRunStopped").map(({ payload }) => payload))
      .toEqual([expect.objectContaining({ status: "running", reason: "superseded" })]);
    expect(audit.at(-1)?.type).toBe("ExperimentRunCompleted");
    expect(worldTickOf(host, branchId)).toBe(62);
    expect(probeResults(host, runId)).toHaveLength(1);
    expect(sandboxesOf(host, branchId).every((row) => row["status"] === "archived")).toBe(true);
    expect(activeIdentityCount(host)).toBe(0);
  }, 120_000);

  it("收敛超时、不支持的脚本与宿主装配不一致都显式失败", async () => {
    const strict = await experimentHost(resources, { experimentSettleTimeoutMs: 0 });
    const strictHeaders = await researcherHeaders(strict);
    const [timedOut] = await createExperimentRuns(strict, strictHeaders, experimentSpec({ experimentId: "exp-runner-timeout-v1" }));
    if (timedOut === undefined) throw new Error("实验没有展开出 run");
    await startRun(strict, strictHeaders, timedOut, "op-000000000801");
    expect(await waitForRunStatus(strict, timedOut, ["completed", "failed"])).toBe("failed");
    expect(failureCode(strict, timedOut)).toBe("settle-timeout");
    expect(activeAgentsOn(strict, branchOf(strict, timedOut))).toEqual([]);

    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const [rumor] = await createExperimentRuns(host, headers, experimentSpec({
      experimentId: "exp-runner-setup-v1", scriptRef: "s-rumor", scriptBranches: [],
    }));
    const escalating = experimentSpec({ experimentId: "exp-runner-assembly-v1" });
    const [mismatched] = await createExperimentRuns(host, headers, {
      ...escalating, base: { ...(escalating["base"] as Record<string, Json>), moduleAssemblyRef: "local-slg-escalating-v1" },
    });
    if (rumor === undefined || mismatched === undefined) throw new Error("实验没有展开出 run");
    await startRun(host, headers, rumor, "op-000000000802");
    await startRun(host, headers, mismatched, "op-000000000803");
    expect(await waitForRunStatus(host, rumor, ["completed", "failed"])).toBe("failed");
    expect(await waitForRunStatus(host, mismatched, ["completed", "failed"])).toBe("failed");
    expect(failureCode(host, rumor)).toBe("script-setup-unsupported");
    expect(failureCode(host, mismatched)).toBe("assembly-mismatch");
    // 预检阶段失败时实验分支没有开局：没有任何领域事件。
    expect(eventTypes(host, branchOf(host, rumor))).toEqual([]);
  }, 120_000);

  it("宿主重启把遗留的 running 实验 run 归位为 paused 并归档未关闭的沙盒", async () => {
    const dataDir = tempRoot(resources, "world-prism-experiment-restart-");
    const first = await experimentHost(resources, { dataDir });
    const headers = await researcherHeaders(first);
    const [runId] = await createExperimentRuns(first, headers, experimentSpec({ experimentId: "exp-runner-restart-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const branchId = branchOf(first, runId);
    const sandboxId = "br-00000000sbx0";
    // 模拟进程在执行中被杀：run 停在 running、分支留着一个活动沙盒，执行器没有机会收尾。
    // 直接改写存储不会唤醒执行器，关闭时它没有在执行的 run，数据库保持中断时的样子。
    first.storage.transact((tx) => {
      const run = tx.rows("runs").get({ run_id: runId });
      if (run === null) throw new Error("run 不存在");
      const now = new Date().toISOString();
      tx.rows("runs").put({ ...run, status: "running", started_at: now });
      tx.rows("branches").put({
        branch_id: sandboxId, world_id: first.worldId, kind: "sandbox", status: "active",
        parent_branch_id: branchId, forked_at_world_seq: 0, run_id: null, profile_hash: null, created_at: now,
      });
      tx.branch(sandboxId).table("agent_activations").put({ agent_id: "human-independent", status: "active", updated_at: now });
    });
    expect(activeIdentityCount(first)).toBe(1);
    resources.hosts.splice(resources.hosts.indexOf(first), 1);
    await first.close();

    const second = await experimentHost(resources, { dataDir });
    expect(runRow(second, runId)["status"]).toBe("paused");
    expect(second.storage.transact((tx) => tx.rows("branches").get({ branch_id: sandboxId })?.["status"])).toBe("archived");
    expect(activeIdentityCount(second)).toBe(0);
    expect(experimentAudit(second, branchId).map(({ type }) => type)).toEqual(["ExperimentRunInterrupted"]);

    // 研究员显式继续后执行器从头驱动到终点。
    const secondHeaders = await researcherHeaders(second);
    await startRun(second, secondHeaders, runId, "op-000000000901");
    expect(await waitForRunStatus(second, runId, ["completed", "failed"], 120_000)).toBe("completed");
    expect(probeResults(second, runId)).toHaveLength(1);
  }, 120_000);

  it("停止已置为 paused 但进程在收尾前退出时，重启释放遗留的沙盒与名册激活，且重复启动不再写入", async () => {
    const dataDir = tempRoot(resources, "world-prism-experiment-stop-crash-");
    const first = await experimentHost(resources, { dataDir });
    const headers = await researcherHeaders(first);
    const [runId] = await createExperimentRuns(first, headers, experimentSpec({ experimentId: "exp-runner-stop-crash-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const branchId = branchOf(first, runId);
    await startRun(first, headers, runId, "op-000000000951");
    await vi.waitFor(() => expect(worldTickOf(first, branchId)).toBeGreaterThanOrEqual(3), { timeout: 30_000, interval: 5 });
    await stopRun(first, headers, runId, "op-000000000952");
    await vi.waitFor(() => expect(experimentAudit(first, branchId).at(-1)?.type).toBe("ExperimentRunStopped"), { timeout: 30_000, interval: 20 });
    // 还原成停止接口已提交、执行器尚未收尾的样子：run 与时钟已暂停，但名册仍激活、探针沙盒仍 active。
    const sandboxId = "br-00000000sbx1";
    first.storage.transact((tx) => {
      const now = new Date().toISOString();
      const activations = tx.branch(branchId).table("agent_activations");
      for (const row of activations.list()) activations.put({ ...row, status: "active", updated_at: now });
      tx.rows("branches").put({
        branch_id: sandboxId, world_id: first.worldId, kind: "sandbox", status: "active",
        parent_branch_id: branchId, forked_at_world_seq: 0, run_id: null, profile_hash: null, created_at: now,
      });
      tx.branch(sandboxId).table("agent_activations").put({ agent_id: "human-independent", status: "active", updated_at: now });
    });
    expect(runRow(first, runId)["status"]).toBe("paused");
    expect(activeIdentityCount(first)).toBe(4);
    const auditBefore = experimentAudit(first, branchId).length;
    resources.hosts.splice(resources.hosts.indexOf(first), 1);
    await first.close();

    const second = await experimentHost(resources, { dataDir });
    expect(runRow(second, runId)["status"]).toBe("paused");
    expect(second.storage.transact((tx) => tx.rows("branches").get({ branch_id: sandboxId })?.["status"])).toBe("archived");
    expect(activeAgentsOn(second, branchId)).toEqual([]);
    expect(activeIdentityCount(second)).toBe(0);
    const recovered = experimentAudit(second, branchId).slice(auditBefore);
    expect(recovered).toEqual([{
      type: "ExperimentRunInterrupted",
      payload: { status: "paused", reason: "interrupted", releasedSandboxes: 1, releasedActivations: 4 },
    }]);
    resources.hosts.splice(resources.hosts.indexOf(second), 1);
    await second.close();

    // 再次启动没有遗留可释放：不重复写审计。研究员继续后照常执行到完成。
    const third = await experimentHost(resources, { dataDir });
    expect(experimentAudit(third, branchId)).toHaveLength(auditBefore + 1);
    const thirdHeaders = await researcherHeaders(third);
    await startRun(third, thirdHeaders, runId, "op-000000000953");
    expect(await waitForRunStatus(third, runId, ["completed", "failed"], 120_000)).toBe("completed");
    expect(activeIdentityCount(third)).toBe(0);
  }, 120_000);
});
