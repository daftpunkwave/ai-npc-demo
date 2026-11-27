/**
 * 核心职责：用 fake SavePort 驱动宿主的快照、恢复与恢复预检编排，证明宿主只经存档端口契约工作：
 *   快照前受控暂停并补完 tick、快照与幂等记录同事务提交、恢复按 dry-run 摘要在同一事务内切换并更新在线入口、
 *   来源不兼容时不调用恢复写入、预检把完整性错误归入检查项，以及幂等重放不再调用存档端口。
 * 交互契约：依赖 app-server 的运营编排入口与幂等日志、真实运营模块服务、游戏 harness 的 SQLite 存储与内容包，
 *   以及仓库内的标准装配、名册与在线 RunSpec 模板；存档端口与时钟端口都是记录调用的测试替身。
 * 约束与禁忌：不实例化任何存档实现，也不读写快照表；存档实现自身的语义由存档模块与 game-save 测试覆盖。
 */
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DomainError,
  canonicalJson,
  type ClockView,
  type Json,
  type StorageTransaction,
} from "@world-prism/contracts";
import {
  OperationJournal,
  buildRunManifest,
  createOperationsHost,
  deploymentDefaults,
  loadAssembly,
  resolveServerAssembly,
  serverModuleDefinitions,
  type OperationsHostInput,
  type ServerRuntime,
} from "@world-prism/app-server";
import { createConfigDocumentCache, loadRoster, loadRunSpec } from "@world-prism/experiment";
import { OperationsService, type OperationsDriver } from "@world-prism/mod-platform-operations-standard";
import type {
  ClockState,
  CreateSnapshotInput,
  GameClockPort,
  RestoreInspection,
  RestoreResult,
  RestoreSnapshotInput,
  SavePort,
  SnapshotRecord,
} from "@world-prism/module-sdk";
import { createTrackedGameHarness, disposeTrackedGameHarnesses, type GameHarness } from "./game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

const SNAPSHOT_ID = "snap-000000000901";
const FROZEN_BRANCH = "br-000000000901";
const RESTORED_BRANCH = "br-000000000902";
const SOURCE_RUN = "run-000000000901";

/** 编排过程中按发生顺序记录的调用；tx 用于断言哪些调用共用同一存储事务。 */
type OrchestrationEvent =
  | { readonly kind: "control"; readonly mode: string; readonly expectedRunVersion: number }
  | { readonly kind: "catch-up" }
  | { readonly kind: "save"; readonly method: keyof SavePort; readonly tx: StorageTransaction | null; readonly input: unknown }
  | { readonly kind: "activate-roster"; readonly tx: StorageTransaction; readonly branchId: string }
  | { readonly kind: "clock-read"; readonly tx: StorageTransaction; readonly branchId: string };

interface SourceRunFacts {
  readonly runSpec: Json;
  readonly manifest: Json;
  readonly manifestHash: string;
}

interface FakeSaveOptions {
  /** 恢复预检要抛出的错误；缺省返回一致的检查结果。 */
  inspectError?: DomainError;
  /** 预检返回的源 run 冻结 manifest 摘要；缺省与在线 run 一致。 */
  sourceManifestHash?: string;
}

interface Orchestration {
  readonly harness: GameHarness;
  readonly host: OperationsService;
  readonly events: OrchestrationEvent[];
  readonly live: { branchId: string; worldId: string };
  readonly source: SourceRunFacts;
}

function saveCalls(events: readonly OrchestrationEvent[]): Extract<OrchestrationEvent, { kind: "save" }>[] {
  return events.filter((event): event is Extract<OrchestrationEvent, { kind: "save" }> => event.kind === "save");
}

