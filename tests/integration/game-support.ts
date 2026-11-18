/**
 * 游戏模块集成测试的真实 SQLite 环境、内容适配器与端口绑定。
 * 依赖 SQLite 存储模块、内容加载器、authority、三个游戏模块与临时目录。
 * 禁止复用测试之间的数据库，也不在助手里放宽命令校验或伪造世界状态。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthContext,
  CommandEnvelope,
  CommandType,
  Json,
  ModuleCreateInput,
  StoragePort,
} from "@ai-npc/contracts";
import { Authority } from "@ai-npc/authority";
import { loadContentPack, type ContentPack } from "@ai-npc/experiment";
import type { GameContent, ModuleBinder, WorldTx } from "@ai-npc/module-sdk";
import { createMapContributor, createMapPort } from "@ai-npc/mod-game-map-six-nodes";
import { createCommsContributor, createCommsPort } from "@ai-npc/mod-game-comms-standard";
import { createActionsContributor, createActionsPort } from "@ai-npc/mod-game-actions-standard";
import { createAgreementsContributor, createAgreementsPort } from "@ai-npc/mod-game-agreements-standard";
import { createScenarioContributor, createScenarioPort } from "@ai-npc/mod-game-scenario-watergate";
import { createResourcesContributor, createResourcesPort } from "@ai-npc/mod-game-resources-light";
import { createWorldContributor, createWorldPort } from "@ai-npc/mod-game-world-slg-light";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { createFakeHost, type FakeHost } from "./authority-support";

/** 内存 WorldTx：供不依赖 authority 的模块端口测试使用。 */
export function createMemoryTx(worldTick = 0): WorldTx {
  const cells = new Map<string, Map<string, Json>>();
  let seq = 0;
  return {
    worldTick,
    get<TState>(aggregateType: string, aggregateId: string) {
      const state = cells.get(aggregateType)?.get(aggregateId);
      return state === undefined ? null : { version: 1, state: state as TState };
    },
    list<TState>(aggregateType: string) {
      return [...(cells.get(aggregateType) ?? new Map<string, Json>()).entries()].map(
        ([id, state]) => ({ id, version: 1, state: state as TState }),
      );
    },
    put(aggregateType: string, aggregateId: string, state: Json) {
      const bucket = cells.get(aggregateType) ?? new Map<string, Json>();
      bucket.set(aggregateId, state);
      cells.set(aggregateType, bucket);
    },
    remove(aggregateType: string, aggregateId: string) {
      cells.get(aggregateType)?.delete(aggregateId);
    },
    emit() {
      seq += 1;
      return `evt-${String(seq).padStart(12, "0")}`;
    },
    schedule() {
      // 端口测试不创建 job。
    },
    cancelJobs() {
      // 端口测试不取消 job。
    },
  };
}

export interface GameHarness {
  readonly dataDir: string;
  readonly storage: StoragePort;
  readonly host: FakeHost;
  readonly authority: Authority;
  readonly worldId: string;
  readonly branchId: string;
  readonly content: ContentPack;
  readonly gameContent: GameContent;
  dispose(): Promise<void>;
}

/** 把已校验内容包收窄为游戏端口视图；保留真实 Map 索引而不复制数据。 */
export function toGameContent(content: ContentPack): GameContent {
  return {
    nodes: content.index.nodes,
    roads: content.index.roads,
    factions: content.index.factions,
    characters: content.index.characters,
    stockpiles: content.index.stockpiles,
    teams: content.index.teams,
    groups: content.index.groups,
    evidence: content.index.evidence,
    secrets: content.index.secrets,
    starts: content.index.starts,
    scenarios: content.index.scenarios,
    defaultScenario: content.pack.defaultScenario,
    migrationRoads: content.map.migrationRoads,
    medicalFacilities: content.map.medicalFacilities,
    playerNodeId: content.worldInit.player.nodeId,
    playerPrincipalId: content.index.playerPrincipalId,
    chapterId: content.lore.chapter.id,
    initialMeters: content.worldInit.meters,
    dutyDelegations: content.worldInit.dutyDelegations,
  };
}

