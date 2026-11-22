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
  debugQueuesResponseSchema,
  errorResponseSchema,
  modelLayoutRoutesResponseSchema,
  modelLayoutValidateResponseSchema,
  modelLayoutsResponseSchema,
} from "@ai-npc/contracts";

const hosts: RunningHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function testHost(): Promise<RunningHost> {
  const root = mkdtempSync(join(tmpdir(), "ai-npc-console-research-"));
  roots.push(root);
  const host = await startHost({
    dataDir: root,
    playerToken: "research-player",
    consoleToken: "research-console",
    assemblyRef: "local-slg-test-v1",
    rosterRef: "core-3",
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

describe("控制台研究接口", () => {
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
    expect(invalidCapabilities.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalidCapabilities.json()).error.code).toBe("validation");

    const invalidVersion = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/model-layouts/validate",
      headers: modelHeader(consoleToken, "operator"),
      payload: { layout: { ...layout, schemaVersion: 2 } },
    });
    expect(invalidVersion.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalidVersion.json()).error.code).toBe("validation");
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
});