/** 记录调用的存档端口替身：只按端口契约返回结构化结果，不触碰存储。 */
function fakeSavePort(
  events: OrchestrationEvent[],
  live: { readonly branchId: string; readonly worldId: string },
  source: SourceRunFacts,
  options: FakeSaveOptions,
): SavePort {
  const snapshotOf = (input: CreateSnapshotInput): SnapshotRecord => ({
    snapshotId: SNAPSHOT_ID,
    sourceBranchId: input.sourceBranchId,
    frozenBranchId: FROZEN_BRANCH,
    worldSeq: 9,
    worldTick: 5,
    label: input.label,
    createdBy: input.createdBy,
    createdAt: "2026-11-27T00:00:00.000Z",
  });
  const inspectionOf = (snapshotId: string): RestoreInspection => {
    if (options.inspectError !== undefined) {
      throw options.inspectError;
    }
    return {
      snapshotId,
      sourceBranchId: live.branchId,
      frozenBranchId: FROZEN_BRANCH,
      worldId: live.worldId,
      worldSeq: 9,
      worldTick: 5,
      sourceRun: {
        runId: SOURCE_RUN,
        worldId: live.worldId,
        branchId: live.branchId,
        runSpec: source.runSpec,
        manifest: source.manifest,
        manifestHash: options.sourceManifestHash ?? source.manifestHash,
        contaminated: 0,
        evidenceComplete: 1,
      },
    };
  };
  return {
    createSnapshot: (input) => {
      events.push({ kind: "save", method: "createSnapshot", tx: null, input });
      return snapshotOf(input);
    },
    createSnapshotInTransaction: (tx, input) => {
      events.push({ kind: "save", method: "createSnapshotInTransaction", tx, input });
      return snapshotOf(input);
    },
    listSnapshots: () => {
      events.push({ kind: "save", method: "listSnapshots", tx: null, input: null });
      return [];
    },
    inspectRestore: (snapshotId) => {
      events.push({ kind: "save", method: "inspectRestore", tx: null, input: snapshotId });
      return inspectionOf(snapshotId);
    },
    inspectRestoreInTransaction: (tx, snapshotId) => {
      events.push({ kind: "save", method: "inspectRestoreInTransaction", tx, input: snapshotId });
      return inspectionOf(snapshotId);
    },
    restoreSnapshotInTransaction: (tx, input: RestoreSnapshotInput): RestoreResult => {
      events.push({ kind: "save", method: "restoreSnapshotInTransaction", tx, input });
      return {
        branchId: RESTORED_BRANCH,
        runId: input.runId ?? "run-000000000902",
        worldId: live.worldId,
        previousBranchId: live.branchId,
        sourceRunId: SOURCE_RUN,
        worldSeq: 9,
        worldTick: 5,
      };
    },
  };
}

/**
 * 用真实运营模块服务、幂等日志与宿主编排入口组装运营服务；存档与时钟端口替换为记录调用的替身。
 * 在线 run 的 RunSpec 与冻结 manifest 按首次启动同样的方式由标准装配、名册与在线模板生成。
 */