function seedBranch(storage: StoragePort, host: FakeHost, worldId: string, branchId: string): void {
  storage.transact((tx) => {
    const createdAt = host.nowIso();
    tx.rows("worlds").put({
      world_id: worldId,
      pack_id: "earth-2964-v1",
      content_version: "0.3.0",
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
    tx.branch(branchId).table("clock").put({
      world_tick: 0,
      mode: "running",
      seconds_per_tick: 10,
      run_version: 0,
      step_target_tick: null,
      updated_at: createdAt,
    });
  });
}

/** 启动真实存储、加载内容、绑定模块端口并注册游戏处理器。 */
export async function createGameHarness(options: {
  readonly approvedSpeech?: import("@ai-npc/module-sdk").ApprovedSpeechReader;
  readonly scenarioEscalating?: boolean;
} = {}): Promise<GameHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), "ai-npc-game-test-"));
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
    const content = loadContentPack("content", "earth-2964-v1");
    const gameContent = toGameContent(content);
    const binder: ModuleBinder = (txFor) => ({
      "game.map": createMapPort(txFor, gameContent, host.ids),
      "game.resources": createResourcesPort(txFor, { scarceRatio: 0.3, surplusRatio: 1.2 }),
      "game.world": createWorldPort(txFor, gameContent, host.ids),
      "game.comms": createCommsPort(txFor, gameContent, host.ids),
      "game.actions": createActionsPort(txFor),
      "game.agreements": createAgreementsPort(txFor),
      "game.scenario": createScenarioPort(txFor),
    });
    const authority = new Authority({
      storage,
      host,
      content: gameContent,
      moduleBinder: binder,
      allowDirectAgentCommands: true,
      approvedSpeech: options.approvedSpeech,
    });
    authority.registerModule(createMapContributor());
    authority.registerModule(createResourcesContributor());
    authority.registerModule(createWorldContributor());
    authority.registerModule(createCommsContributor());
    authority.registerModule(createActionsContributor());
    authority.registerModule(createAgreementsContributor());
    authority.registerModule(createScenarioContributor({ escalating: options.scenarioEscalating === true }));
    return {
      dataDir,
      storage,
      host,
      authority,
      worldId,
      branchId,
      content,
      gameContent,
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

/** 设置测试分支的 worldTick 与模式；不改变 runVersion 以外的控制字段。 */
export function setGameClock(
  harness: GameHarness,
  clock: {
    readonly worldTick: number;
    readonly mode: "running" | "pausing" | "paused" | "resuming" | "stepping";
    readonly stepTargetTick?: number | null;
  },
): void {
  harness.storage.transact((tx) => {
    const table = tx.branch(harness.branchId).table("clock");
    const row = table.get({});
    if (row === null) {
      throw new Error("测试分支没有时钟行");
    }
    table.put({
      ...row,
      world_tick: clock.worldTick,
      mode: clock.mode,
      step_target_tick: clock.stepTargetTick ?? null,
      run_version: Number(row["run_version"]) + 1,
      updated_at: harness.host.nowIso(),
    });
  });
}

export function playerAuth(harness: GameHarness): AuthContext {
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

export function strategicAuth(harness: GameHarness, agentId = "human-neutral"): AuthContext {  return {
    principalId: agentId,
    kind: "agent",
    roles: ["agent"],
    worldId: harness.worldId,
    branchId: harness.branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
  };
}

export function operatorAuth(harness: GameHarness): AuthContext {
  return {
    principalId: "operator-1",
    kind: "operator",
    roles: ["operator"],
    worldId: harness.worldId,
    branchId: harness.branchId,
    actingAsAgentId: null,
    controllerEpoch: null,
    turnLeaseEpoch: null,
    turnId: null,
  };
}

export function gameCommandEnvelope(
  type: CommandType,
  payload: Json,
  commandId: string,
): CommandEnvelope {
  return { commandId, type, schemaVersion: 1, payload };
}

/** 读取一个聚合的原始状态，供测试断言初始化与任务写入。 */
export function readGameAggregate(
  harness: GameHarness,
  aggregateType: string,
  aggregateId: string,
): Json | null {
  return harness.storage.transact((tx) => {
    const row = tx.branch(harness.branchId).table("aggregate_state").get({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
    });
    return row === null ? null : (row["state_json"] as Json);
  });
}

/** 创建并登记一个供 afterEach 释放的 harness，减少测试文件重复样板。 */
export async function createTrackedGameHarness(
  active: GameHarness[],
  options: Parameters<typeof createGameHarness>[0] = {},
): Promise<GameHarness> {
  const created = await createGameHarness(options);
  active.push(created);
  return created;
}

/** 释放所有已登记的 harness。 */
export async function disposeTrackedGameHarnesses(active: GameHarness[]): Promise<void> {
  await Promise.all(active.splice(0).map(async (harness) => harness.dispose()));
}

/** 以人类中立阵营开局，供各游戏模块测试复用。 */
export function startNeutralCampaign(value: GameHarness): ReturnType<GameHarness["authority"]["commands"]["execute"]> {
  return value.authority.commands.execute(
    playerAuth(value),
    gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd")),
  );
}

/** 读取分支事件类型序列，供断言事件顺序。 */
export function readGameEventTypes(harness: GameHarness): readonly string[] {
  return harness.storage.transact((tx) =>
    tx
      .all("SELECT type FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC", [harness.branchId])
      .map((row) => String(row["type"])),
  );
}

/** 读取分支事件的信封与 payload，供断言投递名单和公开受众。 */
export function readGameEvents(
  harness: GameHarness,
): readonly { readonly type: string; readonly payload: Json; readonly audience: Json }[] {
  return harness.storage.transact((tx) =>
    tx
      .all(
        "SELECT type, payload_json, audience_json FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC",
        [harness.branchId],
      )
      .map((row) => ({
        type: String(row["type"]),
        payload: typeof row["payload_json"] === "string" ? (JSON.parse(row["payload_json"]) as Json) : (row["payload_json"] as Json),
        audience: typeof row["audience_json"] === "string" ? (JSON.parse(row["audience_json"]) as Json) : (row["audience_json"] as Json),
      })),
  );
}
