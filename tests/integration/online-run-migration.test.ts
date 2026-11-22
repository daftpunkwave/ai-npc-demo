/**
 * 验证在线 run 的能力闭包升级迁移：旧冻结 manifest 缺少新增能力绑定时，
 * 显式迁移派生新分支与新 run 且源 run 行与 manifest 原样；未开启迁移时给出可操作诊断；
 * 超出能力闭包范围的差异、别名漂移与不可迁移错误都拒绝迁移；启动失败可补偿恢复在线入口。
 * 依赖真实存储、内容包与宿主启动链路；篡改 manifest 只用于模拟旧能力闭包形态。
 * 禁止让迁移修改源 run 行或源 manifest，也禁止让不可迁移错误派生新分支。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeConfigHash } from "@ai-npc/kernel";
import {
  canonicalHasher,
  migrateOnlineRun,
  restoreOnlineAliasToSourceBranch,
  startHost,
  type RunningHost,
} from "@ai-npc/app-server";
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
  // 先关闭全部宿主再删除目录：SQLite 句柄未释放时 Windows 上删除会抛 EBUSY。
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
    throw new AggregateError(failures, `迁移测试清理未全部完成：${failures.length} 处失败`);
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-migration-test-"));
  dirs.push(dir);
  return dir;
}

/** 在线 run 的完整行快照；比较全部列以捕获任何未选取字段被意外修改。 */
type RunRowSnapshot = Readonly<Record<string, unknown>>;

function readRunRows(dataDir: string): readonly RunRowSnapshot[] {
  const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
  try {
    return database.prepare("SELECT * FROM runs ORDER BY created_at, run_id").all() as readonly RunRowSnapshot[];
  } finally {
    database.close();
  }
}

function readSingleBranchStatus(dataDir: string, branchId: string): string {
  const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
  try {
    return String(
      database.prepare("SELECT status FROM branches WHERE branch_id = ?").get(branchId)?.["status"],
    );
  } finally {
    database.close();
  }
}

function readAliasBranchId(dataDir: string): string {
  const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
  try {
    return String(
      database.prepare("SELECT branch_id FROM world_aliases WHERE alias = 'online'").get()?.["branch_id"],
    );
  } finally {
    database.close();
  }
}

function countActiveActivations(dataDir: string, branchId: string): number {
  const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS total FROM agent_activations WHERE branch_id = ? AND status = 'active'")
      .get(branchId) as Record<string, unknown> | undefined;
    return Number(row?.["total"] ?? 0);
  } finally {
    database.close();
  }
}

interface LegacyManifest {
  readonly runId: string;
  readonly branchId: string;
  readonly manifestJson: string;
  readonly manifestHash: string;
}

/**
 * 把在线 run 的 manifest 改写成旧能力闭包形态：modules 移除后来新增的 platform.observability
 * 与 platform.module-admin 绑定、catalogHash 指向旧模块目录，manifest_hash 重新自洽。
 * 这正是代码升级后恢复旧 run 的形态：hash 校验通过、差异只落在装配能力闭包上，
 * 但按当前模块目录复算必然失败。
 */
async function freezeLegacyManifest(dataDir: string): Promise<LegacyManifest> {
  const databasePath = join(dataDir, "ai-npc.db");
  const database = new DatabaseSync(databasePath);
  let legacy: LegacyManifest;
  try {
    const row = database
      .prepare("SELECT run_id, branch_id, manifest_json, manifest_hash FROM runs WHERE mode = 'live'")
      .get() as Record<string, unknown>;
    if (row === undefined) {
      throw new Error("缺少 live run，无法模拟旧能力闭包数据");
    }
    const manifest = JSON.parse(String(row["manifest_json"])) as {
      assembly?: { catalogHash?: string; modules?: readonly { moduleId?: string }[] };
    } & Record<string, unknown>;
    const addedCapabilityModuleIds = new Set(["platform.observability.sqlite", "platform.module-admin.standard"]);
    const legacyManifest = {
      ...manifest,
      assembly: {
        ...manifest.assembly,
        catalogHash: "legacy-catalog-hash",
        modules: (manifest.assembly?.modules ?? []).filter(
          (module) => !addedCapabilityModuleIds.has(module.moduleId ?? ""),
        ),
      },
    };
    const legacyJson = JSON.stringify(legacyManifest);
    const legacyHash = await computeConfigHash(legacyManifest as never, canonicalHasher);
    database
      .prepare("UPDATE runs SET manifest_json = ?, manifest_hash = ? WHERE run_id = ?")
      .run(legacyJson, legacyHash, String(row["run_id"]));
    legacy = {
      runId: String(row["run_id"]),
      branchId: String(row["branch_id"]),
      manifestJson: legacyJson,
      manifestHash: legacyHash,
    };
  } finally {
    database.close();
  }
  return legacy;
}

