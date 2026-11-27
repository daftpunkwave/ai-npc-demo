/**
 * 核心职责：在真实 SQLite 上锁定观测数据源中事件、审计、artifact 与名册一侧的列到字段映射与筛选语义：
 *   authority 的时间线、分支事件、最新序号与命令回执，module-sdk 的生命周期审计与 artifact 正文，
 *   以及宿主从冻结 manifest 读取名册并组合 Agent 状态。
 * 交互契约：依赖存储模块执行真实迁移，夹具按各表所有者的写入形态预置行；名册 manifest 由宿主的 buildRunManifest 产出。
 * 约束与禁忌：不启动宿主、模型或调度器；筛选必须在查询内完成，断言以真实 limit 为准。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestEventSeq,
  listEventsAfter,
  listTimelineEvents,
  readCommandReceipt,
} from "@world-prism/authority";
import {
  buildRunManifest,
  createObservabilitySources,
  loadAssembly,
  resolveServerAssembly,
  rosterAgentKindsOf,
  serverModuleDefinitions,
} from "@world-prism/app-server";
import {
  canonicalJson,
  type CommandReceipt,
  type Json,
  type StoragePort,
  type StorageTransaction,
} from "@world-prism/contracts";
import { loadContentPack, loadRoster, loadRunSpec } from "@world-prism/experiment";
import { latestLifecycleEventByOperation, listLifecycleTimeline, readArtifactBody } from "@world-prism/module-sdk";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost } from "./authority-support";

const worldId = "wld-000000000001";
const branchId = "br-000000000001";
const runId = "run-000000000001";
const createdAt = "2026-01-01T00:00:00.000Z";

const resources: { readonly dispose: () => Promise<void>; readonly dataDir: string }[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.dispose();
    rmSync(resource.dataDir, { recursive: true, force: true });
  }
});

async function openStorage(): Promise<StoragePort> {
  const dataDir = mkdtempSync(join(tmpdir(), "observability-source-events-"));
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host: createFakeHost(),
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  resources.push({ dispose: () => instance.dispose(), dataDir });
  const storage = instance.port as StoragePort;
  storage.transact((tx) => {
    tx.rows("worlds").put({ world_id: worldId, pack_id: "test", content_version: "1.0.0", created_at: createdAt });
    tx.rows("branches").put({
      branch_id: branchId, world_id: worldId, kind: "experiment", status: "paused",
      parent_branch_id: null, forked_at_world_seq: null, run_id: runId, profile_hash: null, created_at: createdAt,
    });
    tx.rows("runs").put({
      run_id: runId, world_id: worldId, branch_id: branchId, mode: "audit", status: "running",
      run_spec_json: {}, manifest_json: null, manifest_hash: null, contaminated: 0, evidence_complete: 1,
      created_at: createdAt, started_at: createdAt, ended_at: null,
    });
  });
  return storage;
}

/** 以 authority 写入的列形态插入领域事件；JSON 列为文本。 */
function insertEvent(
  tx: StorageTransaction,
  event: { readonly seq: number; readonly type: string; readonly principalId: string; readonly payload: string },
): void {
  tx.run(
    `INSERT INTO domain_events (branch_id, world_seq, event_id, world_tick, type, schema_version,
                                principal_id, causation_ids_json, correlation_id, audience_json,
                                payload_json, committed_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, '[]', ?, '{"kind":"public"}', ?, ?)`,
    [
      branchId, event.seq, `evt-${String(event.seq).padStart(12, "0")}`, event.seq * 10, event.type,
      event.principalId, `cor-${String(event.seq).padStart(12, "0")}`, event.payload,
      `2026-01-01T00:00:${String(event.seq).padStart(2, "0")}.000Z`,
    ],
  );
}

