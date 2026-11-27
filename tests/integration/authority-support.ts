/**
 * authority 集成测试的隔离数据库、确定性宿主、分支初始化与命令构造助手。
 * 依赖真实 SQLite 存储模块、authority 门面、公共契约与 node 临时目录；每个测试使用独立数据目录。
 * 禁止复用测试之间的连接或分支状态，也不在助手里断言业务规则。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  canonicalJson,
  jsonValueSchema,
  type AuthContext,
  type CommandEnvelope,
  type CommandType,
  type HostServices,
  type Json,
  type ModuleCreateInput,
  type StoragePort,
} from "@world-prism/contracts";
import { Authority } from "@world-prism/authority";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import type { ApprovedSpeechReader } from "@world-prism/module-sdk";

const idAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const startIso = "2026-01-01T00:00:00.000Z";

function encodeId(value: number): string {
  let remaining = value;
  let text = "";
  for (let index = 0; index < 12; index += 1) {
    text = `${idAlphabet[remaining % idAlphabet.length]}${text}`;
    remaining = Math.floor(remaining / idAlphabet.length);
  }
  return text;
}

/** 收集的宿主日志；测试不依赖控制台输出。 */
export interface CapturedLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Json;
}

/** 确定性宿主：ID、时间、随机源与哈希都可复现。 */
export interface FakeHost extends HostServices {
  readonly logs: CapturedLog[];
}

export function createFakeHost(): FakeHost {
  const logs: CapturedLog[] = [];
  let idCounter = 0;
  let timeCounter = 0;
  const start = Date.parse(startIso);
  return {
    logs,
    ids: (prefix) => {
      idCounter += 1;
      return `${prefix}-${encodeId(idCounter)}`;
    },
    nowIso: () => {
      const value = new Date(start + timeCounter * 1000).toISOString();
      timeCounter += 1;
      return value;
    },
    monotonicMs: () => timeCounter * 10,
    sleep: async () => {
      // authority 的事务内处理器不等待；空实现保持宿主契约完整。
    },
    rng: (...parts) => {
      let state = 0;
      for (const part of parts.join(":")) {
        state = (Math.imul(state, 31) + part.charCodeAt(0)) >>> 0;
      }
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    },
    hash: async (value) => createHash("sha256").update(canonicalJson(value)).digest("hex"),
    hashText: async (text) => createHash("sha256").update(text).digest("hex"),
    logger: {
      info: (message, data) => {
        logs.push(data === undefined ? { level: "info", message } : { level: "info", message, data });
      },
      warn: (message, data) => {
        logs.push(data === undefined ? { level: "warn", message } : { level: "warn", message, data });
      },
      error: (message, data) => {
        logs.push(data === undefined ? { level: "error", message } : { level: "error", message, data });
      },
    },
    tracer: {
      span: <T>(_name: string, _attrs: Json, fn: () => T): T => fn(),
    },
  };
}

export interface AuthorityHarness {
  readonly dataDir: string;
  readonly storage: StoragePort;
  readonly host: FakeHost;
  readonly authority: Authority;
  readonly worldId: string;
  readonly branchId: string;
  dispose(): Promise<void>;
}

export interface AuthorityHarnessOptions {
  readonly allowDirectAgentCommands?: boolean;
  readonly approvedSpeech?: ApprovedSpeechReader;
}

