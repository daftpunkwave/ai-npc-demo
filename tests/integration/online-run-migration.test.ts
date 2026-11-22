/**
 * 验证在线 run 的能力闭包升级迁移：旧冻结 manifest 无法按当前模块目录复算时，
 * 显式迁移派生新分支与新 run 且源数据原样；未开启迁移时给出可操作诊断；
 * 内容版本不一致等不可迁移失败不进入迁移路径。
 * 依赖真实存储、内容包与宿主启动链路；篡改 manifest 只用于模拟旧能力闭包形态。
 * 禁止让迁移修改源 run 行、源分支或源 manifest，也禁止让不可迁移错误派生新分支。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeConfigHash } from "@ai-npc/kernel";
import { canonicalHasher, startHost, type RunningHost } from "@ai-npc/app-server";
import { gameCommandEnvelope } from "./game-support";

const hosts: RunningHost[] = [];
const dirs: string[] = [];

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

interface RunRowSnapshot {
  readonly runId: string;
  readonly branchId: string;
  readonly status: string;
  readonly manifestJson: string;
  readonly manifestHash: string;
}

function readRunRows(dataDir: string): readonly RunRowSnapshot[] {
  const database = new DatabaseSync(join(dataDir, "ai-npc.db"));
  try {
    const rows = database
      .prepare("SELECT run_id, branch_id, status, manifest_json, manifest_hash FROM runs ORDER BY created_at")
      .all() as readonly Record<string, unknown>[];
    return rows.map((row) => ({
      runId: String(row["run_id"]),
      branchId: String(row["branch_id"]),
      status: String(row["status"]),
      manifestJson: String(row["manifest_json"]),
      manifestHash: String(row["manifest_hash"]),
    }));
  } finally {
    database.close();
  }
}

/**
 * 把在线 run 的 manifest 改写成旧能力闭包形态：catalogHash 指向旧模块目录，manifest_hash 重新自洽。
 * 这正是代码升级后恢复旧 run 的形态：hash 校验通过，但按当前目录复算必然失败。
 */
async function freezeLegacyManifest(dataDir: string): Promise<RunRowSnapshot> {
  const databasePath = join(dataDir, "ai-npc.db");
  const database = new DatabaseSync(databasePath);
  let legacy: RunRowSnapshot;
  try {
    const row = database
      .prepare("SELECT run_id, branch_id, status, manifest_json, manifest_hash FROM runs WHERE mode = 'live'")
      .get() as Record<string, unknown>;
    if (row === undefined) {
      throw new Error("缺少 live run，无法模拟旧能力闭包数据");
    }
    const manifest = JSON.parse(String(row["manifest_json"])) as Record<string, unknown>;
    const assembly = manifest["assembly"] as Record<string, unknown>;
    const legacyManifest = {
      ...manifest,
      assembly: { ...assembly, catalogHash: "legacy-catalog-hash" },
    };
    const legacyJson = JSON.stringify(legacyManifest);
    const legacyHash = await computeConfigHash(legacyManifest as never, canonicalHasher);
    database
      .prepare("UPDATE runs SET manifest_json = ?, manifest_hash = ? WHERE run_id = ?")
      .run(legacyJson, legacyHash, String(row["run_id"]));
    legacy = {
      runId: String(row["run_id"]),
      branchId: String(row["branch_id"]),
      status: String(row["status"]),
      manifestJson: legacyJson,
      manifestHash: legacyHash,
    };
  } finally {
    database.close();
  }
  return legacy;
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
      runId: legacy.runId,
      branchId: legacy.branchId,
      status: legacy.status,
      manifestJson: legacy.manifestJson,
      manifestHash: legacy.manifestHash,
    });
  });

  it("开启迁移开关后派生新 run 与新分支，源 run 原样且迁移结果可再次重启", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
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
    let aliasBranchId = "";
    let sourceBranchParent = "";
    let forkedBranchParent = "";
    let forkedAtWorldSeq: unknown;
    let sourceEventStats: unknown;
    let forkedEventStats: unknown;
    let forkedClockMode = "";
    try {
      aliasBranchId = String(
        database.prepare("SELECT branch_id FROM world_aliases WHERE alias = 'online'").get()?.["branch_id"],
      );
      sourceBranchParent = String(
        database.prepare("SELECT parent_branch_id FROM branches WHERE branch_id = ?").get(legacy.branchId)?.["parent_branch_id"],
      );
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

    // online 别名指向新分支；源分支保持原始父子关系，新分支父指针指向源分支。
    expect(aliasBranchId).toBe(migrated.branchId);
    expect(sourceBranchParent).toBe("null");
    expect(forkedBranchParent).toBe(legacy.branchId);

    // 事件与事件序号在派生分支原样延续，新分支时钟由 fork 修正为暂停。
    expect(forkedEventStats).toEqual(sourceEventStats);
    expect(Number(forkedAtWorldSeq)).toBeGreaterThan(0);
    expect(forkedClockMode).toBe("paused");

    // 源 run 行保持篡改后的旧形态（宿主未改动）；新 run 按当前能力闭包冻结新 manifest。
    const rows = readRunRows(dataDir);
    expect(rows).toHaveLength(2);
    const sourceRow = rows.find((row) => row.runId === legacy.runId);
    const migratedRow = rows.find((row) => row.runId !== legacy.runId);
    expect(sourceRow).toMatchObject({
      branchId: legacy.branchId,
      status: legacy.status,
      manifestJson: legacy.manifestJson,
      manifestHash: legacy.manifestHash,
    });
    expect(migratedRow).toBeDefined();
    expect(migratedRow?.status).toBe("running");
    expect(migratedRow?.branchId).toBe(migrated.branchId);
    expect(migratedRow?.manifestHash).not.toBe(legacy.manifestHash);
    const migratedManifest = JSON.parse(migratedRow?.manifestJson ?? "{}") as {
      assembly?: { catalogHash?: string; modules?: readonly { moduleId?: string }[] };
      seed?: string;
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

  it("内容版本不一致等不可迁移错误不进入迁移路径", async () => {
    const dataDir = tempDataDir();
    const first = await startCampaign(dataDir);
    await first.close();
    const legacy = await freezeLegacyManifest(dataDir);
    // 在旧形态之上再改写内容版本：这是内容发布问题，不属于能力闭包升级，迁移开关也不应放行。
    const databasePath = join(dataDir, "ai-npc.db");
    const database = new DatabaseSync(databasePath);
    let tampered: RunRowSnapshot;
    try {
      const manifest = JSON.parse(legacy.manifestJson) as Record<string, unknown>;
      const content = manifest["content"] as Record<string, unknown>;
      const incompatible = { ...manifest, content: { ...content, contentVersion: "0.0.0-legacy" } };
      const incompatibleJson = JSON.stringify(incompatible);
      const incompatibleHash = await computeConfigHash(incompatible as never, canonicalHasher);
      database
        .prepare("UPDATE runs SET manifest_json = ?, manifest_hash = ? WHERE run_id = ?")
        .run(incompatibleJson, incompatibleHash, legacy.runId);
      tampered = { ...legacy, manifestJson: incompatibleJson, manifestHash: incompatibleHash };
    } finally {
      database.close();
    }

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
    expect(rows[0]).toMatchObject({
      runId: tampered.runId,
      branchId: tampered.branchId,
      manifestJson: tampered.manifestJson,
      manifestHash: tampered.manifestHash,
    });
  });
});