function seedEvents(storage: StoragePort): void {
  storage.transact((tx) => {
    insertEvent(tx, { seq: 1, type: "TaskDispatched", principalId: "npc-wenzhao", payload: '{"nodeId":"node-gate"}' });
    insertEvent(tx, { seq: 2, type: "TaskDispatched", principalId: "player-1", payload: '{"teamIds":["npc-wenzhao"]}' });
    insertEvent(tx, { seq: 3, type: "MetersChanged", principalId: "npc-wenzhao", payload: '{"nodeId":"node-gate"}' });
    insertEvent(tx, { seq: 4, type: "TaskDispatched", principalId: "player-1", payload: '{"nodeId":"node-orchard"}' });
    insertEvent(tx, { seq: 5, type: "TaskDispatched", principalId: "npc-wenzhao", payload: '{"route":["node-gate"]}' });
  });
}

describe("authority 提供的观测事件查询", () => {
  it("时间线把每列解码为观测记录字段", async () => {
    const storage = await openStorage();
    seedEvents(storage);
    const [event] = storage.transact((tx) =>
      listTimelineEvents(tx, { branchId, afterSeq: 0, limit: 1, order: "asc" }));
    expect(event).toEqual({
      worldSeq: 1,
      worldTick: 10,
      eventId: "evt-000000000001",
      type: "TaskDispatched",
      principalId: "npc-wenzhao",
      audience: { kind: "public" },
      payload: { nodeId: "node-gate" },
      correlationId: "cor-000000000001",
      committedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("类型、主体或载荷提及、节点提及的筛选在查询内完成，limit 是筛选后的条数", async () => {
    const storage = await openStorage();
    seedEvents(storage);
    const seqs = (query: Parameters<typeof listTimelineEvents>[1]) =>
      storage.transact((tx) => listTimelineEvents(tx, query)).map((event) => event.worldSeq);

    // 主体为该 Agent，或载荷文本里提到它（2 号事件只在 teamIds 中出现）。
    expect(seqs({ branchId, afterSeq: 0, limit: 10, order: "asc", involving: "npc-wenzhao" })).toEqual([1, 2, 3, 5]);
    // 节点只按载荷文本匹配，数组内的文本同样命中。
    expect(seqs({ branchId, afterSeq: 0, limit: 10, order: "asc", mentioning: "node-gate" })).toEqual([1, 3, 5]);
    expect(seqs({
      branchId, afterSeq: 0, limit: 2, order: "desc",
      types: ["TaskDispatched"], involving: "npc-wenzhao", mentioning: "node-gate",
    })).toEqual([5, 1]);
    expect(seqs({ branchId, afterSeq: 3, limit: 10, order: "asc" })).toEqual([4, 5]);
  });

  it("分支事件按序号升序返回，最新序号在空分支上为 null", async () => {
    const storage = await openStorage();
    expect(storage.transact((tx) => latestEventSeq(tx, branchId))).toBeNull();
    seedEvents(storage);
    expect(storage.transact((tx) => latestEventSeq(tx, branchId))).toBe(5);
    expect(storage.transact((tx) => listEventsAfter(tx, branchId, 3)).map((event) => [event.worldSeq, event.payload]))
      .toEqual([[4, { nodeId: "node-orchard" }], [5, { route: ["node-gate"] }]]);
  });

  it("载荷不是合法 JSON 时以 invalid-state 指出表与列", async () => {
    const storage = await openStorage();
    storage.transact((tx) => insertEvent(tx, { seq: 1, type: "WorldEvent", principalId: "player-1", payload: "{broken" }));
    expect(() => storage.transact((tx) => listEventsAfter(tx, branchId, 0))).toThrow(expect.objectContaining({
      code: "invalid-state",
      safeMessage: "存储表 domain_events 的列 payload_json 不是合法 JSON 文本",
    }));
  });

  it("命令回执按分支、主体与命令 ID 读取并按契约校验", async () => {
    const storage = await openStorage();
    const receipt: CommandReceipt = {
      receiptId: "rcp-000000000001", commandId: "cmd-000000000001", commandStatus: "rejected",
      reasonCode: "invalid-params", safeMessage: "参数不合法", acceptedEventIds: [], operationId: null,
      resultingVersions: {}, result: null, worldTick: 3,
    };
    storage.transact((tx) => tx.branch(branchId).table("command_receipts").put({
      principal_id: "npc-wenzhao", command_id: receipt.commandId, command_type: "task.dispatch",
      payload_hash: "hash", receipt_json: receipt, created_at: createdAt,
    }));
    expect(storage.transact((tx) => readCommandReceipt(tx, branchId, "npc-wenzhao", receipt.commandId)))
      .toEqual(receipt);
    expect(storage.transact((tx) => readCommandReceipt(tx, branchId, "player-1", receipt.commandId))).toBeNull();
  });
});

describe("module-sdk 提供的审计与 artifact 查询", () => {
  function insertAudit(
    tx: StorageTransaction,
    audit: { readonly type: string; readonly subjectId: string | null; readonly payload: Json; readonly at: string },
  ): void {
    tx.run(
      "INSERT INTO lifecycle_events (run_id, branch_id, type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, branchId, audit.type, audit.subjectId, canonicalJson(audit.payload), audit.at],
    );
  }

  it("生命周期时间线解码各列，并在查询内按类型、主体或载荷提及筛选", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      insertAudit(tx, { type: "AgentActivated", subjectId: "npc-wenzhao", payload: {}, at: "2026-01-01T00:00:01.000Z" });
      insertAudit(tx, { type: "ClockAutoPaused", subjectId: null, payload: { agentIds: ["npc-wenzhao"] }, at: "2026-01-01T00:00:02.000Z" });
      insertAudit(tx, { type: "AgentActivated", subjectId: "player-1", payload: { nodeId: "node-gate" }, at: "2026-01-01T00:00:03.000Z" });
    });
    const read = (filter: Parameters<typeof listLifecycleTimeline>[1]) =>
      storage.transact((tx) => listLifecycleTimeline(tx, filter));

    const [first] = read({ branchId, limit: 1, order: "asc" });
    expect(first).toEqual({
      seq: expect.any(Number), type: "AgentActivated", subjectId: "npc-wenzhao", payload: {},
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(read({ branchId, limit: 10, order: "desc", involving: "npc-wenzhao" }).map((event) => event.type))
      .toEqual(["ClockAutoPaused", "AgentActivated"]);
    expect(read({ branchId, limit: 1, order: "desc", types: ["AgentActivated"] }).map((event) => event.subjectId))
      .toEqual(["player-1"]);
    expect(read({ branchId, limit: 10, order: "asc", mentioning: "node-gate" }).map((event) => event.subjectId))
      .toEqual(["player-1"]);
  });

  it("按 operationId 取同一 run 与分支内最近一条审计", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      insertAudit(tx, { type: "DebugWakeRequested", subjectId: "npc-wenzhao", payload: { operationId: "op-000000000001", reason: "旧" }, at: createdAt });
      insertAudit(tx, { type: "DebugWakeRequested", subjectId: "npc-wenzhao", payload: { operationId: "op-000000000001", reason: "新" }, at: createdAt });
      insertAudit(tx, { type: "DebugWakeRequested", subjectId: "npc-wenzhao", payload: { operationId: "op-000000000002", reason: "其他" }, at: createdAt });
    });
    const latest = (operationId: string) => storage.transact((tx) =>
      latestLifecycleEventByOperation(tx, { runId, branchId, type: "DebugWakeRequested", operationId }));
    expect(latest("op-000000000001")?.payload).toEqual({ operationId: "op-000000000001", reason: "新" });
    expect(latest("op-000000000003")).toBeNull();
  });

  it("artifact 正文在事务外按登记方式取回并带所属 run，不存在时为 null", async () => {
    const storage = await openStorage();
    const body = canonicalJson({ text: "你好", fallback: false });
    storage.transact((tx) => tx.rows("artifacts").put({
      artifact_id: "art-000000000001", run_id: runId, kind: "speech", content_hash: "hash", mime: "application/json",
      byte_size: new TextEncoder().encode(body).byteLength, storage: "inline", body: new TextEncoder().encode(body),
      file_path: null, redaction: "raw", redacted_from: null, created_at: createdAt,
    }));
    expect(readArtifactBody(storage, "art-000000000001")).toEqual({ runId, body });
    expect(readArtifactBody(storage, "art-000000000002")).toBeNull();
    // 超过内联上限的正文存放在文件中，同一查询从文件取回原文。
    const filed = canonicalJson({ text: "存放在文件中的正文" });
    const filePath = storage.artifactFiles.write("art-000000000003", new TextEncoder().encode(filed));
    storage.transact((tx) => tx.rows("artifacts").put({
      artifact_id: "art-000000000003", run_id: runId, kind: "model-request", content_hash: "hash", mime: "application/json",
      byte_size: new TextEncoder().encode(filed).byteLength, storage: "file", body: null,
      file_path: filePath, redaction: "raw", redacted_from: null, created_at: createdAt,
    }));
    expect(readArtifactBody(storage, "art-000000000003")).toEqual({ runId, body: filed });
  });
});

