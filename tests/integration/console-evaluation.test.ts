/**
 * 核心职责：验证评估读取接口的角色边界、run 报告口径与实验汇总读取。
 * 交互契约：使用真实测试装配、SQLite 与控制台会话；不调用模型、不创建实验。
 * 约束与禁忌：禁止用页面隐藏代替接口 403；禁止在测试里改写计分逻辑，断言必须走真实端口。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "@world-prism/app-server";
import {
  errorResponseSchema,
  experimentDetailResponseSchema,
  runDetailResponseSchema,
  runReportResponseSchema,
  runsResponseSchema,
  runCreateResponseSchema,
  exportResponseSchema,
  experimentCreateResponseSchema,
  runControlResponseSchema,
} from "@world-prism/contracts";

const hosts: RunningHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function testHost(): Promise<RunningHost> {
  const root = mkdtempSync(join(tmpdir(), "world-prism-console-evaluation-"));
  roots.push(root);
  const host = await startHost({
    dataDir: root,
    playerToken: "evaluation-player",
    consoleToken: "evaluation-console",
    assemblyRef: "local-slg-test-v1",
    rosterRef: "core-3",
  });
  hosts.push(host);
  return host;
}

async function login(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

function consoleHeader(token: string, role = "researcher") {
  return { Authorization: `Bearer ${token}`, "X-Active-Role": role };
}

/** 把在线分支的时钟直接推到指定 tick；用于确定性地构造恢复前的前置状态。 */
function advanceOnlineClock(host: RunningHost, worldTick: number): void {
  host.storage.transact((tx) => {
    const table = tx.branch(host.branchId).table("clock");
    const row = table.get({});
    if (row === null) throw new Error("在线分支缺少时钟行");
    table.put({
      ...row,
      world_tick: worldTick,
      mode: "paused",
      step_target_tick: null,
      run_version: Number(row["run_version"]) + 1,
      updated_at: new Date().toISOString(),
    });
  });
}

/** 从世界视图响应里取世界时钟 tick；字段缺失即视为测试失败而不是静默通过。 */
function worldTickOf(body: unknown): number {
  const clock = (body as { readonly projection?: { readonly clock?: { readonly worldTick?: unknown } } })
    .projection?.clock?.worldTick;
  if (typeof clock !== "number") throw new Error("世界视图缺少 projection.clock.worldTick");
  return clock;
}

/** 构造测试装配下的 RunSpec；各用例只覆盖自己关心的字段，避免整段字面量重复。 */
function testRunSpec(overrides: {
  readonly id: string;
  readonly seed?: string;
  readonly mode?: string;
  readonly scenarioRef?: string;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: overrides.id,
    moduleAssemblyRef: "local-slg-test-v1",
    worldPackRef: "earth-2964-v1",
    scenarioRef: overrides.scenarioRef ?? "watergate-v1",
    rosterRef: "core-3",
    modelLayoutRef: "deterministic-model-layout-v1",
    seed: overrides.seed ?? `${overrides.id}:rep1`,
    player: { principalId: "player-1", factionId: null },
    mode: overrides.mode ?? "closed-loop",
    initialState: { kind: "cold-start" },
    variant: null,
    script: null,
    clock: { kind: "controlled" },
    budget: { maxTokens: null, maxCost: null },
    failurePolicy: "strict",
  };
}

/** 构造测试装配下的实验规格；变体与分支由各用例指定。 */
function testExperimentSpec(overrides: {
  readonly experimentId: string;
  readonly variants: readonly string[];
  readonly scriptBranches?: readonly string[];
  readonly repetitions?: number;
  readonly scriptRef?: string;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    experimentId: overrides.experimentId,
    base: {
      moduleAssemblyRef: "local-slg-test-v1",
      worldPackRef: "earth-2964-v1",
      scenarioRef: "watergate-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
      seed: overrides.experimentId,
      player: { principalId: "player-1", factionId: "human-neutral" },
      mode: "closed-loop",
      initialState: { kind: "cold-start" },
      clock: { kind: "controlled" },
      budget: { maxTokens: null, maxCost: null },
      failurePolicy: "strict",
    },
    scriptRef: overrides.scriptRef ?? "s-promise",
    scriptBranches: [...(overrides.scriptBranches ?? [])],
    commonPatchRefs: [],
    variants: [...overrides.variants],
    repetitions: overrides.repetitions ?? 1,
    runOrder: "sequential",
  };
}

/** 在线 run 的标识；测试装配启动时必然创建。 */
function onlineRunId(host: RunningHost): string {
  const run = host.storage.transact((tx) => tx.rows("runs").list({ branch_id: host.branchId })[0]);
  const runId = run?.["run_id"];
  if (typeof runId !== "string") throw new Error("测试装配应已创建在线 run");
  return runId;
}

