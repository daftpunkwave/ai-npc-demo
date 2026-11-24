/**
 * 核心职责：验证单个身份的摄入失败只隔离该身份，同轮其他身份照常摄入、turn 调度照常执行，并在恢复后清除降级。
 * 交互契约：使用真实 SQLite、假宿主、真实内容包与两个名册身份；其中一个身份挂载会抛错的记忆模块替身。
 * 约束与禁忌：禁止依赖真实计时器等待，也禁止用直接写入记忆行代替宿主摄入路径。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "@ai-npc/agent-runtime";
import type { ModuleDefinition, StoragePort } from "@ai-npc/contracts";
import type { MemoryPort, SchedulingPort } from "@ai-npc/module-sdk";
import { loadContentPack, type ResolvedAgentProfile, type Roster } from "@ai-npc/experiment";
import { memoryNoneModuleDefinition } from "@ai-npc/mod-agent-memory-none";
import { perceptionModuleDefinition } from "@ai-npc/mod-agent-perception-local";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { createFakeHost, type FakeHost } from "./authority-support";

const resources: { readonly dispose: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.dispose();
});

const worldId = "wld-000000000001";
const branchId = "br-000000000001";
const runId = "run-000000000001";
const healthyAgentId = "npc-wenyuan";
const failingAgentId = "npc-muzhi";

/** 可切换的故障开关：Proxy 每次调用时读取，用于验证恢复后同一实例重新工作。 */
interface FailureSwitch {
  failing: boolean;
  /** 只让唤醒建议失败，用来区分「摄入失败」与「唤醒失败」两条隔离路径。 */
  failWakeups: boolean;
}

/**
 * 在既有无长期记忆模块外再包一层 Proxy，只让 prepareIngest 在开关打开时抛错。
 * 其余端口方法照常委托，保证失败来自摄入阶段而不是模块初始化。
 */