describe("宿主组合的名册与 Agent 状态", () => {
  async function frozenManifest() {
    const loadContext = { configDir: "config" };
    const content = loadContentPack("content", "earth-2964-v1");
    const roster = loadRoster("standard-15", loadContext).value;
    const built = await buildRunManifest({
      runSpec: loadRunSpec("online-default", loadContext, { seed: "seed", moduleAssemblyRef: "local-slg-standard-v1" }).value,
      content: { packId: content.pack.packId, contentVersion: content.pack.contentVersion },
      roster,
      resolved: await resolveServerAssembly(loadAssembly("local-slg-standard-v1"), serverModuleDefinitions),
    });
    return { manifest: built.manifest, roster };
  }

  it("从 buildRunManifest 冻结的 manifest 读回名册登记的全部 Agent 与种类", async () => {
    const { manifest, roster } = await frozenManifest();
    const kinds = rosterAgentKindsOf(manifest as unknown as Json);
    expect([...kinds.entries()]).toEqual(roster.agents.map((agent) => [agent.agentId, agent.kind]));
    expect(rosterAgentKindsOf(null).size).toBe(0);
  });

  it("Agent 状态只保留名册登记的 Agent，并经世界端口补齐位置", async () => {
    const storage = await openStorage();
    const { manifest, roster } = await frozenManifest();
    const character = roster.agents.find((agent) => agent.kind === "character");
    const strategic = roster.agents.find((agent) => agent.kind === "strategic");
    if (character === undefined || strategic === undefined) throw new Error("名册缺少两类 Agent");
    const sources = createObservabilitySources({
      storage,
      host: createFakeHost(),
      worldTick: () => {
        throw new Error("本用例不读取时钟");
      },
      worldIn: (_tx, scope) => {
        expect(scope).toEqual({ branchId, worldId });
        return {
          character: (agentId) => agentId === character.agentId
            ? { agentId, factionId: "faction", nodeId: "node-gate", injuredUntilTick: null, currentTaskId: null }
            : null,
        };
      },
    });
    storage.transact((tx) => {
      for (const agentId of [character.agentId, strategic.agentId, "agent-not-in-roster"]) {
        tx.branch(branchId).table("agent_activations").put({ agent_id: agentId, status: "active", updated_at: createdAt });
      }
    });
    // run 尚未冻结 manifest 时没有登记的 Agent。
    expect(sources.read((reader) => reader.agentStates(branchId))).toEqual([]);

    storage.transact((tx) => {
      const run = tx.rows("runs").get({ run_id: runId });
      if (run === null) throw new Error("缺少 run");
      tx.rows("runs").put({ ...run, manifest_json: manifest as unknown as Json });
    });
    const states = sources.read((reader) => reader.agentStates(branchId));
    expect(states.map(({ agentId, rosterKind, nodeId }) => ({ agentId, rosterKind, nodeId })))
      .toEqual([
        { agentId: character.agentId, rosterKind: "character", nodeId: "node-gate" },
        { agentId: strategic.agentId, rosterKind: "strategic", nodeId: null },
      // 与查询的 ORDER BY agent_id 一致按码位排序，不受区域排序规则影响。
      ].sort((left, right) => (left.agentId < right.agentId ? -1 : 1)));
  });
});
