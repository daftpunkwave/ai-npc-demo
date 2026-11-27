/**
 * 核心职责：验证实验执行器提交脚本预置知识、按检查点驱动受控时钟、在沙盒分支执行探针、写入 probe_results 与 experiment_results，
 * 实验分支之间与在线分支之间互不读写，并经进度与导出接口如实对外呈现。
 * 交互契约：使用真实测试装配、SQLite 与控制台接口，决策走确定性模块，不调用模型。
 * 约束与禁忌：断言必须读执行器写入的真实存储行或公开接口；禁止替换执行器内部实现。
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemAuth } from "@world-prism/authority";
import { runProgressResponseSchema, runReportResponseSchema, exportResponseSchema, type Json } from "@world-prism/contracts";
import { artifactBodyText } from "@world-prism/module-sdk";
import type { RunningHost } from "@world-prism/app-server";
import {
  activeAgentsOn,
  branchOf,
  createExperimentRuns,
  eventTypes,
  experimentAudit,
  experimentHost,
  experimentResults,
  experimentSpec,
  probeResults,
  researcherHeaders,
  runRow,
  sandboxesOf,
  startRun,
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

/** 分支内全部行数的快照：在线分支在实验前后必须逐项不变。 */
function branchFootprint(host: RunningHost, branchId: string): Readonly<Record<string, number>> {
  return host.storage.transact((tx) => {
    const branch = tx.branch(branchId);
    return Object.fromEntries(["domain_events", "aggregate_state", "jobs", "observations", "memory_records", "triggers",
      "agent_activations", "command_receipts"].map((table) => [table, branch.table(table).count()]));
  });
}

async function report(host: RunningHost, headers: Record<string, string>, runId: string) {
  const response = await host.app.inject({ method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers });
  expect(response.statusCode, response.body).toBe(200);
  return runReportResponseSchema.parse(response.json());
}

function runVariant(host: RunningHost, runId: string): { readonly variant: string; readonly branch: string } {
  const spec = runRow(host, runId)["run_spec_json"] as { readonly variant: { readonly id: string }; readonly script: { readonly branch: string } };
  return { variant: spec.variant.id, branch: spec.script.branch };
}