async function orchestration(fake: FakeSaveOptions = {}): Promise<Orchestration> {
  const harness = await createTrackedGameHarness(active);
  const loadContext = { configDir: resolve("config"), env: {}, cache: createConfigDocumentCache() };
  const packId = deploymentDefaults.contentPackId;
  const contentVersion = harness.content.pack.contentVersion;
  const assembly = loadAssembly(deploymentDefaults.assemblyRef);
  const roster = loadRoster(deploymentDefaults.rosterRef, loadContext);
  const runSpec = loadRunSpec("online-default", loadContext, {
    seed: "0123456789abcdef0123456789abcdef",
    moduleAssemblyRef: assembly.assemblyId,
    worldPackRef: packId,
    rosterRef: roster.value.rosterId,
  }).value;
  const resolved = await resolveServerAssembly(assembly, serverModuleDefinitions, { content: harness.content });
  const sealed = await buildRunManifest({
    runSpec,
    content: { packId, contentVersion },
    roster: roster.value,
    resolved,
  });
  const source: SourceRunFacts = {
    runSpec: runSpec as unknown as Json,
    manifest: sealed.manifest as unknown as Json,
    manifestHash: sealed.manifestHash,
  };

  const events: OrchestrationEvent[] = [];
  const live = { branchId: harness.branchId, worldId: harness.worldId };
  let clock: ClockState = { worldTick: 5, mode: "running", secondsPerTick: 20, runVersion: 2, stepTargetTick: null };
  // 后继分支的时钟由分支复制置为暂停并递增版本；替身按分支返回，以便断言恢复结果读的是后继分支。
  const restoredClock: ClockState = { worldTick: 5, mode: "paused", secondsPerTick: 20, runVersion: 3, stepTargetTick: null };
  const clockPort: Pick<GameClockPort, "readInTransaction"> = {
    readInTransaction: (tx, branchId) => {
      events.push({ kind: "clock-read", tx, branchId });
      return branchId === RESTORED_BRANCH ? restoredClock : clock;
    },
  };
  const runtime = {
    save: fakeSavePort(events, live, source, fake),
    clock: clockPort,
    operations: { create: (driver: OperationsDriver) => new OperationsService(driver) },
  } as unknown as ServerRuntime;
  const toView = (state: ClockState): ClockView => ({
    worldTick: state.worldTick,
    day: Math.floor(state.worldTick / 24) + 1,
    hour: state.worldTick % 24,
    mode: state.mode,
    runVersion: state.runVersion,
  });
  const input: OperationsHostInput = {
    host: harness.host,
    storage: harness.storage,
    runtime,
    active: live,
    journal: new OperationJournal(harness.storage, () => harness.host.nowIso(), () => {}),
    runSpec,
    frozenManifest: sealed.manifest,
    frozenManifestHash: sealed.manifestHash,
    activeAssembly: assembly,
    packId,
    contentVersion,
    content: harness.content,
    loadContext,
    clockState: () => clock,
    control: (mode, expectedRunVersion) => {
      events.push({ kind: "control", mode, expectedRunVersion });
      clock = { ...clock, mode: mode === "pause" ? "paused" : "running", runVersion: clock.runVersion + 1 };
      return toView(clock);
    },
    catchUpCurrentTick: () => {
      events.push({ kind: "catch-up" });
    },
    activateRestoredRoster: (tx, branchId) => {
      events.push({ kind: "activate-roster", tx, branchId });
    },
  };
  const host = createOperationsHost(input);
  return { harness, host, events, live, source };
}

