/**
 * 核心职责：验证评估读取接口的角色边界、run 报告口径与实验汇总读取。
 * 交互契约：使用真实测试装配、SQLite 与控制台会话；不调用模型、不创建实验。
 * 约束与禁忌：禁止用页面隐藏代替接口 403；禁止在测试里改写计分逻辑，断言必须走真实端口。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "@ai-npc/app-server";
import {
  errorResponseSchema,
  experimentDetailResponseSchema,
  runDetailResponseSchema,
  runReportResponseSchema,
  runsResponseSchema,
  runCreateResponseSchema,
  exportResponseSchema,
  experimentCreateResponseSchema,
} from "@ai-npc/contracts";

const hosts: RunningHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function testHost(): Promise<RunningHost> {
  const root = mkdtempSync(join(tmpdir(), "ai-npc-console-evaluation-"));
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
    const runSpec = {
      schemaVersion: 1,
      id: "created-by-console",
      moduleAssemblyRef: "local-slg-test-v1",
      worldPackRef: "earth-2964-v1",
      scenarioRef: "watergate-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
      seed: "created-by-console:rep1",
      player: { principalId: "player-1", factionId: null },
      mode: "closed-loop",
      initialState: { kind: "cold-start" },
      variant: null,
      script: null,
      clock: { kind: "controlled" },
      budget: { maxTokens: null, maxCost: null },
      failurePolicy: "strict",
    };
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
      payload: { runSpec: {
        schemaVersion: 1, id: "bad", moduleAssemblyRef: "no-such-assembly",
        worldPackRef: "earth-2964-v1", scenarioRef: "watergate-v1", rosterRef: "core-3",
        modelLayoutRef: "deterministic-model-layout-v1", seed: "bad:rep1",
        player: { principalId: "player-1", factionId: null },
        mode: "closed-loop", initialState: { kind: "cold-start" }, variant: null, script: null,
        clock: { kind: "controlled" }, budget: { maxTokens: null, maxCost: null }, failurePolicy: "strict",
      } },
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
      payload: { runId, redaction: "redacted", operationId: "op-aaaaaaaaaaaa" },
    });
    expect(evaluatorExport.statusCode).toBe(403);

    const researcherHeaders = consoleHeader(consoleToken, "researcher");
    const exported = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers: researcherHeaders,
      payload: { runId, redaction: "redacted", operationId: "op-bbbbbbbbbbbb" },
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
        }),
        committed_at: new Date().toISOString(),
      });
    });

    const redacted = exportResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId, redaction: "redacted", operationId: "op-dddddddddddd" },
    })).json());
    const raw = exportResponseSchema.parse((await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId, redaction: "raw", operationId: "op-eeeeeeeeeeee" },
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
      expect(body).toContain("[redacted]");
    }
    // redacted 清空正文；raw 保留正文。
    expect(redactedBody).not.toContain("机密：星图只有一份");
    expect(rawBody).toContain("机密：星图只有一份");
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
      payload: { experimentSpec: {
        schemaVersion: 1,
        experimentId: "exp-inline-check-v1",
        base: {
          moduleAssemblyRef: "local-slg-test-v1", worldPackRef: "earth-2964-v1",
          scenarioRef: "watergate-v1", rosterRef: "core-3",
          modelLayoutRef: "deterministic-model-layout-v1",
          seed: "inline-check-v1",
          player: { principalId: "player-1", factionId: "human-neutral" },
          mode: "closed-loop", initialState: { kind: "cold-start" },
          clock: { kind: "controlled" }, budget: { maxTokens: null, maxCost: null },
          failurePolicy: "strict",
        },
        scriptRef: "s-promise",
        scriptBranches: ["keep", "break"],
        commonPatchRefs: [],
        variants: ["memory-m0-window", "memory-m1-structured-ledger"],
        repetitions: 2,
        runOrder: "sequential",
      } },
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
  it("导出未知 run 返回 not-found", async () => {
    const host = await testHost();
    const headers = consoleHeader(await login(host, "evaluation-console"));
    const response = await host.app.inject({
      method: "POST", url: "/api/v1/console/exports", headers,
      payload: { runId: "run-aaaaaaaaaaaa", redaction: "redacted", operationId: "op-cccccccccccc" },
    });
    expect(response.statusCode).toBe(404);
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