describe("实验执行器", () => {
  it("按检查点推进受控时钟，探针结果与汇总写入存储，行为差异符合确定性决策规则", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const runIds = await createExperimentRuns(host, headers, experimentSpec({
      experimentId: "exp-runner-promise-v1", scriptBranches: ["keep", "break"],
      variants: ["memory-m0-window", "memory-m1-structured-ledger"],
    }));
    expect(runIds).toHaveLength(4);
    // 创建时冻结 Agent profile 与模型路由：执行器据此复算并核对，报告据此说明实际输入。
    const manifest = runRow(host, runIds[0] as string)["manifest_json"] as { readonly agentProfiles: readonly Json[]; readonly models: { readonly layoutId: string } };
    expect(manifest.agentProfiles).toHaveLength(3);
    expect(manifest.models.layoutId).toBe("deterministic-model-layout-v1");

    for (const [index, runId] of runIds.entries()) await startRun(host, headers, runId, `op-00000000010${index}`);
    for (const runId of runIds) expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");

    const stanceAt60 = new Map<string, string>();
    for (const runId of runIds) {
      const branchId = branchOf(host, runId);
      const { variant, branch } = runVariant(host, runId);
      // 时钟停在脚本终点并暂停；名册在完成后休眠，不再占用部署级配额。
      expect(worldTickOf(host, branchId)).toBe(62);
      expect(host.storage.transact((tx) => tx.branch(branchId).table("clock").get({})?.["mode"])).toBe("paused");
      expect(activeAgentsOn(host, branchId)).toEqual([]);
      expect(runRow(host, runId)["ended_at"]).toEqual(expect.any(String));

      const audit = experimentAudit(host, branchId);
      const steps = audit.filter(({ type }) => type === "ExperimentStepSubmitted").map(({ payload }) => payload as Record<string, Json>);
      expect(steps.map((step) => [step["atTick"], step["commandType"], step["commandStatus"]])).toEqual(branch === "keep"
        ? [[1, "dialogue.say", "accepted"], [2, "agreement.propose", "accepted"], [6, "task.dispatch", "accepted"], [60, "dialogue.say", "accepted"]]
        : [[1, "dialogue.say", "accepted"], [2, "agreement.propose", "accepted"], [60, "dialogue.say", "accepted"]]);
      expect(audit.at(-1)?.type).toBe("ExperimentRunCompleted");

      const parsed = await report(host, headers, runId);
      const plea = parsed.behavior.find((entry) => entry.atTick === 60 && entry.trigger === "player-dialogue");
      stanceAt60.set(`${variant}/${branch}`, `${plea?.stance}/${plea?.reasonCode}`);

      // probe_results：对白原文、decision JSON、引用的记忆 ID 与有效性都在一行里。
      const [probe, ...extra] = probeResults(host, runId);
      expect(extra).toHaveLength(0);
      expect(probe).toMatchObject({
        script_id: "s-promise", probe_id: "p-recall-promise", agent_id: "human-independent",
        asked_at_tick: 62, valid: 1, invalid_reason: null,
      });
      expect(probe?.["answer_text"]).toBe(parsed.probes[0]?.answer);
      expect(String(probe?.["answer_text"]).length).toBeGreaterThan(0);
      const decision = probe?.["decision_json"] as { readonly stance: string; readonly citedMemoryIds: readonly string[]; readonly dialogueIntent: { readonly kind: string; readonly factRefs: readonly string[]; readonly audience: readonly string[] } };
      expect(decision.stance).toBe("inform");
      expect(decision.dialogueIntent).toMatchObject({ kind: "answer", audience: ["player-1"] });
      expect(decision.citedMemoryIds).toEqual(decision.dialogueIntent.factRefs);
      const memoryIds = new Set(host.storage.transact((tx) => tx.branch(branchId).table("memory_records")
        .list({ agent_id: "human-independent" }).map((row) => String(row["memory_id"]))));
      if (variant === "memory-m0-window") expect(decision.citedMemoryIds).toEqual([]);
      else {
        expect(decision.citedMemoryIds).toHaveLength(2);
        for (const memoryId of decision.citedMemoryIds) expect(memoryIds.has(memoryId)).toBe(true);
      }

      // 每个探针一个沙盒：完成后归档，被问 Agent 的激活随之休眠；提问只出现在沙盒，不进入实验分支。
      const sandboxes = sandboxesOf(host, branchId);
      expect(sandboxes.map((row) => [row["status"], row["run_id"]])).toEqual([["archived", null]]);
      const sandboxId = String(sandboxes[0]?.["branch_id"]);
      expect(eventTypes(host, sandboxId)).toContain("ProbeAsked");
      expect(eventTypes(host, branchId)).not.toContain("ProbeAsked");
      expect(activeAgentsOn(host, sandboxId)).toEqual([]);
      const completed = audit.find(({ type }) => type === "ExperimentProbeCompleted")?.payload as Record<string, Json>;
      expect(completed).toMatchObject({
        probeId: "p-recall-promise", sandboxBranchId: sandboxId, turnStatus: "completed",
        probeResultId: probe?.["probe_result_id"], valid: true, invalidReason: null,
      });
      expect(host.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: String(completed["turnId"]) })?.["branch_id"])).toBe(sandboxId);

      // experiment_results 与报告同一口径：每项指标的分子分母逐项一致。
      expect(experimentResults(host, runId).map((row) => [row["metric"], row["numerator"], row["denominator"], row["value"]]))
        .toEqual([...parsed.metrics].sort((left, right) => left.metric.localeCompare(right.metric))
          .map((metric) => [metric.metric, metric.numerator, metric.denominator, metric.value]));
      expect(experimentResults(host, runId)[0]?.["details_json"]).toMatchObject({
        variant, scriptId: "s-promise", scriptBranch: branch, validity: { valid: true },
      });
    }
    // 违约分支里只有带关系账本的 M1 拒绝护送并给出 past-breach；M0 与守约分支都接受。
    expect(Object.fromEntries(stanceAt60)).toEqual({
      "memory-m0-window/keep": "accept/none",
      "memory-m1-structured-ledger/keep": "accept/none",
      "memory-m0-window/break": "accept/none",
      "memory-m1-structured-ledger/break": "decline/past-breach",
    });
  }, 180_000);

  it("含预置知识的 s-rumor 在开局后、首个 tick 前完成预置，跑完全部检查点；预置重放取回原回执", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({
      experimentId: "exp-runner-rumor-v1", scriptRef: "s-rumor", scriptBranches: [],
    }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    await startRun(host, headers, runId, "op-000000000121");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");
    const branchId = branchOf(host, runId);
    expect(worldTickOf(host, branchId)).toBe(70);

    // 预置只产生一条 setup 途径的授权，且发生在开局之后的 tick 0、任何脚本步骤之前。
    const events = host.storage.transact((tx) => tx.all(
      "SELECT type, world_tick, payload_json FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC", [branchId],
    ).map((row) => ({ type: String(row["type"]), worldTick: Number(row["world_tick"]), payload: JSON.parse(String(row["payload_json"])) as Record<string, Json> })));
    const setupGrants = events.filter(({ type, payload }) => type === "KnowledgeGranted" && payload["via"] === "setup");
    expect(setupGrants.map(({ worldTick, payload }) => [worldTick, payload["principalId"], payload["itemId"]])).toEqual([[0, "player-1", "ev-flood-log"]]);
    expect(events.findIndex(({ type }) => type === "CampaignStarted")).toBeLessThan(events.indexOf(setupGrants[0] as (typeof events)[number]));
    // 预置让玩家持有证据，tick 66 的分享才被受理（未持有时规则以 evidence-not-held 拒绝）。
    const steps = experimentAudit(host, branchId).filter(({ type }) => type === "ExperimentStepSubmitted").map(({ payload }) => payload as Record<string, Json>);
    expect(steps.map((step) => [step["atTick"], step["commandType"], step["commandStatus"]])).toEqual([[66, "information.share", "accepted"]]);

    // 两个检查点各一条有效探针结果，汇总与报告同一口径。
    expect(probeResults(host, runId).map((row) => [row["probe_id"], row["agent_id"], row["asked_at_tick"], row["valid"]])).toEqual([
      ["p-belief-before", "human-earth-alliance", 56, 1],
      ["p-belief-after", "human-earth-alliance", 70, 1],
    ]);
    const parsed = await report(host, headers, runId);
    expect(parsed.probes.map(({ probeId }) => probeId).sort()).toEqual(["p-belief-after", "p-belief-before"]);
    expect(experimentResults(host, runId).length).toBeGreaterThan(0);

    // 预置是实验分支上唯一的系统世界命令。停止后恢复会以同一命令 ID 重放：即使时钟已越过 tick 0，
    // 也取回原受理回执且不再授权；换命令 ID 的新预置被拒绝（完成后时钟已暂停，tick 推进后的拒绝由网关测试覆盖）。
    const receipts = host.storage.transact((tx) => tx.branch(branchId).table("command_receipts").list({ principal_id: "system:world" }))
      .map((row) => ({ commandId: String(row["command_id"]), type: row["command_type"], receipt: row["receipt_json"] as { readonly receiptId: string; readonly commandStatus: string } }));
    expect(receipts.map(({ type, receipt }) => [type, receipt.commandStatus])).toEqual([["knowledge.seed", "accepted"]]);
    const system = createSystemAuth(host.worldId, branchId);
    const payload = { evidenceId: "ev-flood-log", principalId: "player-1" };
    const eventCount = (): number => host.storage.transact((tx) => tx.branch(branchId).table("domain_events").count());
    const eventsBefore = eventCount();
    const replay = host.authority.commands.execute(system, { commandId: receipts[0]?.commandId ?? "", type: "knowledge.seed", schemaVersion: 1, payload });
    expect(replay).toMatchObject({ commandStatus: "accepted", receiptId: receipts[0]?.receipt.receiptId });
    const late = host.authority.commands.execute(system, { commandId: "cmd-000000000999", type: "knowledge.seed", schemaVersion: 1, payload });
    expect(late).toMatchObject({ commandStatus: "rejected", reasonCode: "paused" });
    expect(eventCount()).toBe(eventsBefore);
  }, 180_000);

  it("实验执行不改写在线分支，实验分支之间互不串读", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const before = branchFootprint(host, host.branchId);
    const onlineClock = host.storage.transact((tx) => tx.branch(host.branchId).table("clock").get({}));
    const [keepRun, breakRun] = await createExperimentRuns(host, headers, experimentSpec({
      experimentId: "exp-runner-isolation-v1", scriptBranches: ["keep", "break"],
    }));
    if (keepRun === undefined || breakRun === undefined) throw new Error("实验应展开出两个 run");
    await startRun(host, headers, keepRun, "op-000000000201");
    await startRun(host, headers, breakRun, "op-000000000202");
    for (const runId of [keepRun, breakRun]) expect(await waitForRunStatus(host, runId, ["completed", "failed"], 120_000)).toBe("completed");

    expect(branchFootprint(host, host.branchId)).toEqual(before);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("clock").get({}))).toEqual(onlineClock);
    expect(host.storage.transact((tx) => tx.rows("turn_runs").list({ branch_id: host.branchId }))).toHaveLength(0);

    // 守约分支的派遣只发生在自己的分支；违约分支没有运输任务。
    const keepBranch = branchOf(host, keepRun);
    const breakBranch = branchOf(host, breakRun);
    expect(eventTypes(host, keepBranch)).toContain("TaskDispatched");
    expect(eventTypes(host, breakBranch)).not.toContain("TaskDispatched");
    expect(eventTypes(host, breakBranch)).toContain("AgreementBreached");
    expect(eventTypes(host, keepBranch)).not.toContain("AgreementBreached");
    // 每个 run 的 turn 只落在自己的实验分支与沙盒上。
    for (const [runId, branchId] of [[keepRun, keepBranch], [breakRun, breakBranch]] as const) {
      const allowed = new Set([branchId, ...sandboxesOf(host, branchId).map((row) => String(row["branch_id"]))]);
      const branches = host.storage.transact((tx) => tx.rows("turn_runs").list({ run_id: runId }).map((row) => String(row["branch_id"])));
      expect(branches.length).toBeGreaterThan(0);
      for (const turnBranch of branches) expect(allowed.has(turnBranch)).toBe(true);
    }
  }, 180_000);

  it("进度接口给出当前 tick、脚本终点与探针计数，评估员可读、玩家不可读", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({ experimentId: "exp-runner-progress-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    const ready = runProgressResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/progress`, headers,
    })).json());
    expect(ready).toMatchObject({ status: "ready", worldTick: null, endTick: 62, probes: { recorded: 0, total: 1 }, executing: false, lastEvent: null });

    await startRun(host, headers, runId, "op-000000000301");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"])).toBe("completed");
    const evaluatorHeaders = { ...headers, "X-Active-Role": "evaluator" };
    const done = runProgressResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/progress`, headers: evaluatorHeaders,
    })).json());
    expect(done).toMatchObject({
      status: "completed", branchId: branchOf(host, runId), worldTick: 62, endTick: 62,
      probes: { recorded: 1, total: 1 }, executing: false, lastEvent: { type: "ExperimentRunCompleted" },
    });
    const missing = await host.app.inject({ method: "GET", url: "/api/v1/console/runs/run-aaaaaaaaaaaa/progress", headers });
    expect(missing.statusCode).toBe(404);
    const playerLogin = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "experiment-player" } });
    const playerSession = (playerLogin.json() as { readonly sessionToken: string }).sessionToken;
    const forbidden = await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/progress`, headers: { Authorization: `Bearer ${playerSession}` },
    });
    expect(forbidden.statusCode).toBe(403);
  }, 120_000);

  it("导出包按同一脱敏口径带出探针结果与实验汇总", async () => {
    const host = await experimentHost(resources);
    const headers = await researcherHeaders(host);
    const [runId] = await createExperimentRuns(host, headers, experimentSpec({ experimentId: "exp-runner-export-v1" }));
    if (runId === undefined) throw new Error("实验没有展开出 run");
    await startRun(host, headers, runId, "op-000000000311");
    expect(await waitForRunStatus(host, runId, ["completed", "failed"])).toBe("completed");

    const answer = String(probeResults(host, runId)[0]?.["answer_text"]);
    const exported = async (redaction: "redacted" | "raw") => {
      const { artifactId } = exportResponseSchema.parse((await host.app.inject({
        method: "POST", url: "/api/v1/console/exports", headers, payload: { runId, redaction },
      })).json());
      const row = host.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
      if (row === null) throw new Error("导出 artifact 不存在");
      return JSON.parse(artifactBodyText(host.storage, row)) as {
        readonly probeResults: readonly Record<string, Json>[];
        readonly experimentResults: readonly Record<string, Json>[];
      };
    };
    const raw = await exported("raw");
    const redacted = await exported("redacted");
    expect(raw.probeResults.map((row) => row["answer_text"])).toEqual([answer]);
    expect(redacted.probeResults.map((row) => [row["probe_id"], row["answer_text"]])).toEqual([["p-recall-promise", null]]);
    expect((redacted.probeResults[0]?.["decision_json"] as Record<string, Json>)["decisionNote"]).toBeNull();
    expect(redacted.experimentResults.map((row) => row["metric"])).toEqual(experimentResults(host, runId).map((row) => row["metric"]));
  }, 120_000);
});
