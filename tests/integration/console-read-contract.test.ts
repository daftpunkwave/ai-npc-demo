/**
 * 核心职责：验证控制台只读接口返回结构化真实事实——查询边界复用公共 schema、Agent 位置与水位滞后取持久化数据、健康摘要预算来自账本、错误响应携带可关联的 traceId。
 * 交互契约：启动真实宿主与临时 SQLite，经 HTTP 注入读取控制台接口；只读取 storage 端口核对落库事实。
 * 约束与禁忌：不得用固定 0 或空数组冒充无数据源；不得为了通过断言放宽契约 schema 或跳过错误路径。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResponseSchema, timelineQuerySchema } from "@ai-npc/contracts";
import { startHost, type RunningHost } from "@ai-npc/app-server";
import { gameCommandEnvelope } from "./game-support";
import { stubStandardModelHttp } from "./standard-model-support";

const hosts: RunningHost[] = [];
const dirs: string[] = [];
let restoreStandardModelHttp: (() => void) | undefined;

beforeEach(() => {
  restoreStandardModelHttp = stubStandardModelHttp();
});

afterEach(() => {
  restoreStandardModelHttp?.();
  restoreStandardModelHttp = undefined;
});

afterEach(async () => {
  const failures: unknown[] = [];
  const closed = await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const result of closed) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `控制台只读接口测试清理未全部完成：${failures.length} 处失败`);
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-console-read-"));
  dirs.push(dir);
  return dir;
}

/** 用启动令牌登录并返回会话令牌。 */
async function loginSession(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

/** 研究员身份的控制台请求头。 */
async function researcherHeaders(host: RunningHost): Promise<Record<string, string>> {
  const session = await loginSession(host, "console-token");
  return { authorization: `Bearer ${session}`, "x-active-role": "researcher" };
}

/** 启动宿主并开局：控制台接口的多数只读数据来自已开局分支。 */
async function hostsWithCampaign(): Promise<RunningHost> {
  const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
  hosts.push(host);
  const session = await loginSession(host, "player-token");
  const started = await host.app.inject({
    method: "POST",
    url: "/api/v1/commands",
    headers: { authorization: `Bearer ${session}` },
    payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001"),
  });
  expect(started.statusCode).toBe(200);
  return host;
}

describe("控制台只读接口的契约保真度", () => {
  it("时间线查询缺省 fromSeq/limit 时按共享 schema 默认值取数", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    // 缺省两个分页参数：旧实现给 0/100，但契约 schema 曾把两者声明为必填，
    // 因此这里同时断言「请求被接受」和「默认值与 schema 声明一致」。
    const queryDefaults = timelineQuerySchema.parse({});
    expect(queryDefaults).toMatchObject({ fromSeq: 0, limit: 100 });
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/timeline?branchId=${host.branchId}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray((response.json() as { readonly events: unknown[] }).events)).toBe(true);
  });

  it("时间线的 types 数量上限由共享 schema 裁决，超出即 400", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    // 21 个类型超过契约上限 20：路由不得自行放宽，也不得接受 schema 判为非法的请求。
    const tooMany = Array.from({ length: 21 }, (_, index) => `event.${index}`).join(",");
    expect(timelineQuerySchema.safeParse({ types: tooMany.split(",") }).success).toBe(false);
    const rejected = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/timeline?types=${encodeURIComponent(tooMany)}`,
      headers,
    });
    expect(rejected.statusCode).toBe(400);
    expect(errorResponseSchema.parse(rejected.json()).error.code).toBe("validation");

    // schema 允许的 20 个类型必须被接受，避免出现「schema 放行、路由 400」的两套边界。
    const exactlyAtLimit = Array.from({ length: 20 }, (_, index) => `event.${index}`).join(",");
    expect(timelineQuerySchema.safeParse({ types: exactlyAtLimit.split(",") }).success).toBe(true);
    const accepted = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/timeline?types=${encodeURIComponent(exactlyAtLimit)}`,
      headers,
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("时间线的非法 fromSeq 与 order 按 schema 边界拒绝", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    const negativeFromSeq = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/timeline?branchId=${host.branchId}&fromSeq=-1`,
      headers,
    });
    expect(negativeFromSeq.statusCode).toBe(400);
    const badOrder = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline?order=sideways",
      headers,
    });
    expect(badOrder.statusCode).toBe(400);
    const overflowingLimit = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline?limit=201",
      headers,
    });
    expect(overflowingLimit.statusCode).toBe(400);
  });

  it("Agent 位置与水位滞后取自持久化事实，而非恒定的 null 与 0", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    // 制造一条尚未被该 Agent 感知的领域事件：全局世界序号领先于所有感知水位。
    host.storage.transact((tx) => {
      tx.branch(host.branchId).table("domain_events").put({
        world_seq: 9001,
        event_id: "evt-000009001",
        world_tick: 0,
        type: "CampaignStarted",
        schema_version: 1,
        principal_id: "player-1",
        causation_ids_json: [],
        correlation_id: "corr-000009001",
        audience_json: [{ kind: "public" }],
        payload_json: {},
        committed_at: "2026-01-01T00:00:00.000Z",
      });
    });
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents?branchId=${host.branchId}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const agents = (response.json() as {
      readonly agents: ReadonlyArray<{
        readonly agentId: string;
        readonly location: string | null;
        readonly watermarkLag: number;
      }>;
    }).agents;
    expect(agents.length).toBeGreaterThan(0);
    // 已开局角色在世界模块里有 nodeId，位置必须是真实节点而不是 null。
    const character = agents.find((agent) => agent.agentId === "npc-wenzhao");
    expect(character).toBeDefined();
    expect(character?.location).not.toBeNull();
    expect(typeof character?.location).toBe("string");
    // 未建立感知水位的 Agent 滞后整条事件流，不得用 0 冒充。
    expect(character?.watermarkLag).toBeGreaterThan(0);
  });

  it("健康摘要的预算条目来自账本，不再固定为空数组", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    const branch = host.storage.transact((tx) => tx.rows("branches").get({ branch_id: host.branchId }));
    const runId = String(branch?.["run_id"]);
    // 直接写入一条已结算的账本记录：健康摘要必须反映真实消耗，而不是恒为 []。
    host.storage.transact((tx) => {
      tx.rows("budget_ledger").put({
        entry_id: "bgt-000000000001",
        run_id: runId,
        agent_id: "npc-wenzhao",
        work_ref: "turn-000000000001",
        purpose: "agent-turn",
        model_id: "deterministic-test",
        world_day: 1,
        reserved_input: 100,
        reserved_output: 50,
        actual_input: 120,
        actual_output: 60,
        usage_unknown: 0,
        cost_estimate: 0.01,
        currency: "USD",
        created_at: "2026-01-01T00:00:00.000Z",
        settled_at: "2026-01-01T00:00:01.000Z",
      });
    });
    const response = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const budgets = (response.json() as {
      readonly budgets: ReadonlyArray<{
        readonly scope: string;
        readonly key: string;
        readonly used: number;
        readonly limit: number | null;
        readonly unit: string;
      }>;
    }).budgets;
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ scope: "purpose", key: "agent-turn", unit: "tokens", limit: null });
    // 已结算条目按实际用量计入：120 + 60。
    expect(budgets[0]?.used).toBe(180);
  });

  it("HTTP 错误响应携带可在 trace_spans 中查到的 traceId", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    const response = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline?limit=201",
      headers,
    });
    expect(response.statusCode).toBe(400);
    const error = errorResponseSchema.parse(response.json()).error;
    expect(error.traceId).not.toBeNull();
    expect(error.traceId).toMatch(/^trc-/);
    // traceId 必须真的关联到已记录的请求 span，否则只是换了一个非空值。
    const stored = host.storage.transact((tx) =>
      tx.rows("trace_spans").list({ trace_id: String(error.traceId) }),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]).toMatchObject({ trace_id: error.traceId, name: "http.request" });
  });

  it("每个错误响应使用各自的 traceId，不跨请求复用", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const session = await loginSession(host, "console-token");
    const request = async (): Promise<string | null> => {
      const response = await host.app.inject({
        method: "GET",
        url: "/api/v1/console/timeline?order=sideways",
        headers: { authorization: `Bearer ${session}`, "x-active-role": "researcher" },
      });
      expect(response.statusCode).toBe(400);
      return errorResponseSchema.parse(response.json()).error.traceId;
    };
    const first = await request();
    const second = await request();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("未携带 traceId 的领域错误回落到本次请求的 traceId", { timeout: 30_000 }, async () => {
    const host = await hostsWithCampaign();
    const headers = await researcherHeaders(host);
    // 未知装配 ID 走领域错误的 not-found 分支；错误本身不带 traceId，因此回落到请求 trace。
    const missing = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/assemblies/unknown-assembly",
      headers,
    });
    expect(missing.statusCode).toBe(404);
    const error = errorResponseSchema.parse(missing.json()).error;
    expect(error.code).toBe("not-found");
    expect(error.traceId).toMatch(/^trc-/);
    const stored = host.storage.transact((tx) =>
      tx.rows("trace_spans").list({ trace_id: String(error.traceId) }),
    );
    expect(stored.length).toBeGreaterThan(0);
  });
});