describe("控制台评估读取接口", () => {
  it("研究员可以列出 run 并读取 run 详情", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));

    const list = await host.app.inject({ method: "GET", url: "/api/v1/console/runs", headers });
    expect(list.statusCode).toBe(200);
    const runs = runsResponseSchema.parse(list.json());
    const runId = onlineRunId(host);
    expect(runs.runs.map((run) => run.runId)).toContain(runId);

    const detail = await host.app.inject({ method: "GET", url: `/api/v1/console/runs/${runId}`, headers });
    expect(detail.statusCode).toBe(200);
    const parsed = runDetailResponseSchema.parse(detail.json());
    expect(parsed.runId).toBe(runId);
    // manifest 已去密钥，且摘要存在。
    expect(parsed.manifestHash.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsed.manifest)).not.toContain("apiKey");
  });

  it("run 报告带分子分母与探针列表，缺指标写 n/a", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const runId = onlineRunId(host);

    const response = await host.app.inject({ method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers });
    expect(response.statusCode).toBe(200);
    const report = runReportResponseSchema.parse(response.json());
    expect(report.runId).toBe(runId);
    // 没有探针时各指标都应标注 n/a，而不是伪造 0。
    expect(report.metrics.length).toBeGreaterThan(0);
    for (const metric of report.metrics) {
      expect(metric.value).toBeNull();
      expect(metric.reason).toBe("n/a");
    }
    expect(report.probes).toEqual([]);
  });

  it("未知 run 返回 not-found", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const response = await host.app.inject({ method: "GET", url: "/api/v1/console/runs/run-aaaaaaaaaaaa", headers });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe("not-found");
  });

  it("未知 run 的报告返回 not-found", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const response = await host.app.inject({
      method: "GET", url: "/api/v1/console/runs/run-aaaaaaaaaaaa/report", headers,
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe("not-found");
  });

  it("实验列表为空时返回空数组，未知实验返回 not-found", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));

    const list = await host.app.inject({ method: "GET", url: "/api/v1/console/experiments", headers });
    expect(list.statusCode).toBe(200);
    // 在线 run 没有实验关联字段，因此实验列表应为空——不从 seed 推断。
    expect((list.json() as { readonly experiments: readonly unknown[] }).experiments).toEqual([]);

    const missing = await host.app.inject({
      method: "GET", url: "/api/v1/console/experiments/exp-aaaaaaaaaaaa", headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("玩家会话访问评估接口返回 403", async () => {
    const host = await testHost();
    const playerToken = await login(host, "evaluation-player");
    for (const url of [
      "/api/v1/console/runs",
      `/api/v1/console/runs/${onlineRunId(host)}`,
      `/api/v1/console/runs/${onlineRunId(host)}/report`,
      "/api/v1/console/experiments",
    ]) {
      const response = await host.app.inject({ method: "GET", url, headers: { Authorization: `Bearer ${playerToken}` } });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it("评估员可读，操作员不可读", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "evaluation-console");

    const evaluator = await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers: consoleHeader(consoleToken, "evaluator"),
    });
    expect(evaluator.statusCode).toBe(200);

    const operator = await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers: consoleHeader(consoleToken, "operator"),
    });
    expect(operator.statusCode).toBe(403);
  });

  it("缺少 X-Active-Role 的控制台请求返回 403", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "evaluation-console");
    const response = await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers: { Authorization: `Bearer ${consoleToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("延迟由归档的 turn 时长计算，无样本时为 null", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const runId = onlineRunId(host);
    // 在线 run 没有已完成的 turn，因此延迟样本为空，报告必须写 null 而不是 0。
    const before = runReportResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers,
    })).json());
    expect(before.latency.turnP50Ms).toBeNull();
    expect(before.latency.turnP95Ms).toBeNull();

    // 登记三个已完成 turn，时长分别为 100/200/300ms，验证 p50 与 p95 真实取值。
    host.storage.transact((tx) => {
      const branchId = host.branchId;
      for (const [index, duration] of [100, 200, 300].entries()) {
        const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        const endedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index) + duration).toISOString();
        tx.rows("turn_runs").put({
          turn_id: `turn-aaaaaaaaaa${index}0`, run_id: runId, branch_id: branchId, agent_id: "human-independent",
          agent_turn_index: index + 1, status: "completed", trigger_ids_json: [], profile_hash: "hash",
          controller_epoch: 1, turn_lease_epoch: 0, created_at: startedAt, started_at: startedAt, ended_at: endedAt,
        });
      }
    });
    const after = runReportResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers,
    })).json());
    expect(after.latency.turnP50Ms).toBe(200);
    // p95 落在最大值上（3 个样本时 ceil(0.95*3)-1 = 2）。
    expect(after.latency.turnP95Ms).toBe(300);
  });

  it("报告从归档 decision、预算账本与活动记忆行读取行为、成本与记忆", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const runId = onlineRunId(host);
    const branchId = host.branchId;
    const now = new Date().toISOString();
    host.storage.transact((tx) => {
      tx.rows("artifacts").put({
        artifact_id: "art-reportdecision", run_id: runId, kind: "decision",
        content_hash: "sha256-reportdecision", mime: "application/json", byte_size: 64,
        storage: "inline",
        body: JSON.stringify({ turnId: "turn-report000001", decision: { stance: "decline", dialogueIntent: { reasonCode: "past-breach" } } }),
        file_path: null, redaction: "raw", redacted_from: null, created_at: now,
      });
      tx.rows("turn_runs").put({
        turn_id: "turn-report000001", run_id: runId, branch_id: branchId,
        agent_id: "human-independent", agent_turn_index: 1, status: "completed",
        trigger_ids_json: ["trg-report000001"], profile_hash: "hash",
        controller_epoch: 1, turn_lease_epoch: 0, created_tick: 5,
        effective_json: [
          {
            stage: "turn.decision", status: "applied", reason: null, requested: null, resolved: null,
            effective: { artifactId: "art-reportdecision" }, spanId: "spn-report000001",
          },
          {
            stage: "turn.tool", status: "applied", reason: null, requested: null, resolved: null,
            effective: { receiptId: "rcp-report000001" }, spanId: "spn-report000002",
          },
        ],
        created_at: now, started_at: now, ended_at: now,
      });
      tx.branch(branchId).table("triggers").put({
        trigger_id: "trg-report000001", agent_id: "human-independent", kind: "dialogue",
        priority: 100, source_ref: "evt-report000001", created_tick: 5,
        dedupe_key: "report-trigger", consumed_by_turn_id: "turn-report000001",
      });
      tx.branch(branchId).table("command_receipts").put({
        principal_id: "human-independent", command_id: "cmd-report000001",
        command_type: "task.cancel", payload_hash: "hash",
        receipt_json: { receiptId: "rcp-report000001" }, created_at: now,
      });
      tx.rows("budget_ledger").put({
        entry_id: "bgl-report000001", run_id: runId, agent_id: "human-independent",
        work_ref: "turn-report000001", purpose: "decision", model_id: "model-report",
        reserved_input: 200, reserved_output: 100, actual_input: 120, actual_output: 30,
        usage_unknown: 0, cost_estimate: 0.02, currency: "USD", created_at: now, settled_at: now,
      });
      const memoryBase = {
        agent_id: "human-independent", memory_id: "mem-report000001", module_id: "agent.memory.ledger",
        kind: "episodic", tier: "short", epistemic: "verified-event", release_policy_id: "policy-1",
        valid_from_tick: 0, valid_until_tick: null, strength: 1, salience: 0, recall_count: 0,
        tags_json: [], source_observation_ids_json: [], content_json: {},
      };
      tx.branch(branchId).table("memory_records").put({
        ...memoryBase, row_version: 1, status: "superseded", created_revision: 1,
        retired_revision: 2,
      });
      tx.branch(branchId).table("memory_records").put({
        ...memoryBase, row_version: 2, status: "active", created_revision: 2,
        retired_revision: null,
      });
    });

    const report = runReportResponseSchema.parse((await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers,
    })).json());
    expect(report.behavior).toEqual([{
      atTick: 5,
      agentId: "human-independent",
      trigger: "dialogue",
      stance: "decline",
      reasonCode: "past-breach",
      commands: ["task.cancel"],
    }]);
    expect(report.cost).toMatchObject({ inputTokens: 120, outputTokens: 30, costEstimate: 0.02, unknownUsageAttempts: 0 });
    expect(report.memory.recordsByTier["short"]).toBe(1);
  });

  it("缺脚本声明的探针计入证据不完整，非法 JSON 不使读取失败", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const runId = onlineRunId(host);
    host.storage.transact((tx) => {
      // 探针记录的 probeId 不在任何脚本声明里：无法计分，必须体现为证据不完整。
      tx.rows("probe_results").put({
        probe_result_id: "probe-res-aaaaaaaaaaaa", run_id: runId, script_id: "s-promise",
        probe_id: "undeclared-probe", agent_id: "human-independent", asked_at_tick: 0,
        answer_text: "不知道", decision_json: null, score_json: null, valid: 1, invalid_reason: null,
        created_at: new Date().toISOString(),
      });
    });

    const response = await host.app.inject({ method: "GET", url: `/api/v1/console/runs/${runId}/report`, headers });
    expect(response.statusCode).toBe(200);
    const report = runReportResponseSchema.parse(response.json());
    expect(report.validity.evidenceComplete).toBe(false);
    expect(report.validity.invalidReasons).toContain("undeclared-probes");
    // 无法计分的探针不进入探针列表，也不进入任何指标分母。
    expect(report.probes).toEqual([]);
    expect(report.metrics.every((metric) => metric.value === null)).toBe(true);

  });

  it("run_spec 为非法 JSON 时读取退回空规格，不抛内部错误", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    host.storage.transact((tx) => {
      const worldId = String(tx.rows("worlds").list()[0]?.["world_id"]);
      tx.rows("branches").put({
        branch_id: "br-bbbbbbbbbbbb", world_id: worldId, kind: "experiment", status: "active",
        parent_branch_id: host.branchId, forked_at_world_seq: 0, run_id: "run-bbbbbbbbbbbb",
        profile_hash: null, created_at: new Date().toISOString(),
      });
      tx.rows("runs").put({
        run_id: "run-bbbbbbbbbbbb", world_id: worldId, branch_id: "br-bbbbbbbbbbbb",
        mode: "closed-loop", status: "completed", run_spec_json: "{not valid json",
        manifest_json: null, manifest_hash: null, contaminated: 0, evidence_complete: 1,
        created_at: new Date().toISOString(),
      });
    });
    const detail = await host.app.inject({ method: "GET", url: "/api/v1/console/runs/run-bbbbbbbbbbbb", headers });
    expect(detail.statusCode).toBe(200);
    // 缺冻结清单摘要的 run 如实标记为证据不完整，而不是返回空摘要。
    const parsedDetail = runDetailResponseSchema.parse(detail.json());
    expect(parsedDetail.manifestHash).toBe("missing-manifest");
    expect(parsedDetail.evidenceComplete).toBe(false);
    const report = await host.app.inject({ method: "GET", url: "/api/v1/console/runs/run-bbbbbbbbbbbb/report", headers });
    expect(report.statusCode).toBe(200);
    // 规格不可解析时不猜变体与脚本，如实写占位值而不是伪造。
    expect(runReportResponseSchema.parse(report.json()).variant).toBe("unknown");
  });

  it("研究员可创建 run，预检通过后落库为 ready", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const runSpec = testRunSpec({ id: "created-by-console" });
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers, payload: { runSpec },
    });
    expect(response.statusCode).toBe(200);
    const created = runCreateResponseSchema.parse(response.json());
    expect(created.status).toBe("ready");
    expect(created.errors).toEqual([]);
    // 落库后应能被列表读到，并带冻结的 manifest 摘要。
    const detail = await host.app.inject({
      method: "GET", url: `/api/v1/console/runs/${created.runId}`, headers,
    });
    expect(detail.statusCode).toBe(200);
    const parsed = runDetailResponseSchema.parse(detail.json());
    expect(parsed.status).toBe("ready");
    expect(parsed.manifestHash.length).toBeGreaterThan(0);
  });

  it("非法 run 规格返回 preflight-failed 且不落库", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const before = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    const response = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/runs",
      headers,
      // 装配引用不存在：验证预检失败不落库。
      payload: { runSpec: { ...testRunSpec({ id: "bad" }), moduleAssemblyRef: "no-such-assembly" } },
    });
    expect(response.statusCode).toBe(200);
    const created = runCreateResponseSchema.parse(response.json());
    expect(created.status).toBe("preflight-failed");
    expect(created.errors.length).toBeGreaterThan(0);
    // 预检失败不落库：列表数量不变。
    const after = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    expect(after).toBe(before);
  });

  it("评估员不能创建 run 或导出，研究员可以导出", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "evaluation-console");
    const runId = onlineRunId(host);
    const evaluatorHeaders = consoleHeader(consoleToken, "evaluator");

    const evaluatorExport = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers: evaluatorHeaders,
      payload: { runId, redaction: "redacted" },
    });
    expect(evaluatorExport.statusCode).toBe(403);

    const researcherHeaders = consoleHeader(consoleToken, "researcher");
    const exported = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers: researcherHeaders,
      payload: { runId, redaction: "redacted" },
    });
    expect(exported.statusCode).toBe(200);
    expect(exportResponseSchema.parse(exported.json()).artifactId.length).toBeGreaterThan(0);
  });

  it("redacted 导出清空正文，raw 保留正文，两者都不含凭据值", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const runId = onlineRunId(host);
    const branchId = String(host.storage.transact((tx) => tx.rows("runs").get({ run_id: runId })?.["branch_id"]));
    // 写入一条含正文与凭据引用的事件：字符串形式的 JSON 列是真实存储形态。
    host.storage.transact((tx) => {
      tx.branch(branchId).table("domain_events").put({
        event_id: "evt-aaaaaaaaaaaa", world_seq: 1, world_tick: 0, type: "dialogue.said",
        schema_version: 1, principal_id: "human-independent",
        causation_ids_json: "[]", correlation_id: "corr-1",
        audience_json: JSON.stringify({ kind: "principals", principalIds: ["human-independent"] }),
        payload_json: JSON.stringify({
          text: "机密：星图只有一份", credentialRef: "secret/openai-key", apiKey: "sk-live-should-not-leak",
          sessionToken: "tok-live-should-not-leak",
        }),
        committed_at: new Date().toISOString(),
      });
    });

    const redacted = exportResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId, redaction: "redacted" },
    })).json());
    const raw = exportResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId, redaction: "raw" },
    })).json());
    expect(redacted.artifactId).not.toBe(raw.artifactId);

    const readArtifact = (artifactId: string) => host.storage.transact((tx) => {
      const row = tx.rows("artifacts").get({ artifact_id: artifactId });
      const body = row?.["body"];
      return typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8");
    });
    const redactedBody = readArtifact(redacted.artifactId);
    const rawBody = readArtifact(raw.artifactId);

    // 两种模式都不能出现凭据解析值。
    for (const body of [redactedBody, rawBody]) {
      expect(body).not.toContain("sk-live-should-not-leak");
      expect(body).not.toContain("tok-live-should-not-leak");
      expect(body).toContain("[redacted]");
    }
    // redacted 清空正文；raw 保留正文。
    expect(redactedBody).not.toContain("机密：星图只有一份");
    expect(rawBody).toContain("机密：星图只有一份");
    // redacted 只清正文，事件标识、类型与时间戳等元数据必须保留，否则导出无法追溯。
    const redactedBundle = JSON.parse(redactedBody) as { readonly events: readonly Record<string, unknown>[] };
    expect(redactedBundle.events[0]).toMatchObject({ event_id: "evt-aaaaaaaaaaaa", type: "dialogue.said" });
  });

  it("存档后恢复同一快照回到相同世界位置，且不重复结算", async () => {
    const host = await testHost();
    await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "evaluation-console" } });
    const session = (await host.app.inject({
      method: "POST", url: "/api/v1/auth/login", payload: { token: "evaluation-player" },
    })).json() as { readonly sessionToken: string };
    const auth = { Authorization: `Bearer ${session.sessionToken}` };

    // 先推进世界到快照之后的 tick：停在初始 tick 时，恢复是否生效都无法通过 tick 断言区分。
    advanceOnlineClock(host, 2);
    const viewBefore = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers: auth });
    expect(viewBefore.statusCode).toBe(200);
    const beforeTick = worldTickOf(viewBefore.json());
    expect(beforeTick).toBe(2);

    // 存档要求当前 tick 已排空；真实宿主启动即处于可控时钟的 paused 状态。
    const created = await host.app.inject({
      method: "POST", url: "/api/v1/campaign/snapshots", headers: auth,
      payload: { operationId: "op-000000000931", label: "恢复验证" },
    });
    expect(created.statusCode).toBe(200);
    const snapshot = created.json() as { readonly snapshotId: string; readonly worldTick: number };
    expect(snapshot.worldTick).toBe(beforeTick);

    // 再推进到 tick 4，让在线世界明显离开快照位置——恢复若未生效，下面会读到 4。
    advanceOnlineClock(host, 4);
    const viewAdvanced = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers: auth });
    expect(worldTickOf(viewAdvanced.json())).toBe(4);

    const restored = await host.app.inject({
      method: "POST", url: "/api/v1/campaign/restore", headers: auth,
      payload: { operationId: "op-000000000932", snapshotId: snapshot.snapshotId },
    });
    expect(restored.statusCode).toBe(200);

    const viewAfter = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers: auth });
    expect(viewAfter.statusCode).toBe(200);
    // 恢复回到快照的世界位置。恢复会新建分支并把在线入口指过去，因此 streamSeq 会推进，
    // 但世界时钟必须回到快照的 tick——这才是「不重复结算」的可核对判据。
    expect(worldTickOf(viewAfter.json())).toBe(snapshot.worldTick);
    const tickAfterRestore = worldTickOf(viewAfter.json());

    // 再次读取仍停在同一 tick：恢复没有留下会继续推进的自动结算。
    await new Promise((resolve) => setTimeout(resolve, 80));
    const viewStable = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers: auth });
    expect(worldTickOf(viewStable.json())).toBe(tickAfterRestore);
  });

  it("按实验规格展开并逐个创建 run，实验标识写入每个 run", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    // 内联规格指向测试装配：变体 × 脚本分支 × 重复次数都要体现在创建结果里。
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers,
      payload: { experimentSpec: testExperimentSpec({ experimentId: "exp-inline-check-v1", variants: ["memory-m0-window", "memory-m1-structured-ledger"], scriptBranches: ["keep", "break"], repetitions: 2 }) },
    });
    expect(response.statusCode, response.body).toBe(200);
    const created = experimentCreateResponseSchema.parse(response.json());
    expect(created.experimentId).toBe("exp-inline-check-v1");
    // 2 变体 × 2 分支 × 2 重复 = 8 个 run。
    expect(created.runIds).toHaveLength(8);

    // 每个 run 都能被实验接口归组：归组依据是写入的 experimentId，不是 seed。
    const detail = await host.app.inject({
      method: "GET", url: "/api/v1/console/experiments/exp-inline-check-v1", headers,
    });
    expect(detail.statusCode).toBe(200);
    const parsed = experimentDetailResponseSchema.parse(detail.json());
    expect(parsed.runs).toHaveLength(8);
    // 变体 × 脚本分支应分成 4 个格子。
    expect(parsed.cells).toHaveLength(4);
    expect(parsed.cells.map((cell) => `${cell.variant}/${cell.scriptBranch}`).sort())
      .toEqual([
        "memory-m0-window/break", "memory-m0-window/keep",
        "memory-m1-structured-ledger/break", "memory-m1-structured-ledger/keep",
      ]);
  });

  it("实验规格不合法时在创建任何 run 之前失败", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const before = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;

    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers,
      payload: { experimentSpec: { schemaVersion: 1, experimentId: "bad" } },
    });
    // 结构不合法由路由层拒绝。
    expect(response.statusCode).toBe(400);

    const after = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    expect(after).toBe(before);
  });
  it("空规格、含未知字段的规格与路径形态的 experimentRef 都以 validation 拒绝且不创建 run", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const before = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    const payloads = [
      { experimentSpec: {} },
      { experimentSpec: { ...testExperimentSpec({ experimentId: "exp-unknown-field-v1", variants: ["memory-m0-window"] }), notes: "typo" } },
      // 引用写规格文件基名；带目录或扩展名的路径与配置加载器的引用语法不一致，在请求层拒绝。
      { experimentRef: "config/experiments/exp-memory-promise-v1.yaml" },
    ];
    for (const payload of payloads) {
      const response = await host.app.inject({ method: "POST", url: "/api/v1/console/experiments", headers, payload });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe("validation");
    }
    const after = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    expect(after).toBe(before);
  });

  it("不存在的 experimentRef 返回 400 而不是内部错误", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers,
      payload: { experimentRef: "no-such-experiment" },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe("validation");
  });

  it("重复创建同一实验返回既有 run，不产生重复数据", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const payload = { experimentSpec: testExperimentSpec({
      experimentId: "exp-idempotent-v1",
      variants: ["memory-m0-window"],
      scriptBranches: ["keep"],
    }) };
    const first = experimentCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers, payload,
    })).json());
    expect(first.runIds).toHaveLength(1);
    expect(first.failedRunCount).toBe(0);

    // 重试同一请求：返回同一批 run，不重复创建。
    const second = experimentCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers, payload,
    })).json());
    expect(second.runIds).toEqual(first.runIds);
    const total = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.filter((run) => run.variant === "memory-m0-window").length;
    expect(total).toBe(1);
  });

  it("实验幂等只认当前世界，并返回 run 的真实状态", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const now = new Date().toISOString();
    host.storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: "wld-foreign-experiment", pack_id: "earth-2964-v1",
        content_version: "1.0.0", created_at: now,
      });
      tx.rows("branches").put({
        branch_id: "br-foreignexperiment", world_id: "wld-foreign-experiment",
        kind: "experiment", status: "active", parent_branch_id: null,
        forked_at_world_seq: 0, run_id: "run-fffffffffff1",
        profile_hash: null, created_at: now,
      });
      tx.rows("runs").put({
        run_id: "run-fffffffffff1", world_id: "wld-foreign-experiment",
        branch_id: "br-foreignexperiment", mode: "closed-loop", status: "completed",
        run_spec_json: { experimentId: "exp-cross-world-v1" },
        manifest_json: {}, manifest_hash: "hash", contaminated: 0,
        evidence_complete: 1, created_at: now, started_at: now, ended_at: now,
      });
    });
    const payload = {
      experimentSpec: testExperimentSpec({
        experimentId: "exp-cross-world-v1", variants: ["memory-m0-window"], scriptBranches: ["keep"],
      }),
    };
    const first = experimentCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers, payload,
    })).json());
    expect(first.runIds).toHaveLength(1);
    expect(first.runIds).not.toContain("run-fffffffffff1");
    const runId = first.runIds[0] as string;
    await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${runId}/start`, headers,
      payload: { operationId: "op-666666666666" },
    });
    const replay = experimentCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers, payload,
    })).json());
    expect(replay.runs[0]).toMatchObject({ runId, status: "running" });
  });

  it("并发创建同一实验只落一批 run", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const payload = {
      experimentSpec: testExperimentSpec({
        experimentId: "exp-concurrent-v1", variants: ["memory-m0-window"], scriptBranches: ["keep"],
      }),
    };
    const [left, right] = await Promise.all([
      host.app.inject({ method: "POST", url: "/api/v1/console/experiments", headers, payload }),
      host.app.inject({ method: "POST", url: "/api/v1/console/experiments", headers, payload }),
    ]);
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    const first = experimentCreateResponseSchema.parse(left.json());
    const second = experimentCreateResponseSchema.parse(right.json());
    expect(second.runIds).toEqual(first.runIds);
    const detail = experimentDetailResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/experiments/exp-concurrent-v1", headers,
    })).json());
    expect(detail.runs).toHaveLength(1);
  });

  it("部分 run 预检失败时保留每个 run 的状态与逐条原因", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    // 变体用一个不存在的 patch 引用：该 run 预检失败，另一个变体仍应创建。
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers,
      payload: { experimentSpec: testExperimentSpec({ experimentId: "exp-partial-v1", variants: ["memory-m0-window", "no-such-variant"] }) },
    });
    // 变体引用不存在时在规格校验阶段就失败，不创建任何 run。
    expect(response.statusCode).toBe(400);
    const runs = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs;
    expect(runs.filter((run) => run.variant === "memory-m0-window").length).toBe(0);
  });

  it("超出单次展开上限的实验被拒绝且不创建 run", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const before = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    // 变体 × 分支 × 重复次数超过上限：拒绝而不是创建任意多份 run。
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/experiments", headers,
      payload: { experimentSpec: testExperimentSpec({ experimentId: "exp-too-large-v1", variants: ["memory-m0-window"], scriptBranches: ["keep", "break"], repetitions: 200 }) },
    });
    expect(response.statusCode).toBe(400);
    const after = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json()).runs.length;
    expect(after).toBe(before);
  });

  it("评估员与操作员不能创建实验", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "evaluation-console");
    for (const role of ["evaluator", "operator"]) {
      const response = await host.app.inject({
        method: "POST", url: "/api/v1/console/experiments",
        headers: consoleHeader(consoleToken, role),
        payload: { experimentSpec: { schemaVersion: 1, experimentId: "exp-denied-v1" } },
      });
      expect(response.statusCode, role).toBe(403);
    }
  });
  it("run 可启动与停止，状态与分支时钟同步更新", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const created = runCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers,
      payload: { runSpec: testRunSpec({ id: "control-target" }) },
    })).json());
    expect(created.status).toBe("ready");
    const branchId = String(host.storage.transact((tx) =>
      tx.rows("runs").get({ run_id: created.runId })?.["branch_id"]));

    const started = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/start`, headers,
      payload: { operationId: "op-aaaaaaaaaaaa" },
    });
    expect(started.statusCode).toBe(200);
    expect(runControlResponseSchema.parse(started.json())).toEqual({ runId: created.runId, status: "running" });
    // run 状态与分支时钟同步：启动后时钟存在且为 running。
    expect(host.storage.transact((tx) => tx.rows("runs").get({ run_id: created.runId })?.["status"])).toBe("running");
    expect(host.storage.transact((tx) => tx.branch(branchId).table("clock").get({})?.["mode"])).toBe("running");

    const stopped = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/stop`, headers,
      payload: { operationId: "op-bbbbbbbbbbbb" },
    });
    expect(stopped.statusCode).toBe(200);
    expect(runControlResponseSchema.parse(stopped.json())).toEqual({ runId: created.runId, status: "paused" });
    expect(host.storage.transact((tx) => tx.branch(branchId).table("clock").get({})?.["mode"])).toBe("paused");
  });

  it("同一 operationId 重放返回原结果，用于其他 run 时报冲突", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const makeRun = async (id: string) => runCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers,
      payload: { runSpec: testRunSpec({ id: "run" }) },
    })).json());
    const first = await makeRun("idem-run-a");
    const second = await makeRun("idem-run-b");

    // 首次启动成功；同一 operationId 重放返回原结果，不重复推进版本。
    const started = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${first.runId}/start`, headers,
      payload: { operationId: "op-111111111111" },
    });
    expect(started.statusCode).toBe(200);
    const replay = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${first.runId}/start`, headers,
      payload: { operationId: "op-111111111111" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(started.json());

    // 同一 operationId 用于其他 run：幂等冲突，不能静默当成新操作。
    const conflicting = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${second.runId}/start`, headers,
      payload: { operationId: "op-111111111111" },
    });
    expect(conflicting.statusCode).toBe(409);
  });

  it("其他世界的 run 控制幂等记录不会被当作本世界重放", async () => {
    const host = await testHost();
    const token = await login(host, "evaluation-console");
    const headers = consoleHeader(token);
    const principalId = (await host.app.inject({
      method: "GET", url: "/api/v1/session", headers,
    })).json() as { readonly principalId?: string };
    expect(principalId.principalId).toBeTruthy();
    const created = runCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers,
      payload: { runSpec: testRunSpec({ id: "cross-world-control" }) },
    })).json());
    const now = new Date().toISOString();
    host.storage.transact((tx) => {
      // 外部世界使用同一 operationId；主键包含 world_id 后，本世界必须按新操作执行。
      tx.rows("run_control_idempotency").put({
        world_id: "wld-foreign-control", principal_id: String(principalId.principalId),
        operation_id: "op-555555555555", operation_kind: "start",
        run_id: "run-ffffffffffff", status: "running", created_at: now,
      });
    });
    const started = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/start`, headers,
      payload: { operationId: "op-555555555555" },
    });
    expect(started.statusCode).toBe(200);
    expect(runControlResponseSchema.parse(started.json())).toEqual({ runId: created.runId, status: "running" });
  });

  it("停止后可从 paused 恢复，且保留已推进的 tick", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const created = runCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers,
      payload: { runSpec: testRunSpec({ id: "resume-run" }) },
    })).json());
    const branchId = String(host.storage.transact((tx) =>
      tx.rows("runs").get({ run_id: created.runId })?.["branch_id"]));

    await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/start`, headers,
      payload: { operationId: "op-222222222222" },
    });
    // 模拟执行推进：把分支时钟推到 tick 7。
    host.storage.transact((tx) => {
      const table = tx.branch(branchId).table("clock");
      const row = table.get({});
      table.put({ ...row, world_tick: 7, updated_at: new Date().toISOString() });
    });
    await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/stop`, headers,
      payload: { operationId: "op-333333333333" },
    });
    expect(host.storage.transact((tx) => tx.branch(branchId).table("clock").get({})?.["world_tick"])).toBe(7);

    // 从 paused 恢复：run 回到 running，tick 保持 7 不清零。
    const resumed = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/start`, headers,
      payload: { operationId: "op-444444444444" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(runControlResponseSchema.parse(resumed.json()).status).toBe("running");
    const clock = host.storage.transact((tx) => tx.branch(branchId).table("clock").get({}));
    expect(clock?.["mode"]).toBe("running");
    expect(clock?.["world_tick"]).toBe(7);
  });

  it("状态不符时启动或停止返回 invalid-state", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const created = runCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers,
      payload: { runSpec: testRunSpec({ id: "control-state" }) },
    })).json());
    // ready 状态的 run 不能停止；启动后再启动也不允许。
    const stopBeforeStart = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/stop`, headers,
      payload: { operationId: "op-cccccccccccc" },
    });
    expect(stopBeforeStart.statusCode).toBe(409);
    await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/start`, headers,
      payload: { operationId: "op-dddddddddddd" },
    });
    const startTwice = await host.app.inject({
      method: "POST", url: `/api/v1/console/runs/${created.runId}/start`, headers,
      payload: { operationId: "op-eeeeeeeeeeee" },
    });
    expect(startTwice.statusCode).toBe(409);
    // 未知 run 返回 not-found。
    const missing = await host.app.inject({
      method: "POST", url: "/api/v1/console/runs/run-aaaaaaaaaaaa/start", headers,
      payload: { operationId: "op-ffffffffffff" },
    });
    expect(missing.statusCode).toBe(404);
  });
  it("其他世界的 run 不出现在列表、详情与报告中", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    // 登记一条属于其他世界的 run：控制台读取必须看不到它。
    // 先补一条 world 行满足外键约束（worlds 是部署级表，可容纳多个世界）。
    // 存储层要求可序列化的 JSON 单元格；工厂返回的对象需经 JSON 往返去掉 undefined。
    const runSpec = JSON.parse(JSON.stringify(testRunSpec({ id: "foreign-run" }))) as Record<string, never>;
    host.storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: "wld-other-world", pack_id: "earth-2964-v1",
        content_version: "1.0.0", created_at: new Date().toISOString(),
      });
      tx.rows("branches").put({
        branch_id: "br-ffffffffffff", world_id: "wld-other-world",
        kind: "experiment", status: "active", parent_branch_id: null,
        forked_at_world_seq: 0, run_id: "run-ffffffffffff",
        profile_hash: null, created_at: new Date().toISOString(),
      });
      tx.rows("runs").put({
        run_id: "run-ffffffffffff", world_id: "wld-other-world",
        branch_id: "br-ffffffffffff", mode: "closed-loop", status: "ready",
        run_spec_json: runSpec, manifest_json: {}, manifest_hash: "hash",
        contaminated: 0, evidence_complete: 1, created_at: new Date().toISOString(),
        started_at: null, ended_at: null,
      });
    });

    const list = runsResponseSchema.parse((await host.app.inject({
      method: "GET", url: "/api/v1/console/runs", headers,
    })).json());
    expect(list.runs.map((run) => run.runId)).not.toContain("run-ffffffffffff");

    // 直接按 ID 访问也当作不存在。
    const detail = await host.app.inject({
      method: "GET", url: "/api/v1/console/runs/run-ffffffffffff", headers,
    });
    expect(detail.statusCode).toBe(404);
    const report = await host.app.inject({
      method: "GET", url: "/api/v1/console/runs/run-ffffffffffff/report", headers,
    });
    expect(report.statusCode).toBe(404);
    // 启动控制同样拒绝作用域外的 run。
    const start = await host.app.inject({
      method: "POST", url: "/api/v1/console/runs/run-ffffffffffff/start", headers,
      payload: { operationId: "op-999999999999" },
    });
    expect(start.statusCode).toBe(404);
    // 导出也拒绝。
    const exported = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId: "run-ffffffffffff", redaction: "redacted" },
    });
    expect(exported.statusCode).toBe(404);
  });
  it("导出只含 artifact 元数据索引，不泄漏正文", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const created = runCreateResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/runs", headers,
      payload: { runSpec: testRunSpec({ id: "export-artifact" }) },
    })).json());
    expect(created.status).toBe("ready");

    // 写入一条带敏感正文的 artifact：导出的索引只能有元数据，不能把 body 带出去。
    host.storage.transact((tx) => {
      tx.rows("artifacts").put({
        artifact_id: "art-aaaaaaaaaaaa",
        run_id: created.runId,
        kind: "model-response",
        content_hash: "sha256-deadbeef",
        mime: "text/plain",
        byte_size: 32,
        storage: "inline",
        body: "SECRET-PROMPT-BODY-不可外泄",
        file_path: null,
        redaction: "raw",
        redacted_from: null,
        created_at: new Date().toISOString(),
      });
    });

    const exported = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId: created.runId, redaction: "redacted" },
    });
    expect(exported.statusCode).toBe(200);
    const body = exported.body;
    // 正文不能出现在导出包里，无论明示还是被脱敏模式放过。
    expect(body).not.toContain("SECRET-PROMPT-BODY");
    const parsed = exportResponseSchema.parse(exported.json());
    // 导出产出一个 artifact 标识，调用方据此取包；正文不进响应。
    expect(parsed.artifactId).toMatch(/^art-/);
  });
  it("导出未知 run 返回 not-found", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId: "run-aaaaaaaaaaaa", redaction: "redacted" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("两个实验共享同一 seed 时仍各自归组，不按 seed 合并", async () => {
    const host = await testHost();
    // 同一 seed 字符串下登记两组不同实验标识的 run：归组依据只能是 RunSpec 上的显式 experimentId。
    const sharedSeed = "shared-seed-without-experiment-hint:rep1";
    const experimentIds = ["exp-shared-seed-alpha", "exp-shared-seed-beta"];
    host.storage.transact((tx) => {
      const worlds = tx.rows("worlds").list();
      const worldId = String(worlds[0]?.["world_id"]);
      for (const [index, experimentId] of experimentIds.entries()) {
        const runId = `run-bbbbbbbbbbb${index}`;
        const branchId = `br-bbbbbbbbbbb${index}`;
        const createdAt = new Date().toISOString();
        tx.rows("branches").put({
          branch_id: branchId, world_id: worldId, kind: "experiment", status: "active",
          parent_branch_id: host.branchId, forked_at_world_seq: 0, run_id: runId,
          profile_hash: null, created_at: createdAt,
        });
        tx.rows("runs").put({
          run_id: runId, world_id: worldId, branch_id: branchId, mode: "closed-loop", status: "completed",
          run_spec_json: {
            id: `run-shared-${index}`, experimentId, seed: sharedSeed,
            variant: { id: "memory-m0-window", profilePatchRefs: ["memory-m0-window"], agentIds: null },
            script: { scriptRef: "s-promise", branch: "keep" },
          },
          manifest_json: {}, manifest_hash: "hash", contaminated: 0, evidence_complete: 1,
          created_at: createdAt, started_at: createdAt, ended_at: createdAt,
        });
      }
    });
    const headers = consoleHeader(await login(host, "evaluation-console"));

    const list = await host.app.inject({ method: "GET", url: "/api/v1/console/experiments", headers });
    expect(list.statusCode).toBe(200);
    const experiments = (list.json() as {
      readonly experiments: readonly { readonly experimentId: string; readonly runCount: number }[];
    }).experiments;
    // 同一 seed 若被当成实验标识，会合并成一条并把 runCount 记成 2。
    for (const experimentId of experimentIds) {
      expect(experiments).toContainEqual({ experimentId, runCount: 1 });
    }

    for (const experimentId of experimentIds) {
      const detail = await host.app.inject({
        method: "GET", url: `/api/v1/console/experiments/${experimentId}`, headers,
      });
      expect(detail.statusCode).toBe(200);
      const parsed = experimentDetailResponseSchema.parse(detail.json());
      // 每个实验只能看到自己那一条 run，不能把共享 seed 的另一个实验并进来。
      expect(parsed.runs).toHaveLength(1);
      expect(parsed.runs[0]?.runId).toBe(
        `run-bbbbbbbbbbb${experimentIds.indexOf(experimentId)}`,
      );
    }
  });

  it("实验详情按显式实验标识归组并给出分组汇总", async () => {
    const host = await testHost();
    // 直接登记两个带实验种子前缀的 run，用于验证归组与汇总读取；不启动真实实验。
    const experimentId = "exp-memory-promise-v1";
    host.storage.transact((tx) => {
      const worlds = tx.rows("worlds").list();
      const worldId = String(worlds[0]?.["world_id"]);
      for (const [index, variant] of ["memory-m0-window", "memory-m1-structured-ledger"].entries()) {
        const runId = `run-aaaaaaaaaaa${index}`;
        const branchId = `br-aaaaaaaaaaa${index}`;
        const createdAt = new Date().toISOString();
        tx.rows("branches").put({
          branch_id: branchId, world_id: worldId, kind: "experiment", status: "active",
          parent_branch_id: host.branchId, forked_at_world_seq: 0, run_id: runId,
          profile_hash: null, created_at: createdAt,
        });
        tx.rows("runs").put({
          run_id: runId, world_id: worldId, branch_id: branchId, mode: "closed-loop", status: "completed",
          run_spec_json: {
            id: `run-${index}`, experimentId, seed: `seed-without-experiment-hint:rep1`,
            variant: { id: variant, profilePatchRefs: [variant], agentIds: null },
            script: { scriptRef: "s-promise", branch: index === 0 ? "keep" : "break" },
          },
          manifest_json: {}, manifest_hash: "hash", contaminated: 0, evidence_complete: 1,
          created_at: createdAt, started_at: createdAt, ended_at: createdAt,
        });
      }
    });
    const headers = consoleHeader(await login(host, "evaluation-console"));

    const list = await host.app.inject({ method: "GET", url: "/api/v1/console/experiments", headers });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { readonly experiments: readonly { readonly experimentId: string }[] }).experiments)
      .toContainEqual(expect.objectContaining({ experimentId }));

    const detail = await host.app.inject({
      method: "GET", url: `/api/v1/console/experiments/${experimentId}`, headers,
    });
    expect(detail.statusCode).toBe(200);
    const parsed = experimentDetailResponseSchema.parse(detail.json());
    expect(parsed.runs).toHaveLength(2);
    // 两个变体各在独立的脚本分支上，因此应分成两个格子。
    expect(parsed.cells.map((cell) => cell.variant).sort()).toEqual(["memory-m0-window", "memory-m1-structured-ledger"]);
    expect(parsed.cells.every((cell) => cell.runIds.length === 1)).toBe(true);
  });
});
