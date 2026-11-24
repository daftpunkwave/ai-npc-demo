/**
 * 验证控制台模型布局、调试队列与研究接口的角色边界和静态校验。
 * 使用真实测试装配与 SQLite；不发送供应商请求或修改在线世界。
 * 禁止用页面隐藏代替接口 403，也不接受未经校验的模型挂载。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "@ai-npc/app-server";
import {
  agentInspectorResponseSchema,
  artifactResponseSchema,
  debugQueuesResponseSchema,
  errorResponseSchema,
  modelLayoutRoutesResponseSchema,
  modelLayoutValidateResponseSchema,
  modelLayoutsResponseSchema,
} from "@ai-npc/contracts";
import { loadContentPack } from "@ai-npc/experiment";
import { StoredAgentArtifactStore } from "@ai-npc/module-sdk";
import { createFakeHost } from "./authority-support";

const hosts: RunningHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function testHost(rateLimits?: { readonly read?: number; readonly write?: number }): Promise<RunningHost> {
  const root = mkdtempSync(join(tmpdir(), "ai-npc-console-research-"));
  roots.push(root);
  const host = await startHost({
    dataDir: root,
    playerToken: "research-player",
    consoleToken: "research-console",
    assemblyRef: "local-slg-test-v1",
    rosterRef: "core-3",
    ...(rateLimits === undefined ? {} : { rateLimits }),
  });
  hosts.push(host);
  return host;
}

async function login(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { token },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

function modelHeader(token: string, role = "researcher") {
  return { Authorization: `Bearer ${token}`, "X-Active-Role": role };
}

function onlineRun(host: RunningHost) {
  const run = host.storage.transact((tx) => tx.rows("runs").list({ branch_id: host.branchId })[0]);
  if (run === undefined || typeof run["run_id"] !== "string") throw new Error("expected online run");
  return { id: run["run_id"], row: run };
}

describe("控制台研究接口", () => {
  it("无限请求超过阈值后返回 429 与 Retry-After", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    // 读接口阈值 60/10s：连续请求直到被拒，验证限流真实生效。
    let rejected = 0;
    let retryAfter: string | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await host.app.inject({ method: "GET", url: "/api/v1/console/runs", headers });
      if (response.statusCode === 429) {
        rejected += 1;
        retryAfter = response.headers["retry-after"] as string | undefined;
        expect(errorResponseSchema.parse(response.json()).error.code).toBe("budget-exhausted");
        break;
      }
      expect(response.statusCode).toBe(200);
    }
    expect(rejected).toBe(1);
    // Retry-After 必须给出可用的等待秒数，便于调用方退避。
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("rateLimits 覆盖阈值实际生效", async () => {
    const host = await testHost({ read: 1, write: 1 });
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    const first = await host.app.inject({ method: "GET", url: "/api/v1/console/runs", headers });
    const second = await host.app.inject({ method: "GET", url: "/api/v1/console/runs", headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
  });

  it("内容接口不受限流影响", async () => {
    const host = await testHost();
    const session = await login(host, "research-player");
    const auth = { Authorization: `Bearer ${session}` };
    // 内容是廉价读且位于 /api/v1/ 之外的路由分组；连续请求都应成功。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const content = await host.app.inject({ method: "GET", url: "/api/v1/content", headers: auth });
      expect(content.statusCode, `content 第 ${attempt} 次`).toBe(200);
    }
  });

  it("列出模型布局、解析路由并提供受限静态校验", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    const layouts = await host.app.inject({ method: "GET", url: "/api/v1/console/model-layouts", headers });
    expect(layouts.statusCode).toBe(200);
    expect(modelLayoutsResponseSchema.parse(layouts.json()).layouts.map((entry) => entry.layoutId))
      .toEqual(expect.arrayContaining(["deterministic-model-layout-v1"]));

    const detail = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/model-layouts/deterministic-model-layout-v1",
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain("credentialValue");

    const routes = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/model-layouts/deterministic-model-layout-v1/routes",
      headers,
    });
    expect(routes.statusCode).toBe(200);
    expect(modelLayoutRoutesResponseSchema.parse(routes.json()).routes.length).toBeGreaterThan(0);

    const layout = {
      schemaVersion: 1,
      layoutId: "draft-check",
      connections: {
        fixtures: {
          adapterId: "platform.model-transport.deterministic",
          fixtureFiles: ["tests/fixtures/model/default.jsonl"],
        },
      },
      models: {
        "fixture-model": {
          connectionId: "fixtures",
          externalModel: "deterministic-v1",
          parameters: {},
          capabilities: {
            toolCalling: true, strictTools: true, structuredOutput: "json_schema",
            assistantReplay: "verbatim", contextWindowTokens: 64000, maxOutputTokens: 4096,
            embedding: false, embeddingDimensions: null,
          },
          limits: { maxConcurrent: 1, requestsPerMinute: 10, tokensPerMinute: 1000, requestTimeoutMs: 1000 },
          maxOutputTokensByPurpose: { decision: 100, speech: 100 },
        },
      },
      mounts: [{
        modelId: "fixture-model",
        agentIds: ["human-independent"],
        purposes: ["decision", "decision"],
      }],
    };
    const validation = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout },
    });
    expect(validation.statusCode).toBe(200);
    const parsed = modelLayoutValidateResponseSchema.parse(validation.json());
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((issue) => issue.code === "mount-duplicate")).toBe(true);
    const validLayout = JSON.parse(JSON.stringify(layout)) as {
      connections: Record<string, Record<string, unknown>>;
      mounts: Record<string, unknown>[];
    };
    const fixtureConnection = validLayout.connections["fixtures"];
    if (fixtureConnection === undefined) throw new Error("expected fixture connection");
    fixtureConnection["credentialRef"] = "mixed_Case";
    validLayout.mounts = [{ ...validLayout.mounts[0], purposes: ["decision"] }];
    const valid = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout: validLayout },
    });
    expect(valid.statusCode).toBe(200);
    expect(modelLayoutValidateResponseSchema.parse(valid.json())).toMatchObject({ ok: true, errors: [] });
    const oversizedMount = {
      ...validLayout,
      mounts: [{
        modelId: "fixture-model",
        agentIds: Array.from({ length: 65 }, () => "human-independent"),
        purposes: ["decision"],
      }],
    };
    const oversized = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout: oversizedMount },
    });
    expect(oversized.statusCode).toBe(200);
    expect(modelLayoutValidateResponseSchema.parse(oversized.json())).toMatchObject({
      ok: false, errors: [{ code: "schema", message: expect.stringContaining("mounts.0.agentIds") }],
    });
    const cappedErrors = {
      ...validLayout,
      mounts: [{
        modelId: "fixture-model",
        agentIds: Array.from({ length: 64 }, () => "human-independent"),
        purposes: Array.from({ length: 8 }, () => "decision"),
      }],
    };
    const capped = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout: cappedErrors },
    });
    expect(capped.statusCode).toBe(200);
    expect(modelLayoutValidateResponseSchema.parse(capped.json()).errors).toHaveLength(100);

    const missingCapabilities = JSON.parse(JSON.stringify(layout)) as {
      models?: Record<string, Record<string, unknown>>;
    };
    delete missingCapabilities.models?.["fixture-model"]?.["capabilities"];
    const invalidCapabilities = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout: missingCapabilities },
    });
    expect(invalidCapabilities.statusCode).toBe(200);
    expect(modelLayoutValidateResponseSchema.parse(invalidCapabilities.json())).toMatchObject({
      ok: false, errors: [{ code: "schema", message: expect.stringContaining("models.fixture-model.capabilities") }],
    });

    const invalidVersion = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout: { ...layout, schemaVersion: 2 } },
    });
    expect(invalidVersion.statusCode).toBe(200);
    expect(modelLayoutValidateResponseSchema.parse(invalidVersion.json())).toMatchObject({
      ok: false, errors: [{ code: "schema", message: expect.stringContaining("schemaVersion") }],
    });
  });

  it("接受任意 JSON 布局供校验器检查，拒绝缺失 layout 的请求", async () => {
    const host = await testHost();
    const headers = modelHeader(await login(host, "research-console"), "operator");
    const url = "/api/v1/console/model-layouts/validate";
    const invalid = await host.app.inject({ method: "POST", url, headers, payload: { layout: null } });
    expect(invalid.statusCode).toBe(200);
    expect(modelLayoutValidateResponseSchema.parse(invalid.json())).toMatchObject({
      ok: false, errors: [{ code: "schema" }],
    });
    const missing = await host.app.inject({ method: "POST", url, headers, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe("validation");
  });

  it("拒绝玩家读取研究接口，并返回有数据来源的调试队列", async () => {
    const host = await testHost();
    const playerToken = await login(host, "research-player");
    const denied = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/model-layouts",
      headers: modelHeader(playerToken),
    });
    expect(denied.statusCode).toBe(403);
    expect(errorResponseSchema.parse(denied.json()).error.code).toBe("forbidden");

    const consoleToken = await login(host, "research-console");
    const queues = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/debug/queues",
      headers: modelHeader(consoleToken),
    });
    expect(queues.statusCode).toBe(200);
    expect(debugQueuesResponseSchema.parse(queues.json()).scheduler.queued).toBeGreaterThanOrEqual(0);
  });

  it("拒绝跨世界分支的检查器和分支比较", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    const createdAt = new Date().toISOString();
    host.storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: "wld-otherworld",
        pack_id: "earth-2964-v1",
        content_version: "0.2.0",
        created_at: createdAt,
      });
      tx.rows("branches").put({
        branch_id: "br-otherworld",
        world_id: "wld-otherworld",
        kind: "online",
        status: "paused",
        parent_branch_id: null,
        forked_at_world_seq: null,
        run_id: null,
        profile_hash: null,
        created_at: createdAt,
      });
    });
    const inspector = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/agents/human-independent/inspector?branchId=br-otherworld",
      headers,
    });
    expect(inspector.statusCode).toBe(403);
    const compare = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/branches/compare?left=${host.branchId}&right=br-otherworld&atSeq=0`,
      headers,
    });
    expect(compare.statusCode).toBe(403);
    const missing = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/branches/compare?left=${host.branchId}&right=br-missing&atSeq=0`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("尚无 trace 的 queued turn 仍能返回可展示详情", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const createdAt = new Date().toISOString();
    host.storage.transact((tx) => {
      const runId = String(tx.rows("runs").list({ branch_id: host.branchId })[0]?.["run_id"]);
      tx.rows("turn_runs").put({
        turn_id: "turn-000000000099",
        run_id: runId,
        branch_id: host.branchId,
        agent_id: "human-independent",
        agent_turn_index: 99,
        status: "queued",
        trigger_ids_json: [],
        input_frontier_json: null,
        memory_revision: null,
        profile_hash: "queued",
        controller_epoch: 1,
        turn_lease_epoch: 0,
        lease_expires_at: null,
        terminal_reason: null,
        effective_json: [],
        created_at: createdAt,
        started_at: null,
        ended_at: null,
        created_tick: 0,
      });
    });
    const detail = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/turns/turn-000000000099",
      headers: modelHeader(consoleToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ status: "queued", traceId: null });
  });

  it("turn 列表拒绝损坏的触发 ID JSON", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const runId = host.storage.transact((tx) =>
      String(tx.rows("runs").list({ branch_id: host.branchId })[0]?.["run_id"]));
    host.storage.transact((tx) => {
      tx.rows("turn_runs").put({
        turn_id: "turn-000000000098",
        run_id: runId,
        branch_id: host.branchId,
        agent_id: "human-independent",
        agent_turn_index: 98,
        status: "queued",
        trigger_ids_json: "not-json",
        input_frontier_json: null,
        memory_revision: null,
        profile_hash: "broken-trigger",
        controller_epoch: 1,
        turn_lease_epoch: 0,
        lease_expires_at: null,
        terminal_reason: null,
        effective_json: [],
        created_at: new Date().toISOString(),
        started_at: null,
        ended_at: null,
        created_tick: 0,
      });
    });
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/turns?branchId=${host.branchId}&limit=1`,
      headers: modelHeader(consoleToken),
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe("invalid-state");
  });

  it("观察分页拒绝空或非整数的 limit，并先按分支筛选 turn", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    const invalidLimit = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/observations?branchId=${host.branchId}&fromSeq=0&limit=`,
      headers,
    });
    expect(invalidLimit.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalidLimit.json()).error.code).toBe("validation");
    const invalidAgent = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/turns?branchId=${host.branchId}&agentId=`,
      headers,
    });
    expect(invalidAgent.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalidAgent.json()).error.code).toBe("validation");
    const turns = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/turns?branchId=${host.branchId}&agentId=human-independent&limit=1`,
      headers,
    });
    expect(turns.statusCode).toBe(200);
    expect(turns.json()).toMatchObject({ turns: [] });
  });

  it("记忆快照与差异拒绝高于已提交水位的 revision", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    const revision = host.storage.transact((tx) =>
      tx.branch(host.branchId).table("memory_watermarks").get({ agent_id: "human-independent" })
        ?.["revision"]);
    expect(revision).toBe(0);

    const initial = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/memory?branchId=${host.branchId}&revision=0`,
      headers,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ revision: 0, records: [] });

    const futureSnapshot = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/memory?branchId=${host.branchId}&revision=1`,
      headers,
    });
    expect(futureSnapshot.statusCode).toBe(404);
    expect(errorResponseSchema.parse(futureSnapshot.json()).error.code).toBe("not-found");

    const futureDiff = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/memory/diff?branchId=${host.branchId}&from=0&to=1`,
      headers,
    });
    expect(futureDiff.statusCode).toBe(404);
    expect(errorResponseSchema.parse(futureDiff.json()).error.code).toBe("not-found");
  });

  it("非法记忆行不会被静默过滤为空快照", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    host.storage.transact((tx) => {
      tx.branch(host.branchId).table("memory_records").put({
        agent_id: "human-independent",
        memory_id: "mem-000000000099",
        row_version: 1,
        module_id: "agent.memory.ledger",
        kind: "episodic",
        tier: "short",
        status: "active",
        epistemic: "verified-event",
        release_policy_id: "policy-1",
        valid_from_tick: 0,
        valid_until_tick: null,
        created_revision: "invalid",
        retired_revision: null,
        strength: 1,
        salience: 0,
        recall_count: 0,
        tags_json: [],
        source_observation_ids_json: ["obs-000000000001"],
        content_json: {},
      });
    });
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/memory?branchId=${host.branchId}&revision=0`,
      headers: modelHeader(consoleToken),
    });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe("invalid-state");
  });

  it("检查器区分未知 Agent 和没有记忆的已知 Agent", async () => {
    const host = await testHost();
    const headers = modelHeader(await login(host, "research-console"));
    const inspect = (agentId: string) => host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/${agentId}/inspector?branchId=${host.branchId}`,
      headers,
    });
    const unknown = await inspect("unknown-agent");
    expect(unknown.statusCode).toBe(404);
    expect(errorResponseSchema.parse(unknown.json()).error.code).toBe("not-found");

    const known = await inspect("human-independent");
    expect(known.statusCode).toBe(200);
    expect(agentInspectorResponseSchema.parse(known.json())).toMatchObject({
      agentId: "human-independent",
      memoryRecords: [],
    });
  });

  it("拒绝读取无 run 归属和跨世界 artifact，并且不写原文读取审计", async () => {
    const host = await testHost();
    const headers = modelHeader(await login(host, "research-console"));
    const { row } = onlineRun(host);
    const foreignRunId = "run-000000000099";
    const createdAt = "2026-01-01T00:00:00.000Z";
    host.storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: "wld-artifact-foreign",
        pack_id: "earth-2964-v1",
        content_version: "0.2.0",
        created_at: createdAt,
      });
      tx.rows("branches").put({
        branch_id: "br-artifact-foreign",
        world_id: "wld-artifact-foreign",
        kind: "experiment",
        status: "paused",
        parent_branch_id: null,
        forked_at_world_seq: null,
        run_id: foreignRunId,
        profile_hash: null,
        created_at: createdAt,
      });
      tx.rows("runs").put({
        ...row,
        run_id: foreignRunId,
        world_id: "wld-artifact-foreign",
        branch_id: "br-artifact-foreign",
      });
    });
    const artifacts = new StoredAgentArtifactStore(host.storage, createFakeHost());
    for (const runId of [null, foreignRunId]) {
      const { artifactId } = await artifacts.put({ runId, kind: "model-request", value: "private fixture" });
      for (const view of ["redacted", "raw"]) {
        const response = await host.app.inject({
          method: "GET",
          url: `/api/v1/console/artifacts/${artifactId}?view=${view}`,
          headers,
        });
        expect(response.statusCode).toBe(403);
        expect(errorResponseSchema.parse(response.json()).error.code).toBe("forbidden");
        expect(response.body).not.toContain("private fixture");
      }
    }
    expect(host.storage.transact((tx) =>
      tx.all("SELECT type FROM lifecycle_events WHERE type = 'ArtifactViewed'"))).toEqual([]);
  });

  it("读取实际写入端持久化的超过 64 KiB 的 artifact，并按所属 run 记审计", async () => {
    const host = await testHost();
    const headers = modelHeader(await login(host, "research-console"));
    const runId = onlineRun(host).id;
    const artifacts = new StoredAgentArtifactStore(host.storage, createFakeHost());
    const value = { content: "证".repeat(25_000) };
    const { artifactId, byteSize } = await artifacts.put({ runId, kind: "model-request", value });
    expect(byteSize).toBeGreaterThan(65_536);
    expect(host.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId })?.["storage"]))
      .toBe("inline");
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/artifacts/${artifactId}?view=raw`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(artifactResponseSchema.parse(response.json()).body)).toEqual(value);
    const audit = host.storage.transact((tx) => tx.all(
      "SELECT run_id, payload_json FROM lifecycle_events WHERE type = 'ArtifactViewed'",
    ));
    expect(audit).toEqual([{
      run_id: runId,
      payload_json: expect.stringContaining(artifactId),
    }]);
  });

  it("脱敏 artifact 同时处理秘密键与值且不写原文审计", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const secret = [...loadContentPack("content", "earth-2964-v1").index.secrets.values()][0];
    if (secret === undefined) throw new Error("expected configured secret");
    const artifactId = "art-000000000099";
    const runId = onlineRun(host).id;
    const label = `[SECRET ${secret.secretId} len=${secret.content.length}]`;
    const body = JSON.stringify(Object.fromEntries([
      [secret.content, secret.content],
      [label, "保留同名键的值"],
      ["nested", { [secret.content]: secret.content }],
      ["__proto__", { nested: secret.content }],
    ]));
    host.storage.transact((tx) => {
      tx.rows("artifacts").put({
        artifact_id: artifactId,
        run_id: runId,
        kind: "model-request",
        content_hash: "0".repeat(64),
        mime: "application/json",
        byte_size: new TextEncoder().encode(body).byteLength,
        storage: "inline",
        body: new TextEncoder().encode(body),
        file_path: null,
        redaction: "raw",
        redacted_from: null,
        created_at: new Date().toISOString(),
      });
    });
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/artifacts/${artifactId}?view=redacted`,
      headers: modelHeader(consoleToken),
    });
    expect(response.statusCode).toBe(200);
    const redacted = artifactResponseSchema.parse(response.json()).body;
    expect(redacted).not.toContain(secret.content);
    const parsed = JSON.parse(redacted) as object;
    expect(parsed).toMatchObject({
      [label]: label,
      [`${label}#2`]: "保留同名键的值",
      nested: { [label]: label },
    });
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(host.storage.transact((tx) =>
      tx.all("SELECT type FROM lifecycle_events WHERE type = 'ArtifactViewed'"))).toEqual([]);
  });

  it("记忆差异覆盖状态与来源观察变化", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    host.storage.transact((tx) => {
      const branch = tx.branch(host.branchId);
      const watermark = branch.table("memory_watermarks").get({ agent_id: "human-independent" });
      if (watermark === null) throw new Error("missing memory watermark");
      branch.table("memory_watermarks").put({ ...watermark, revision: 2 });
      const records = branch.table("memory_records");
      const base = {
        agent_id: "human-independent",
        memory_id: "mem-000000000098",
        module_id: "agent.memory.ledger",
        kind: "episodic",
        tier: "short",
        epistemic: "verified-event",
        release_policy_id: "policy-1",
        valid_from_tick: 0,
        valid_until_tick: null,
        strength: 1,
        salience: 0,
        recall_count: 0,
        tags_json: [],
        content_json: { summary: "相同内容" },
      };
      records.put({
        ...base,
        row_version: 1,
        status: "active",
        created_revision: 1,
        retired_revision: 2,
        source_observation_ids_json: ["obs-000000000001"],
      });
      records.put({
        ...base,
        row_version: 2,
        status: "superseded",
        created_revision: 2,
        retired_revision: null,
        source_observation_ids_json: ["obs-000000000002"],
      });
      records.put({
        ...base,
        memory_id: "mem-000000000097",
        row_version: 1,
        status: "active",
        created_revision: 1,
        retired_revision: 2,
        source_observation_ids_json: ["obs-000000000001"],
      });
      records.put({
        ...base,
        memory_id: "mem-000000000097",
        row_version: 2,
        status: "active",
        created_revision: 2,
        retired_revision: null,
        strength: 0.5,
        salience: 0.8,
        source_observation_ids_json: ["obs-000000000001"],
      });
    });
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/memory/diff?branchId=${host.branchId}&from=1&to=2`,
      headers: modelHeader(consoleToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      changed: expect.arrayContaining([
        { memoryId: "mem-000000000098", sourceObservationIds: ["obs-000000000002"] },
        { memoryId: "mem-000000000097", sourceObservationIds: ["obs-000000000001"] },
      ]),
    });
  });

  it("调试队列区分排队与租约中的记忆整理", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const runId = host.storage.transact((tx) =>
      String(tx.rows("runs").list({ branch_id: host.branchId })[0]?.["run_id"]));
    host.storage.transact((tx) => {
      const runs = tx.rows("maintenance_runs");
      const base = {
        branch_id: host.branchId,
        run_id: runId,
        agent_id: "human-independent",
        module_id: "agent.memory.ledger",
        trigger: "day-passed",
        due_tick: 1,
        observation_seq_through: 0,
        task_json: {},
        base_revision: 0,
        lease_epoch: 0,
        lease_expires_at: null,
        error_json: null,
        created_at: new Date().toISOString(),
        ended_at: null,
      };
      runs.put({ ...base, maintenance_id: "mnt-000000000001", status: "queued" });
      runs.put({ ...base, maintenance_id: "mnt-000000000002", status: "leased" });
    });
    const queues = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/debug/queues",
      headers: modelHeader(consoleToken),
    });
    expect(queues.statusCode).toBe(200);
    expect(debugQueuesResponseSchema.parse(queues.json()).maintenance)
      .toMatchObject({ queued: 1, running: 1 });
  });

  it("turn 列表与回放先按当前世界限制范围", async () => {
    const host = await testHost();
    const consoleToken = await login(host, "research-console");
    const headers = modelHeader(consoleToken);
    const createdAt = new Date().toISOString();
    const runId = String(host.storage.transact((tx) =>
      tx.rows("runs").list({ branch_id: host.branchId })[0]?.["run_id"]));
    host.storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: "wld-turn-limit",
        pack_id: "earth-2964-v1",
        content_version: "0.2.0",
        created_at: createdAt,
      });
      tx.rows("branches").put({
        branch_id: "br-turn-limit",
        world_id: "wld-turn-limit",
        kind: "online",
        status: "paused",
        parent_branch_id: null,
        forked_at_world_seq: null,
        run_id: null,
        profile_hash: null,
        created_at: createdAt,
      });
      const turns = tx.rows("turn_runs");
      for (let index = 0; index < 200; index += 1) {
        turns.put({
          turn_id: `turn-${String(index + 1000).padStart(12, "0")}`,
          run_id: runId,
          branch_id: "br-turn-limit",
          agent_id: "human-independent",
          agent_turn_index: index + 1,
          status: "queued",
          trigger_ids_json: [],
          input_frontier_json: null,
          memory_revision: null,
          profile_hash: "cross-world",
          controller_epoch: 1,
          turn_lease_epoch: 0,
          lease_expires_at: null,
          terminal_reason: null,
          effective_json: [],
          created_at: new Date(Date.parse(createdAt) + index).toISOString(),
          started_at: null,
          ended_at: null,
          created_tick: 0,
        });
      }
      turns.put({
        turn_id: "turn-000000000999",
        run_id: runId,
        branch_id: host.branchId,
        agent_id: "human-independent",
        agent_turn_index: 999,
        status: "queued",
        trigger_ids_json: [],
        input_frontier_json: null,
        memory_revision: null,
        profile_hash: "current-world",
        controller_epoch: 1,
        turn_lease_epoch: 0,
        lease_expires_at: null,
        terminal_reason: null,
        effective_json: [],
        created_at: new Date(Date.parse(createdAt) - 1_000).toISOString(),
        started_at: null,
        ended_at: null,
        created_tick: 0,
      });
      tx.rows("model_attempts").put({
        attempt_id: "att-000000000099",
        llm_call_id: "llm-000000000099",
        run_id: runId,
        work_ref: "turn-000000001000",
        agent_id: "human-independent",
        evaluator_id: null,
        purpose: "decision",
        model_id: "fixture-model",
        connection_id: "fixtures",
        adapter_id: "platform.model-transport.deterministic",
        status: "succeeded",
        is_effective: 1,
        request_artifact_id: null,
        response_artifact_id: null,
        usage_json: null,
        timings_json: null,
        error_json: null,
        created_at: createdAt,
      });
    });

    const turns = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/turns?limit=1",
      headers,
    });
    expect(turns.statusCode).toBe(200);
    expect(turns.json()).toMatchObject({ turns: [{ turnId: "turn-000000000999" }] });
    const replay = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/debug/turns/turn-000000001000/replay",
      headers,
      payload: {},
    });
    expect(replay.statusCode).toBe(403);
  });
});