function throwingMemoryDefinition(control: FailureSwitch): ModuleDefinition {
  return {
    ...memoryNoneModuleDefinition,
    id: "agent.memory.throwing",
    create: async (input) => {
      const instance = await memoryNoneModuleDefinition.create(input);
      const port = instance.port as MemoryPort;
      return {
        ...instance,
        port: new Proxy(port, {
          get(target, key) {
            if (key === "prepareIngest") {
              return (...args: Parameters<MemoryPort["prepareIngest"]>) => {
                if (control.failing) throw new Error("记忆摄入替身按用例要求失败");
                return target.prepareIngest(...args);
              };
            }
            if (key === "proposeWakeups") {
              return (...args: Parameters<MemoryPort["proposeWakeups"]>) => {
                if (control.failWakeups) throw new Error("唤醒建议替身按用例要求失败");
                return target.proposeWakeups(...args);
              };
            }
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
    },
  };
}

function profileWithMemory(memoryModuleId: string): ResolvedAgentProfile {
  return {
    profileId: "agent-runtime-isolation-profile",
    sourceChain: ["test"],
    budgets: {
      maxModelCallsPerTurn: 6,
      maxDecisionRounds: 4,
      maxToolCallsPerTurn: 8,
      maxToolCallsPerRound: 3,
      maxTurnMs: 90000,
      maxReplans: 1,
      maxTokensPerAgentPerDay: 60000,
      reserveOutputTokens: { decision: 1500, speech: 400, "memory-maintenance": 800 },
    },
    readiness: { requireDurable: true, requireDerived: true, waitTimeoutMs: 120000, onlineDegradeAfterMs: 10000 },
    speech: { maxChars: 80 },
    failurePolicy: "strict",
    scheduling: { module: "agent.scheduling.fair", config: {} },
    slots: {
      perception: { module: "agent.perception.local", config: {} },
      memory: { module: memoryModuleId, config: {} },
      context: { module: "agent.context.ordered-blocks", config: {} },
      compression: { module: "agent.compression.none", config: {} },
      toolView: { module: "agent.tool-view.structured", config: {} },
      decision: { module: "agent.decision.deterministic", config: {} },
    },
  };
}

const roster: Roster = {
  schemaVersion: 1,
  rosterId: "agent-runtime-isolation",
  agents: [
    { agentId: healthyAgentId, kind: "strategic", profileRef: "agent-runtime-isolation-profile", toolsetRef: "strategic-default" },
    { agentId: failingAgentId, kind: "strategic", profileRef: "agent-runtime-isolation-profile", toolsetRef: "strategic-default" },
  ],
};

type PlanMock = ReturnType<typeof vi.fn<SchedulingPort["plan"]>>;

interface IsolationFixture {
  readonly storage: StoragePort;
  readonly host: FakeHost;
  readonly runtime: AgentRuntime;
  readonly plan: PlanMock;
  readonly control: FailureSwitch;
}

/** 启动真实存储与两个身份的运行时时；默认故障开关关闭，保证启动轮成功。 */
async function fixture(initial: Partial<FailureSwitch> = {}): Promise<IsolationFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-runtime-isolation-"));
  const host = createFakeHost();
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  const storage = instance.port as StoragePort;
  storage.transact((tx) => {
    tx.rows("worlds").put({
      world_id: worldId,
      pack_id: "earth-2964-v1",
      content_version: "0.2.0",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.rows("branches").put({
      branch_id: branchId,
      world_id: worldId,
      kind: "online",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: null,
      run_id: null,
      profile_hash: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const branch = tx.branch(branchId);
    branch.table("clock").put({
      world_tick: 0,
      mode: "running",
      seconds_per_tick: 20,
      run_version: 0,
      step_target_tick: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    for (const agentId of [healthyAgentId, failingAgentId]) {
      branch.table("agent_activations").put({
        agent_id: agentId,
        status: "active",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      branch.table("controller_leases").put({
        agent_id: agentId,
        controller_kind: "agent",
        controller_principal_id: null,
        controller_epoch: 1,
        lease_expires_at: null,
      });
    }
  });
  resources.push({
    dispose: async () => {
      await instance.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });

  const control: FailureSwitch = { failing: false, failWakeups: false, ...initial };
  const plan = vi.fn<SchedulingPort["plan"]>(() => []);
  const runtime = new AgentRuntime({
    storage,
    host,
    content: loadContentPack("content", "earth-2964-v1"),
    roster,
    profiles: new Map([
      [healthyAgentId, profileWithMemory(memoryNoneModuleDefinition.id)],
      [failingAgentId, profileWithMemory("agent.memory.throwing")],
    ]),
    moduleDefinitions: new Map([
      [perceptionModuleDefinition.id, perceptionModuleDefinition],
      [memoryNoneModuleDefinition.id, memoryNoneModuleDefinition],
      ["agent.memory.throwing", throwingMemoryDefinition(control)],
    ]),
    scheduling: { plan },
    maxConcurrentTurns: 1,
    worldId,
    branchId,
    runId,
    readWorlds: (agentIds) => new Map(agentIds.map((agentId) => [agentId, {
      nodeId: "grayharbor",
      factionId: "human-neutral",
      worldViewText: "",
      affairsText: "",
    }])),
  });
  // 启动轮也要能被故障命中：先播种一条观察，再启动。
  if (initial.failing === true) seedObservations({ storage, host, runtime, plan, control }, 0);
  await runtime.start();
  resources.push({ dispose: () => runtime.dispose() });
  return { storage, host, runtime, plan, control };
}

/** 启动首轮就带单主体故障的夹具：故障在 start() 之前生效。 */
async function startWithFailingFirstCycle(): Promise<IsolationFixture> {
  return fixture({ failing: true });
}

/** 为每个身份写入一条待摄入观察；观察是摄入路径的唯一输入。 */
function seedObservations(value: IsolationFixture, tick: number): void {
  value.storage.transact((tx) => {
    const observations = tx.branch(branchId).table("observations");
    for (const [index, agentId] of [healthyAgentId, failingAgentId].entries()) {
      observations.put({
        agent_id: agentId,
        observation_seq: 1,
        observation_id: `obs-${String(index + 1).padStart(12, "0")}`,
        source_event_ids_json: [`evt-${String(index + 1).padStart(12, "0")}`],
        source_observation_ids_json: [],
        occurred_at_tick: tick,
        sensed_at_tick: tick,
        known_at_tick: tick,
        channel: "party",
        epistemic: "witnessed",
        confidence: 1,
        release_policy_id: "parties:human-neutral",
        content_json: { eventType: "AgreementBreached", summaryZh: "隔离用例观察", detail: "full" },
      });
    }
  });
}

function watermark(value: IsolationFixture, agentId: string): Readonly<Record<string, unknown>> | null {
  return value.storage.transact((tx) =>
    tx.branch(branchId).table("memory_watermarks").get({ agent_id: agentId }));
}

describe("Agent runtime 单主体故障隔离", () => {
  it("一个身份摄入失败时不中断其他身份的摄入与 turn 调度", async () => {
    const value = await fixture();
    seedObservations(value, 0);
    const scheduledBefore = value.plan.mock.calls.length;
    value.control.failing = true;

    const failure = await value.runtime.pump().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(failingAgentId);
    // 聚合错误带阶段名，便于定位失败发生在摄入而不是调度。
    expect((failure as Error).message).toContain("memory.ingestAll");

    // 健康身份照常摄入：水位推进到第一条观察，没有被同轮的失败拖停。
    expect(watermark(value, healthyAgentId)).toMatchObject({
      revision: 1,
      observation_seq_consumed: 1,
    });
    // 失败身份停在 0，下一轮只需重试自己的队列。
    expect(watermark(value, failingAgentId)).toMatchObject({
      revision: 0,
      observation_seq_consumed: 0,
    });
    // 摄入阶段失败仍在同一轮执行到调度：计划端口没有被跳过。
    expect(value.plan.mock.calls.length).toBe(scheduledBefore + 1);
    // 失败按身份记录到宿主日志，而不是静默吞掉。
    expect(value.host.logs).toContainEqual(expect.objectContaining({
      level: "error",
      message: "Memory ingest failed",
      data: expect.objectContaining({ agentId: failingAgentId, phase: "memory-ingest" }),
    }));
  });

  it("失败后进入 degraded，恢复成功后清除降级并记录恢复", async () => {
    const value = await fixture();
    seedObservations(value, 0);
    value.control.failing = true;
    await expect(value.runtime.pump()).rejects.toThrow(failingAgentId);
    expect(value.runtime.degraded).toBe(true);

    value.control.failing = false;
    await expect(value.runtime.pump()).resolves.toBeUndefined();
    expect(value.runtime.degraded).toBe(false);
    expect(watermark(value, failingAgentId)).toMatchObject({
      revision: 1,
      observation_seq_consumed: 1,
    });
    expect(value.host.logs).toContainEqual(expect.objectContaining({
      level: "info",
      message: "Agent runtime recovered",
      data: expect.objectContaining({ consecutiveFailures: 0 }),
    }));
  });

  it("唤醒建议失败同样让该轮失败并进入 degraded，而不是被当成成功轮", async () => {
    const value = await fixture();
    // 只让 proposeWakeups 失败：摄入正常，因此失败只能来自唤醒阶段。
    // 若唤醒失败被静默吞掉，这一轮会被当成成功轮，degraded 永远不会置位。
    value.control.failWakeups = true;

    const failure = await value.runtime.pump().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("memory.proposeDueWakeups");
    expect(value.runtime.degraded).toBe(true);
    expect(value.host.logs).toContainEqual(expect.objectContaining({
      level: "error",
      message: "Memory wakeup proposal failed",
      data: expect.objectContaining({ agentId: failingAgentId, phase: "memory-wakeups" }),
    }));

    value.control.failWakeups = false;
    await expect(value.runtime.pump()).resolves.toBeUndefined();
    expect(value.runtime.degraded).toBe(false);
  });

  it("启动后首轮单主体故障只进入降级与退避，不销毁整个 runtime", async () => {
    // 启动轮之前就让失败身份开始抛错：首轮必须容错，否则 startup 会把整个
    // runtime 连带其余身份的摄入与调度一起拆掉。
    const value = await startWithFailingFirstCycle();

    expect(value.runtime.degraded).toBe(true);
    const firstCycle = value.host.logs.find((entry) => entry.message === "Agent runtime first cycle failed");
    expect(firstCycle?.data).toEqual({ phases: ["memory.ingestAll"] });
    // 日志只记阶段名，不写错误原文：错误原文可能含观察正文或对话原文。
    expect(JSON.stringify(firstCycle?.data)).not.toContain("替身按用例要求失败");
    // runtime 仍可继续服务：关掉故障后下一轮成功并清除降级。
    value.control.failing = false;
    await expect(value.runtime.pump()).resolves.toBeUndefined();
    expect(value.runtime.degraded).toBe(false);
    expect(watermark(value, healthyAgentId)?.revision).toBe(1);
  });

  it("失败日志按统一口径记录结构化字段，不把原始错误文本整段带入", async () => {
    const value = await fixture();
    seedObservations(value, 0);
    value.control.failing = true;

    await expect(value.runtime.pump()).rejects.toThrow(failingAgentId);

    const logged = value.host.logs.find((entry) =>
      entry.level === "error" && entry.message === "Memory ingest failed");
    expect(logged?.data).toMatchObject({
      agentId: failingAgentId,
      phase: "memory-ingest",
      errorCode: "Error",
    });
    // 只记录结构化字段：错误原文属自由文本，可能含观察正文或对话原文，不得进日志。
    const data = logged?.data as Readonly<Record<string, unknown>> | undefined;
    expect(data).not.toHaveProperty("detail");
    expect(data).not.toHaveProperty("message");
  });
});