describe("宿主经 fake SavePort 编排快照与恢复", () => {
  it("快照先受控暂停并补完当前 tick，再在幂等记录的事务内调用存档端口；重放不再调用端口", async () => {
    const { host, events, live } = await orchestration();
    const operation = { operationId: "op-000000000901", principalId: "player-1" };

    const first = host.snapshot("章节存档", "player-1", operation);

    expect(first).toEqual({ snapshotId: SNAPSHOT_ID, worldTick: 5 });
    expect(events.map((event) => (event.kind === "save" ? `save:${event.method}` : event.kind))).toEqual([
      "control",
      "catch-up",
      "save:createSnapshotInTransaction",
    ]);
    expect(events[0]).toEqual({ kind: "control", mode: "pause", expectedRunVersion: 2 });
    const [snapshotCall] = saveCalls(events);
    expect(snapshotCall?.tx).not.toBeNull();
    expect(snapshotCall?.input).toEqual({ sourceBranchId: live.branchId, label: "章节存档", createdBy: "player-1" });

    events.length = 0;
    expect(host.snapshot("章节存档", "player-1", operation)).toEqual(first);
    expect(saveCalls(events)).toEqual([]);
  });

  it("恢复在同一事务内预检、按 dry-run 摘要提交恢复、激活名册并读取后继时钟，提交后切换在线入口", async () => {
    const { host, events, live, source, harness } = await orchestration();
    const operation = { operationId: "op-000000000902", principalId: "operator-1" };

    const outcome = host.restore(SNAPSHOT_ID, "operator-1", undefined, operation);

    expect(outcome).toEqual({
      branchId: RESTORED_BRANCH,
      clock: { worldTick: 5, day: 1, hour: 5, mode: "paused", runVersion: 3 },
      applied: true,
    });
    // 恢复不经过快照前的暂停与补完；全部调用都在同一个存储事务内。
    expect(events.map((event) => (event.kind === "save" ? `save:${event.method}` : event.kind))).toEqual([
      "save:inspectRestoreInTransaction",
      "save:restoreSnapshotInTransaction",
      "activate-roster",
      "clock-read",
    ]);
    const transactions = new Set(events.map((event) => ("tx" in event ? event.tx : null)));
    expect(transactions.size).toBe(1);
    expect(transactions.has(null)).toBe(false);
    expect(saveCalls(events)[1]?.input).toEqual({
      snapshotId: SNAPSHOT_ID,
      createdBy: "operator-1",
      expected: {
        sourceRunId: SOURCE_RUN,
        canonicalRunSpec: canonicalJson(source.runSpec),
        manifestHash: source.manifestHash,
        worldSeq: 9,
        worldTick: 5,
      },
    });
    expect(events.slice(2)).toMatchObject([
      { kind: "activate-roster", branchId: RESTORED_BRANCH },
      { kind: "clock-read", branchId: RESTORED_BRANCH },
    ]);
    expect(live).toEqual({ branchId: RESTORED_BRANCH, worldId: harness.worldId });

    events.length = 0;
    expect(host.restore(SNAPSHOT_ID, "operator-1", undefined, operation)).toEqual({ ...outcome, applied: false });
    expect(saveCalls(events)).toEqual([]);
    expect(live.branchId).toBe(RESTORED_BRANCH);
  });

  it("预检得到的源 run manifest 与在线 run 不一致时拒绝恢复，不调用恢复写入也不切换在线入口", async () => {
    const { host, events, live, harness } = await orchestration({ sourceManifestHash: "f".repeat(64) });

    let caught: unknown;
    try {
      host.restore(SNAPSHOT_ID, "operator-1", undefined, { operationId: "op-000000000903", principalId: "operator-1" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("invalid-state");
    expect((caught as DomainError).safeMessage).toContain("冻结 manifest");
    expect(saveCalls(events).map((call) => call.method)).toEqual(["inspectRestoreInTransaction"]);
    expect(events.some((event) => event.kind === "activate-roster")).toBe(false);
    expect(live).toEqual({ branchId: harness.branchId, worldId: harness.worldId });
  });

  it("恢复预检把存档端口的完整性错误归入检查项，一致时给出来源、世界与检查点", async () => {
    const broken = await orchestration({
      inspectError: new DomainError("invalid-state", `快照冻结分支 ${FROZEN_BRANCH} 缺少时钟记录`),
    });
    expect(broken.host.validateRestore(SNAPSHOT_ID)).toEqual({
      ok: false,
      checks: [{ name: "snapshot-integrity", ok: false, message: `快照冻结分支 ${FROZEN_BRANCH} 缺少时钟记录` }],
    });
    expect(saveCalls(broken.events).map((call) => call.method)).toEqual(["inspectRestore"]);

    const healthy = await orchestration();
    expect(healthy.host.validateRestore(SNAPSHOT_ID)).toEqual({
      ok: true,
      checks: [
        { name: "snapshot-integrity", ok: true, message: null },
        { name: "source-run", ok: true, message: SOURCE_RUN },
        { name: "world", ok: true, message: healthy.harness.worldId },
        { name: "checkpoint", ok: true, message: "t5 / seq 9" },
      ],
    });
    expect(saveCalls(healthy.events).map((call) => call.method)).toEqual(["inspectRestore"]);
  });
});