/** 在旧形态之上覆写冻结 manifest 的单个顶层字段并重算自洽哈希，用于构造非能力闭包差异。 */
async function overwriteManifestField(dataDir: string, legacy: LegacyManifest, field: string, value: unknown): Promise<LegacyManifest> {
  const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
  try {
    const manifest = JSON.parse(legacy.manifestJson) as Record<string, unknown>;
    const tampered = { ...manifest, [field]: value };
    const tamperedJson = JSON.stringify(tampered);
    const tamperedHash = await computeConfigHash(tampered as never, canonicalHasher);
    database
      .prepare("UPDATE runs SET manifest_json = ?, manifest_hash = ? WHERE run_id = ?")
      .run(tamperedJson, tamperedHash, legacy.runId);
    return { ...legacy, manifestJson: tamperedJson, manifestHash: tamperedHash };
  } finally {
    database.close();
  }
}

async function loginSession(host: RunningHost, token: string): Promise<string> {
  const login = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(login.statusCode).toBe(200);
  return (login.json() as { readonly sessionToken: string }).sessionToken;
}

async function startCampaign(dataDir: string): Promise<RunningHost> {
  const host = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
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

describe("在线 run 能力闭包升级迁移", () => {
  it("默认拒绝启动并给出迁移指引，源 run 数据保持原样", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    await first.close();
    const legacy = await freezeLegacyManifest(dataDir);

    await expect(
      startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" }),
    ).rejects.toThrow(/NPC_MIGRATE_ONLINE_RUN=1/);

    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: legacy.runId,
      branch_id: legacy.branchId,
      manifest_json: legacy.manifestJson,
      manifest_hash: legacy.manifestHash,
    });
  }, 120_000);

  it("开启迁移开关后派生新 run 与新分支，源 run 原样、名册激活延续且迁移结果可再次重启", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    const sourceActiveActivations = countActiveActivations(dataDir, first.branchId);
    expect(sourceActiveActivations).toBeGreaterThan(0);
    await first.close();
    const legacy = await freezeLegacyManifest(dataDir);

    const migrated = await startHost({
      dataDir,
      playerToken: "player-token",
      consoleToken: "console-token",
      migrateOnlineRun: true,
    });
    hosts.push(migrated);
    expect(migrated.branchId).not.toBe(legacy.branchId);

    const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
    let forkedBranchParent = "";
    let forkedAtWorldSeq: unknown;
    let forkedClockMode = "";
    let sourceEventStats: unknown;
    let forkedEventStats: unknown;
    try {
      const forkedBranch = database
        .prepare("SELECT parent_branch_id, forked_at_world_seq FROM branches WHERE branch_id = ?")
        .get(migrated.branchId) as Record<string, unknown> | undefined;
      forkedBranchParent = String(forkedBranch?.["parent_branch_id"]);
      forkedAtWorldSeq = forkedBranch?.["forked_at_world_seq"];
      forkedClockMode = String(
        database.prepare("SELECT mode FROM clock WHERE branch_id = ?").get(migrated.branchId)?.["mode"],
      );
      const countEvents = database.prepare(
        "SELECT COUNT(*) AS total, MAX(world_seq) AS maxSeq FROM domain_events WHERE branch_id = ?",
      );
      sourceEventStats = countEvents.get(legacy.branchId);
      forkedEventStats = countEvents.get(migrated.branchId);
    } finally {
      database.close();
    }

    // online 别名指向新分支；新分支父指针指向源分支，源分支按让位语义归档且数据保留。
    expect(readAliasBranchId(dataDir)).toBe(migrated.branchId);
    expect(forkedBranchParent).toBe(legacy.branchId);
    expect(readSingleBranchStatus(dataDir, legacy.branchId)).toBe("archived");

    // 事件与事件序号在派生分支原样延续，新分支时钟由 fork 修正为暂停。
    expect(forkedEventStats).toEqual(sourceEventStats);
    expect(Number(forkedAtWorldSeq)).toBeGreaterThan(0);
    expect(forkedClockMode).toBe("paused");

    // 名册激活在新分支延续（否则迁移后的世界不再调度 NPC），源分支归档后不计入部署配额。
    expect(countActiveActivations(dataDir, migrated.branchId)).toBe(sourceActiveActivations);

    // 源 run 行保持篡改后的旧形态（宿主未改动）；新 run 按当前能力闭包冻结新 manifest。
    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(2);
    const sourceRow = rows.find((row) => row["run_id"] === legacy.runId);
    const migratedRow = rows.find((row) => row["run_id"] !== legacy.runId);
    expect(sourceRow).toMatchObject({
      branch_id: legacy.branchId,
      manifest_json: legacy.manifestJson,
      manifest_hash: legacy.manifestHash,
    });
    expect(migratedRow).toBeDefined();
    expect(migratedRow?.["status"]).toBe("running");
    expect(migratedRow?.["branch_id"]).toBe(migrated.branchId);
    expect(migratedRow?.["manifest_hash"]).not.toBe(legacy.manifestHash);
    const migratedManifest = JSON.parse(String(migratedRow?.["manifest_json"])) as {
      assembly?: { catalogHash?: string; modules?: readonly { moduleId?: string }[] };
    };
    expect(migratedManifest.assembly?.catalogHash).not.toBe("legacy-catalog-hash");
    const moduleIds = (migratedManifest.assembly?.modules ?? []).map((module) => module.moduleId ?? "");
    expect(moduleIds).toContain("platform.observability.sqlite");
    expect(moduleIds).toContain("platform.module-admin.standard");

    // 暂停状态下世界可读、活动 run 指向迁移后的分支。
    const health = await migrated.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    const session = await loginSession(migrated, "player-token");
    const campaign = await migrated.app.inject({
      method: "GET",
      url: "/api/v1/campaign",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(campaign.statusCode).toBe(200);
    await migrated.close();

    // 再次重启：新 run 的 manifest 可按当前目录复算，不触发迁移也不新增 run。
    const restarted = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(restarted);
    expect(restarted.branchId).toBe(migrated.branchId);
    await restarted.close();
    expect(readRunRows(dataDir)).toHaveLength(2);
  });

  it("保留绑定的模块配置变化属于配置漂移，拒绝迁移", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    await first.close();
    const legacy = await freezeLegacyManifest(dataDir);
    // 篡改旧 manifest 中保留模块的配置摘要并重算自洽哈希：这不是能力闭包升级，而是配置漂移。
    const manifest = JSON.parse(legacy.manifestJson) as { assembly?: { modules?: readonly Record<string, unknown>[] } };
    const driftModules = (manifest.assembly?.modules ?? []).map((module, index) =>
      index === 0 ? { ...module, configHash: "tampered-config-hash" } : module,
    );
    const tampered = await overwriteManifestField(dataDir, legacy, "assembly", {
      ...manifest.assembly,
      modules: driftModules,
    });

    await expect(
      startHost({
        dataDir,
        playerToken: "player-token",
        consoleToken: "console-token",
        migrateOnlineRun: true,
      }),
    ).rejects.toThrow(/超出能力闭包范围/);

    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ manifest_json: tampered.manifestJson, manifest_hash: tampered.manifestHash });
    expect(readSingleBranchStatus(dataDir, tampered.branchId)).not.toBe("archived");
  });

  it("名册或 Agent 配置差异超出能力闭包范围时拒绝迁移", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    await first.close();
    const legacy = await freezeLegacyManifest(dataDir);
    const manifest = JSON.parse(legacy.manifestJson) as { roster?: { agents?: readonly Record<string, unknown>[] } };
    const renamedRoster = {
      ...manifest.roster,
      agents: (manifest.roster?.agents ?? []).map((agent, index) =>
        index === 0 ? { ...agent, name: "被替换的名字" } : agent,
      ),
    };
    const tampered = await overwriteManifestField(dataDir, legacy, "roster", renamedRoster);

    await expect(
      startHost({
        dataDir,
        playerToken: "player-token",
        consoleToken: "console-token",
        migrateOnlineRun: true,
      }),
    ).rejects.toThrow(/超出能力闭包范围/);

    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ manifest_json: tampered.manifestJson, manifest_hash: tampered.manifestHash });
    expect(readSingleBranchStatus(dataDir, tampered.branchId)).not.toBe("archived");
  });

  it("在线别名已漂移时拒绝基于过时入口迁移", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    const sourceBranchId = first.branchId;
    await first.close();

    // 关闭宿主后从存储行重建在线入口，模拟一次已读取但未提交迁移的过时入口。
    const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
    let staleEntry: Parameters<typeof migrateOnlineRun>[0]["online"];
    let runSpec: unknown;
    let manifest: unknown;
    try {
      const branch = database.prepare("SELECT * FROM branches WHERE branch_id = ?").get(sourceBranchId) as Record<string, unknown>;
      const runRow = database
        .prepare("SELECT * FROM runs WHERE branch_id = ?")
        .get(sourceBranchId) as Record<string, unknown>;
      staleEntry = {
        branch: branch as never,
        run: runRow as never,
        branchId: sourceBranchId,
        runId: String(runRow["run_id"]),
        worldId: String(branch["world_id"]),
      };
      runSpec = JSON.parse(String(runRow["run_spec_json"]));
      manifest = JSON.parse(String(runRow["manifest_json"]));
    } finally {
      database.close();
    }
    const fakeHostServices = {
      ids: (prefix: string) => `${prefix}-migration-probe`,
      nowIso: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof migrateOnlineRun>[0]["host"];

    // 篡改 manifest 后开启迁移开关：宿主用当前入口完成迁移，别名切换到新分支。
    await freezeLegacyManifest(dataDir);
    const migrated = await startHost({
      dataDir,
      playerToken: "player-token",
      consoleToken: "console-token",
      migrateOnlineRun: true,
    });
    hosts.push(migrated);
    expect(readAliasBranchId(dataDir)).not.toBe(sourceBranchId);

    // 用迁移前读取的过时入口再次迁移：事务内发现别名漂移，整体拒绝。
    expect(() =>
      migrateOnlineRun({
        storage: migrated.storage,
        host: fakeHostServices,
        online: staleEntry,
        runSpec: runSpec as never,
        manifest: manifest as never,
        manifestHash: "probe-hash",
      }),
    ).toThrow(/不再是迁移读取的源分支/);
    // 拒绝后在线入口不变，没有产生第二个分支。
    expect(readAliasBranchId(dataDir)).toBe(migrated.branchId);
    expect(readRunRows(dataDir)).toHaveLength(2);
    await migrated.close();
  });

  it("启动失败补偿把在线入口与源分支状态恢复到迁移前", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    const sourceBranchId = first.branchId;
    await first.close();
    await freezeLegacyManifest(dataDir);

    const migrated = await startHost({
      dataDir,
      playerToken: "player-token",
      consoleToken: "console-token",
      migrateOnlineRun: true,
    });
    hosts.push(migrated);

    // 模拟宿主启动失败时的补偿（宿主尚未关闭）：别名与源分支状态回到迁移前，
    // 迁移产生的新分支与新 run 留存为孤儿记录。
    restoreOnlineAliasToSourceBranch(migrated.storage, "2026-01-01T00:00:00.000Z", sourceBranchId);
    await migrated.close();

    expect(readAliasBranchId(dataDir)).toBe(sourceBranchId);
    expect(readSingleBranchStatus(dataDir, sourceBranchId)).toBe("active");
    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(2);
    const sourceRow = rows.find((row) => row["branch_id"] === sourceBranchId);
    expect(sourceRow?.["mode"]).toBe("live");
  });

  it("内容版本不一致等不可迁移错误不进入迁移路径", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    await first.close();
    const legacy = await freezeLegacyManifest(dataDir);
    const manifest = JSON.parse(legacy.manifestJson) as { content?: Record<string, unknown> };
    const tampered = await overwriteManifestField(dataDir, legacy, "content", {
      ...manifest.content,
      contentVersion: "0.0.0-legacy",
    });

    await expect(
      startHost({
        dataDir,
        playerToken: "player-token",
        consoleToken: "console-token",
        migrateOnlineRun: true,
      }),
    ).rejects.toThrow(/contentVersion/);

    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ manifest_json: tampered.manifestJson, manifest_hash: tampered.manifestHash });
  });
});