/** 启动真实存储并初始化一个在线分支与时钟。 */
export async function createAuthorityHarness(options: AuthorityHarnessOptions = {}): Promise<AuthorityHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), "world-prism-authority-test-"));
  const host = createFakeHost();
  const worldId = "wld-000000000000";
  const branchId = "br-000000000000";
  const signal = new AbortController().signal;
  const input: ModuleCreateInput = {
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal,
  };
  const instance = await storageModuleDefinition.create(input);
  try {
    await instance.start(signal);
    const port = instance.port;
    if (port === undefined) {
      throw new Error("存储模块实例没有暴露端口");
    }
    const storage = port as StoragePort;
    seedBranch(storage, host, worldId, branchId);
    const authority = new Authority({
      storage,
      host,
      allowDirectAgentCommands: options.allowDirectAgentCommands,
      approvedSpeech: options.approvedSpeech,
    });
    return {
      dataDir,
      storage,
      host,
      authority,
      worldId,
      branchId,
      dispose: async () => {
        await instance.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await instance.dispose();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

function seedBranch(storage: StoragePort, host: FakeHost, worldId: string, branchId: string): void {
  storage.transact((tx) => {
    const createdAt = host.nowIso();
    tx.rows("worlds").put({
      world_id: worldId,
      pack_id: "authority-test",
      content_version: "1",
      created_at: createdAt,
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
      created_at: createdAt,
    });
    tx.branch(branchId)
      .table("clock")
      .put({
        world_tick: 0,
        mode: "running",
        seconds_per_tick: 1,
        run_version: 0,
        step_target_tick: null,
        updated_at: createdAt,
      });
  });
}

export function setClock(
  harness: AuthorityHarness,
  clock: { readonly worldTick: number; readonly mode: "running" | "pausing" | "paused" | "resuming" | "stepping" },
): void {
  harness.storage.transact((tx) => {
    tx.branch(harness.branchId)
      .table("clock")
      .put({
        world_tick: clock.worldTick,
        mode: clock.mode,
        seconds_per_tick: 1,
        run_version: 1,
        step_target_tick: null,
        updated_at: harness.host.nowIso(),
      });
  });
}

export function setBranchStatus(harness: AuthorityHarness, status: "active" | "paused" | "frozen" | "archived"): void {
  harness.storage.transact((tx) => {
    const row = tx.rows("branches").get({ branch_id: harness.branchId });
    if (row === null) {
      throw new Error("测试分支不存在");
    }
    tx.rows("branches").put({ ...row, status });
  });
}

export function readAggregate(
  harness: AuthorityHarness,
  aggregateType: string,
  aggregateId: string,
): { readonly version: number; readonly state: Json } | null {
  return harness.storage.transact((tx) => {
    const row = tx.branch(harness.branchId).table("aggregate_state").get({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
    });
    if (row === null) {
      return null;
    }
    const version = row["version"];
    const state = row["state_json"];
    if (typeof version !== "number" || state === undefined) {
      throw new Error("测试聚合行字段不完整");
    }
    const parsedState = jsonValueSchema.safeParse(state);
    if (!parsedState.success) {
      throw new Error("测试聚合状态不是合法 JSON");
    }
    return { version, state: parsedState.data };
  });
}

export function countBranchRows(
  harness: AuthorityHarness,
  table: string,
  filter: Record<string, string | number | null> = {},
): number {
  return harness.storage.transact((tx) => tx.branch(harness.branchId).table(table).count(filter));
}

export function deleteConsumerOffset(harness: AuthorityHarness, consumerId: string): void {
  harness.storage.transact((tx) => {
    tx.branch(harness.branchId).table("consumer_offsets").delete({ consumer_id: consumerId });
  });
}

export function seedAgentController(
  harness: AuthorityHarness,
  agentId: string,
  controllerEpoch: number,
  kind: "agent" | "human" = "agent",
  leaseExpiresAt: string | null = null,
): void {
  harness.storage.transact((tx) => {
    tx.branch(harness.branchId)
      .table("controller_leases")
      .put({
        agent_id: agentId,
        controller_kind: kind,
        controller_principal_id: null,
        controller_epoch: controllerEpoch,
        lease_expires_at: leaseExpiresAt,
      });
  });
}

export function seedTurnRun(
  harness: AuthorityHarness,
  turnId: string,
  agentId: string,
  controllerEpoch: number,
  turnLeaseEpoch: number,
  status: "queued" | "executing" | "completed" | "failed" | "cancelled" | "budget-exhausted",
  leaseExpiresAt: string | null = null,
): void {
  harness.storage.transact((tx) => {
    tx.rows("turn_runs").put({
      turn_id: turnId,
      run_id: "run-000000000000",
      branch_id: harness.branchId,
      agent_id: agentId,
      agent_turn_index: 1,
      status,
      trigger_ids_json: [],
      input_frontier_json: null,
      memory_revision: null,
      profile_hash: "test-profile",
      controller_epoch: controllerEpoch,
      turn_lease_epoch: turnLeaseEpoch,
      lease_expires_at: leaseExpiresAt,
      terminal_reason: null,
      effective_json: null,
      created_at: harness.host.nowIso(),
      started_at: null,
      ended_at: null,
    });
  });
}

export function playerAuth(harness: AuthorityHarness): AuthContext {
  return {
    principalId: "player-1",
    kind: "player",
    roles: ["player"],
    worldId: harness.worldId,
    branchId: harness.branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
  };
}

export function systemAuth(harness: AuthorityHarness): AuthContext {
  return {
    principalId: "system:world",
    kind: "system",
    roles: [],
    worldId: harness.worldId,
    branchId: harness.branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
  };
}

export function agentAuth(harness: AuthorityHarness, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principalId: "npc-wenyuan",
    kind: "agent",
    roles: ["agent"],
    worldId: harness.worldId,
    branchId: harness.branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
    ...overrides,
  };
}

export function commandEnvelope(
  type: CommandType,
  payload: Json,
  commandId: string,
  expectedVersions?: Readonly<Record<string, number>>,
): CommandEnvelope {
  return {
    commandId,
    type,
    schemaVersion: 1,
    ...(expectedVersions === undefined ? {} : { expectedVersions }),
    payload,
  };
}

export function taskCancelEnvelope(
  harness: AuthorityHarness,
  taskId: string,
  commandId: string = harness.host.ids("cmd"),
): CommandEnvelope {
  return commandEnvelope("task.cancel", { taskId }, commandId);
}

export function campaignStartEnvelope(
  harness: AuthorityHarness,
  commandId: string = harness.host.ids("cmd"),
): CommandEnvelope {
  return commandEnvelope("campaign.start", { factionId: "human-neutral" }, commandId);
}

/** 断言同步调用抛出指定错误码的领域错误。 */
export function expectDomainCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { readonly code?: string }).code).toBe(code);
}
