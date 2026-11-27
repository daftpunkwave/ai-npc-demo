/**
 * 核心职责：测量模型证据归档的落盘字节、随轮次增长与启动清理查询计划。
 * 交互契约：经真实存储、预算、观测与共享模型池模块，用确定性传输产出多轮尝试证据。
 * 约束与禁忌：只在临时目录写入，禁止触碰开发存档、发起外部模型请求或修改证据契约。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverModuleDefinitions } from "@world-prism/app-server";
import { canonicalJson, type HostServices, type Json, type ModelFixture, type StoragePort } from "@world-prism/contracts";
import type { NormalizedMessage } from "@world-prism/contracts";
import type { AgentModelPoolPort, ModelCallInput, ModelRoute, ModelWorkScope } from "@world-prism/module-sdk";

const dataDir = mkdtempSync(join(tmpdir(), "world-prism-archive-measure-"));

let sequence = 0;
const host = {
  ids: (prefix: string) => `${prefix}-${String(++sequence).padStart(12, "0")}`,
  monotonicMs: () => sequence,
  sleep: async () => undefined,
  hash: async (value: Json) => createHash("sha256").update(canonicalJson(value)).digest("hex"),
  hashText: async (text: string) => createHash("sha256").update(text).digest("hex"),
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  nowIso: () => "2026-01-01T00:00:00.000Z",
} as unknown as HostServices;

const toolSchema: Json = {
  type: "object",
  properties: { nodeId: { type: ["string", "null"], description: "要检视的节点" } },
  required: ["nodeId"], additionalProperties: false,
};

/** 每轮都返回同一条检视工具调用，制造可比较的多轮请求增长。 */
const fixtures: ModelFixture[] = [
  {
    id: "round-one-inspect", match: { purpose: "decision", round: 1 },
    response: { finishReason: "tool_calls", toolCalls: [{ name: "world_inspect", arguments: { nodeId: "pass" } }] },
  },
  {
    id: "round-two-inspect", match: { purpose: "decision", round: 2 },
    response: { finishReason: "tool_calls", toolCalls: [{ name: "world_inspect", arguments: { nodeId: "pass" } }] },
  },
  {
    id: "round-three-submit", match: { purpose: "decision", round: 3 },
    response: { finishReason: "tool_calls", toolCalls: [{ name: "decision_submit", arguments: {
      stance: "none", dialogueIntent: { kind: "acknowledge", audience: ["player-1"], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
      noteworthy: [], citedMemoryIds: [], decisionNote: "measure",
    } }] },
  },
];

const route: ModelRoute = {
  agentId: "human-independent", purpose: "decision", modelId: "npc-fixture", connectionId: "fixtures",
  adapterId: "platform.model-transport.deterministic", externalModel: "deterministic-v1", endpoint: null,
  credentialRef: null, fixtureRows: fixtures, rateLimitKey: "fixtures", parameters: {},
  capabilities: {
    toolCalling: true, strictTools: true, structuredOutput: "json_schema", assistantReplay: "verbatim",
    contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null,
  },
  configHash: "fixture-route", maxConcurrent: 1, maxOutputTokens: 100, requestTimeoutMs: 10_000,
  requestsPerMinute: 10, tokensPerMinute: 100_000,
  price: { inputPerMTok: 1, outputPerMTok: 2, currency: "USD" },
};

const scope: ModelWorkScope = {
  worldId: "wld-000000000001", branchId: "br-000000000001", runId: "run-000000000001",
  agentId: route.agentId, workRef: "turn-000000000001", traceId: "trc-000000000001", worldTick: 26,
  triggerPrincipalIds: ["player-1"], maxModelCalls: 6, maxDailyTokens: 60_000, deadlineMs: 90_000,
  signal: new AbortController().signal, fence: () => true,
};

/**
 * 构造第 round 轮请求。后续轮次累积此前的 assistant 工具调用与 tool 结果，
 * 让归档字节反映真实的多轮决策历史，而不是每轮都从同一条 user 消息开始。
 */
function callInput(round: number, history: readonly NormalizedMessage[] = []): ModelCallInput {
  return {
    system: "你是砾火同盟的党魁，只能依据授权资料行动。".repeat(4),
    messages: [{ role: "user", content: "请检视隘口，然后提交决策。" }, ...history],
    tools: [{ name: "world_inspect", description: "读取节点状态", inputSchema: toolSchema }],
    output: { kind: "text" }, inputLimit: 30_000, round,
  };
}

/** 一轮往返之后的完整消息历史：assistant 发起工具调用，tool 返回检视结果。 */
function appendRound(history: readonly NormalizedMessage[], round: number): NormalizedMessage[] {
  const callId = `fixture-${round}-1`;
  return [
    ...history,
    { role: "assistant", content: null, providerReplay: null, toolCalls: [{
      id: callId, name: "world_inspect", arguments: { nodeId: "pass" },
      argumentsRaw: '{"nodeId":"pass"}', parseError: null,
    }] },
    { role: "tool", toolCallId: callId, content: JSON.stringify({ nodeId: "pass", supply: 30, energy: 10, medical: 4 }), isError: false },
  ];
}

function bytesOf(value: unknown): number {
  return value instanceof Uint8Array ? value.byteLength : 0;
}

async function createModule(moduleId: string, ports: Readonly<Record<string, unknown>>, config: Json = {}) {
  const definition = serverModuleDefinitions.find(({ id }) => id === moduleId);
  if (definition === undefined) throw new Error(`缺少 ${moduleId} 描述符`);
  const instance = await definition.create({
    moduleId: definition.id, realm: "server", config, scope: {}, ports, host,
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  return instance;
}

async function main() {
  const storageInstance = await createModule("platform.storage.sqlite", {}, { dataDir });
  const storage = storageInstance.port as StoragePort;
  const spanAttrs: Json[] = [];
  try {
    const budget = await createModule("platform.budget.standard", { "platform.storage": storage });
    const pool = await createModule("agent.model-pool.shared", {
      "platform.storage": storage,
      "platform.budget": budget.port,
      "platform.secrets": { resolve: () => null },
      "platform.observability": { recordSpan: (span: { attrs: Json }) => { spanAttrs.push(span.attrs); } },
      ...(await transportPorts()),
    });
    const run = (pool.port as AgentModelPoolPort).bindRun({
      routes: [route], limits: { maxTokens: null, maxCost: null },
    });
    const rounds: { round: number; requestBytes: number; responseBytes: number; totalBytes: number }[] = [];
    let history: readonly NormalizedMessage[] = [];
    for (let round = 1; round <= 3; round += 1) {
      const result = await run.call(scope, "decision", 100, callInput(round, history));
      history = appendRound(history, round);
      const attemptId = result.attempts.at(-1)?.attemptId;
      const row = storage.transact((tx) => tx.rows("model_attempts").get({ attempt_id: String(attemptId) }));
      const artifacts = storage.transact((tx) => ({
        request: tx.rows("artifacts").get({ artifact_id: String(row?.["request_artifact_id"]) }),
        response: tx.rows("artifacts").get({ artifact_id: String(row?.["response_artifact_id"]) }),
      }));
      rounds.push({
        round,
        requestBytes: bytesOf(artifacts.request?.["body"]),
        responseBytes: bytesOf(artifacts.response?.["body"]),
        totalBytes: bytesOf(artifacts.request?.["body"]) + bytesOf(artifacts.response?.["body"]),
      });
    }

    // 启动清理：造一条未结算预留与一条 started 尝试，核对两条恢复查询的计划。
    storage.transact((tx) => {
      tx.rows("budget_ledger").put({
        entry_id: "att-crashed", run_id: scope.runId, agent_id: scope.agentId, work_ref: scope.workRef,
        purpose: "decision", model_id: route.modelId, world_day: 2, reserved_input: 40, reserved_output: 60,
        actual_input: null, actual_output: null, usage_unknown: 1, cost_estimate: 0, currency: "USD",
        created_at: host.nowIso(), settled_at: null,
      });
    });
    const cleanupPlan = storage.transact((tx) => tx.all(
      "EXPLAIN QUERY PLAN UPDATE budget_ledger SET actual_input = reserved_input WHERE settled_at IS NULL", []));
    const recoveryPlan = storage.transact((tx) => tx.all(
      "EXPLAIN QUERY PLAN SELECT * FROM model_attempts WHERE status = 'started'", []));
    const artifactBytes = storage.transact((tx) => tx.all(
      "SELECT kind, COUNT(*) AS rows, SUM(LENGTH(body)) AS bytes FROM artifacts GROUP BY kind ORDER BY kind", []));

    const growth = rounds.map((entry, index) => ({
      round: entry.round,
      totalBytes: entry.totalBytes,
      deltaFromPreviousRound: index === 0 ? 0 : entry.totalBytes - (rounds[index - 1]?.totalBytes ?? 0),
    }));

    console.log(JSON.stringify({
      sample: {
        rounds,
        growth,
        artifactBytesByKind: artifactBytes,
        spanCount: spanAttrs.length,
        spanAttrsBytes: spanAttrs.reduce<number>((sum, attrs) => sum + Buffer.byteLength(JSON.stringify(attrs), "utf8"), 0),
      },
      startupCleanupQueryPlan: cleanupPlan,
      attemptRecoveryQueryPlan: recoveryPlan,
    }, null, 2));
  } finally {
    await storageInstance.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function transportPorts() {
  const definition = serverModuleDefinitions.find(({ id }) => id === "platform.model-transport.deterministic");
  if (definition === undefined) throw new Error("缺少确定性传输描述符");
  const instance = await definition.create({
    moduleId: definition.id, realm: "server", config: {}, scope: {}, ports: {}, host,
    signal: new AbortController().signal,
  });
  return { "platform.model-transport": [instance.port] };
}

await main();
