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
  ClockView,
  CommandEnvelope,
  CommandType,
  Json,
  ModuleCreateInput,
  StoragePort,
  StorageRawRow,
} from "@ai-npc/contracts";
import { Authority, TransactionWorldTx } from "@ai-npc/authority";
import { loadContentPack, type ContentPack } from "@ai-npc/experiment";
import {
  gameModuleIds,
  type GameClockPort,
  type GameContent,
  type GameModulePorts,
  type GameWorldPort,
  type ModuleBinder,
  type ScopedWorldTxFactory,
  type WorldTx,
} from "@ai-npc/module-sdk";
import { createClockPort } from "@ai-npc/mod-game-clock-controlled";
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
  readonly clock: GameClockPort;
  readonly host: FakeHost;
  readonly authority: Authority;
  readonly worldId: string;
  readonly branchId: string;
  readonly content: ContentPack;
  readonly gameContent: GameContent;
  dispose(): Promise<void>;
}

/** 把已校验内容包收窄为游戏端口视图；复用服务端宿主的唯一适配器。 */
import { toGameContent } from "@ai-npc/app-server/content";
export { toGameContent };

/** 绑定全部游戏端口；集成测试与投影读取共用同一组实现。 */
function bindGamePorts(
  txFor: ScopedWorldTxFactory,
  gameContent: GameContent,
  host: FakeHost,
  worldPortWrapper?: (port: GameWorldPort) => GameWorldPort,
): GameModulePorts {
  // 按依赖顺序构造：世界端口先于通信，通信/世界/行动/地图先于协议统计。
  const map = createMapPort(txFor, gameContent, host.ids);
  const resources = createResourcesPort(txFor, { scarceRatio: 0.3, surplusRatio: 1.2 });
  const baseWorld = createWorldPort(txFor, gameContent, host.ids);
  const world = worldPortWrapper?.(baseWorld) ?? baseWorld;
  const comms = createCommsPort(() => txFor(gameModuleIds.comms), gameContent, host.ids, world);
  const actions = createActionsPort(txFor);
  return {
    "game.map": map,
    "game.resources": resources,
    "game.world": world,
    "game.comms": comms,
    "game.actions": actions,
    "game.agreements": createAgreementsPort(() => txFor(gameModuleIds.agreements), { actions, comms, world, map }),
    "game.scenario": createScenarioPort(txFor),
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
      seconds_per_tick: 20,
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
  /** 可选 runSeed；给出时 authority 会把它绑定为 host.rng 的第一个参数。 */
  readonly runSeed?: string;
  /** 记录每次规则随机源调用收到的参数，用于断言输入只含语义字段。 */
  readonly onRng?: (parts: readonly string[]) => void;
  /**
   * 可选的存储包装：测试用它记录读路径或注入故障。
   * 包装必须完整转发 StoragePort，不得改变事务、分支 scope 与读写语义。
   */
  readonly storageWrapper?: (storage: StoragePort) => StoragePort;
  /** 可选的 world 端口包装：用于验证旧 provider 结果兼容路径。 */
  readonly worldPortWrapper?: (port: GameWorldPort) => GameWorldPort;
} = {}): Promise<GameHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), "ai-npc-game-test-"));
  const baseHost = createFakeHost();
  const host: FakeHost =
    options.onRng === undefined
      ? baseHost
      : {
        ...baseHost,
        rng: (...parts) => {
          options.onRng?.([...parts]);
          return baseHost.rng(...parts);
        },
      };
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
    const storage = options.storageWrapper?.(port as StoragePort) ?? (port as StoragePort);
    seedBranch(storage, host, worldId, branchId);
    const clock = createClockPort(
      storage,
      { secondsPerTick: 20, maxStepTicks: 24, autoPauseAfterDisconnectMs: 60_000 },
      host.nowIso,
    );
    const content = loadContentPack("content", "earth-2964-v1");
    const gameContent = toGameContent(content);
    const binder: ModuleBinder = (txFor) =>
      bindGamePorts(txFor, gameContent, host, options.worldPortWrapper);
    const authority = new Authority({
      storage,
      host,
      content: gameContent,
      moduleBinder: binder,
      allowDirectAgentCommands: true,
      approvedSpeech: options.approvedSpeech,
      ...(options.runSeed === undefined ? {} : { runSeed: options.runSeed }),
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
      clock,
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

/** 读取分支事件的信封、提交 tick 与 payload，供断言顺序、投递名单和公开受众。 */
export function readGameEvents(
  harness: GameHarness,
): readonly {
  readonly type: string;
  readonly worldTick: number;
  readonly payload: Json;
  readonly audience: Json;
}[] {
  return harness.storage.transact((tx) =>
    tx
      .all(
        "SELECT type, world_tick, payload_json, audience_json FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC",
        [harness.branchId],
      )
      .map((row) => ({
        type: String(row["type"]),
        worldTick: Number(row["world_tick"]),
        payload: typeof row["payload_json"] === "string" ? (JSON.parse(row["payload_json"]) as Json) : (row["payload_json"] as Json),
        audience: typeof row["audience_json"] === "string" ? (JSON.parse(row["audience_json"]) as Json) : (row["audience_json"] as Json),
      })),
  );
}

/** 一个分支的世界表原始行；列值保持数据库原样，不与聚合或事件语义混用。 */
export interface BranchWorldRows {
  readonly events: readonly StorageRawRow[];
  readonly aggregates: readonly StorageRawRow[];
  readonly jobs: readonly StorageRawRow[];
  readonly clock: StorageRawRow | null;
}

/**
 * 读取任意分支的世界表原始行，供比较源分支、冻结分支与恢复分支。
 * 列清单显式排除随分支变化的 branch_id，并按主键排序；不解读聚合或事件语义。
 */
export function readBranchWorldRows(storage: StoragePort, branchId: string): BranchWorldRows {
  return storage.transact((tx) => ({
    events: tx.all(
      "SELECT world_seq, event_id, world_tick, type, schema_version, principal_id, causation_ids_json, correlation_id, audience_json, payload_json, committed_at FROM domain_events WHERE branch_id = ? ORDER BY world_seq ASC",
      [branchId],
    ),
    aggregates: tx.all(
      "SELECT aggregate_type, aggregate_id, version, state_json FROM aggregate_state WHERE branch_id = ? ORDER BY aggregate_type ASC, aggregate_id ASC",
      [branchId],
    ),
    jobs: tx.all(
      "SELECT job_id, seq, kind, due_tick, status, idempotency_key, payload_json, attempts, last_error FROM jobs WHERE branch_id = ? ORDER BY job_id ASC",
      [branchId],
    ),
    clock: tx.all("SELECT world_tick, mode, run_version FROM clock WHERE branch_id = ?", [branchId])[0] ?? null,
  }));
}

/** 读取指定类型第一条事件的持久化受众；没有该事件时返回 null。 */
export function readGameEventAudience(harness: GameHarness, type: string): Json | null {
  const event = readGameEvents(harness).find((candidate) => candidate.type === type);
  return event === undefined ? null : event.audience;
}

/** 只读投影事务可读的聚合类型全集；与宿主读取作用域一致，新增聚合类型时同步。 */
const projectionAggregateTypes = [
  "campaign",
  "meters",
  "character",
  "team",
  "group",
  "delegation",
  "evidence-placement",
  "road",
  "passage-grant",
  "stockpile",
  "task",
  "task-invitation",
  "conversation",
  "knowledge-grant",
  "share",
  "message",
  "agreement",
  "scenario-card",
  "scenario-run",
] as const;

/** 读取当前分支的时钟视图；与宿主 clockView 使用同一规则。 */
export function readGameClock(harness: GameHarness): ClockView {
  const row = harness.storage.transact((tx) => tx.branch(harness.branchId).table("clock").get({}));
  if (row === null) {
    throw new Error("测试分支缺少 clock");
  }
  const tick = Number(row["world_tick"]);
  return {
    worldTick: tick,
    day: Math.floor(tick / 24) + 1,
    hour: tick % 24,
    mode: String(row["mode"]) as ClockView["mode"],
    runVersion: Number(row["run_version"]),
  };
}

/**
 * 在单个只读事务内绑定全部游戏端口，供投影与后续读接口复用。
 * 事务作用域覆盖全部聚合类型，但调用方只能经端口读取；helper 本身不写聚合。
 */
export function withGamePorts<T>(harness: GameHarness, run: (ports: GameModulePorts) => T): T {
  return harness.storage.transact((storageTx) => {
    const clockRow = storageTx.all("SELECT world_tick FROM clock WHERE branch_id = ?", [harness.branchId])[0];
    const worldTick = clockRow === undefined ? 0 : Number(clockRow["world_tick"]);
    const txFor: ScopedWorldTxFactory = (moduleId) =>
      new TransactionWorldTx({
        storageTx,
        worldId: harness.worldId,
        branchId: harness.branchId,
        worldTick,
        principalId: "player-1",
        correlationId: `test:projection-read:${moduleId}`,
        scope: { moduleId: "test.projection-read", ownsAggregates: new Set(projectionAggregateTypes), order: 0 },
        host: harness.host,
      });
    return run(bindGamePorts(txFor, harness.gameContent, harness.host));
  });
}
