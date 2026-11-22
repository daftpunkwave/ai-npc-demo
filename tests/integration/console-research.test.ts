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
  });
});
