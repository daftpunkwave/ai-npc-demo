/**
 * 验证服务端宿主 bootstrap：真实存储、内容、authority、在线分支、HTTP 应用、多角色令牌与监听失败。
 * 依赖临时数据目录、content 包与冻结的 RunSpec/manifest；不监听固定端口。
 * 禁止用假存储替代首次启动路径，也禁止用当前入参覆盖已冻结的在线 run。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageCell } from "@ai-npc/contracts";
import { startHost, type RunningHost } from "@ai-npc/app-server";
import { gameCommandEnvelope } from "./game-support";

const hosts: RunningHost[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => host.close()));
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-host-test-"));
  dirs.push(dir);
  return dir;
}

/** 当前在线 run 的持久化行；测试只经 StoragePort 读取。 */
function liveRun(host: RunningHost): Readonly<Record<string, StorageCell>> {
  const row = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" })[0]);
  if (row === undefined) {
    throw new Error("缺少 live run");
  }
  return row;
}

/** 用启动令牌登录并返回会话令牌。 */
async function loginSession(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

describe("服务端宿主", () => {
  it("首次启动创建在线分支并可开局", async () => {
    const dataDir = tempDataDir();
    const host = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const health = await host.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ready" });

    const login = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "player-token" } });
    expect(login.statusCode).toBe(200);
    const session = (login.json() as { readonly sessionToken: string }).sessionToken;
    const command = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001");
    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: { authorization: `Bearer ${session}` },
      payload: command,
    });
    expect(started.statusCode).toBe(200);
    const view = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers: { authorization: `Bearer ${session}` } });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ projection: { campaign: { factionId: "human-neutral" }, clock: { worldTick: 0 } } });
    const sessionView = await host.app.inject({ method: "GET", url: "/api/v1/session", headers: { authorization: `Bearer ${session}` } });
    expect((sessionView.json() as { readonly serverAssembly: { readonly modules: unknown[] } }).serverAssembly.modules.length).toBeGreaterThan(0);
    const runRow = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" })[0]);
    expect(runRow).toMatchObject({ mode: "live", status: "running" });

    const reset = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/reset",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000001" },
    });
    expect(reset.statusCode).toBe(200);
    const resetBody = reset.json() as { readonly branchId: string; readonly clock: { readonly mode: string } };
    expect(resetBody.branchId).not.toBe(host.branchId);
    expect(resetBody.clock.mode).toBe("paused");
    const runs = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" }));
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run["status"] === "running")).toHaveLength(1);
    expect(runs.filter((run) => run["status"] === "completed")).toHaveLength(1);
    const alias = host.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
    expect(alias).toMatchObject({ branch_id: resetBody.branchId });
    const snapshots = await host.app.inject({ method: "GET", url: "/api/v1/campaign/snapshots", headers: { authorization: `Bearer ${session}` } });
    expect(snapshots.statusCode).toBe(200);
    expect((snapshots.json() as { readonly snapshots: unknown[] }).snapshots).toHaveLength(1);
  });

  it("首次启动生成 seed 与 manifest，重启沿用同一 run、seed 与装配", async () => {
    const dataDir = tempDataDir();
    const first = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    let runId = "";
    let manifestHash: StorageCell | undefined;
    let branchId = "";
    try {
      const run = liveRun(first);
      const spec = run["run_spec_json"] as {
        readonly seed: string;
        readonly moduleAssemblyRef: string;
        readonly rosterRef: string;
        readonly modelLayoutRef: string;
      };
      expect(spec.seed).toMatch(/^[0-9a-f]{32}$/);
      expect(spec.seed).not.toBe("generated");
      expect(spec.moduleAssemblyRef).toBe("local-slg-standard-v1");
      expect(spec.rosterRef).toBe("standard-20");
      expect(spec.modelLayoutRef).toBe("shared-model-layout-v1");
      const manifest = run["manifest_json"] as {
        readonly seed: string;
        readonly selection: { readonly moduleAssemblyRef: string; readonly rosterRef: string };
        readonly content: { readonly packId: string; readonly contentVersion: string };
        readonly agentSlots: StorageCell;
      };
      expect(manifest.seed).toBe(spec.seed);
      expect(manifest.selection).toMatchObject({ moduleAssemblyRef: "local-slg-standard-v1", rosterRef: "standard-20" });
      expect(manifest.content).toEqual({ packId: "earth-2964-v1", contentVersion: "1.0.0" });
      expect(manifest.agentSlots).toBeNull();
      expect(run["manifest_hash"]).toMatch(/^[0-9a-f]{64}$/);
      runId = String(run["run_id"]);
      manifestHash = run["manifest_hash"];
      branchId = first.branchId;
      const world = first.storage.transact((tx) => tx.rows("worlds").get({ world_id: first.worldId }));
      expect(world).toMatchObject({ pack_id: "earth-2964-v1", content_version: "1.0.0" });
    } finally {
      await first.close();
    }

    const second = await startHost({
      dataDir,
      playerToken: "player-token",
      consoleToken: "console-token",
      assemblyRef: "local-slg-escalating-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
    });
    hosts.push(second);
    expect(second.branchId).toBe(branchId);
    const resumed = second.storage.transact((tx) => tx.rows("runs").get({ run_id: runId }));
    expect(resumed).not.toBeNull();
    const resumedSpec = resumed?.["run_spec_json"] as {
      readonly seed: string;
      readonly moduleAssemblyRef: string;
      readonly rosterRef: string;
      readonly modelLayoutRef: string;
    };
    expect(resumedSpec.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(resumedSpec.moduleAssemblyRef).toBe("local-slg-standard-v1");
    expect(resumedSpec.rosterRef).toBe("standard-20");
    expect(resumedSpec.modelLayoutRef).toBe("shared-model-layout-v1");
    expect(resumed?.["manifest_hash"]).toBe(manifestHash);
    expect(second.storage.transact((tx) => tx.rows("runs").list({ mode: "live" }))).toHaveLength(1);
    const session = await loginSession(second, "player-token");
    const sessionView = await second.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { authorization: `Bearer ${session}` },
    });
    const modules = (sessionView.json() as {
      readonly serverAssembly: { readonly modules: readonly { readonly moduleId: string }[] };
    }).serverAssembly.modules;
    expect(modules.some((module) => module.moduleId === "game.scenario.watergate")).toBe(true);
    expect(modules.some((module) => module.moduleId === "game.scenario.watergate-escalating")).toBe(false);
  });

  it("首次启动选择升级装配时 RunSpec 与 manifest 记录实际引用", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      assemblyRef: "local-slg-escalating-v1",
    });
    hosts.push(host);
    const run = liveRun(host);
    const spec = run["run_spec_json"] as { readonly moduleAssemblyRef: string };
    expect(spec.moduleAssemblyRef).toBe("local-slg-escalating-v1");
    const manifest = run["manifest_json"] as unknown as {
      readonly selection: { readonly moduleAssemblyRef: string };
      readonly assembly: {
        readonly assemblyId: string;
        readonly modules: readonly { readonly moduleId: string }[];
      };
    };
    expect(manifest.selection.moduleAssemblyRef).toBe("local-slg-escalating-v1");
    expect(manifest.assembly.assemblyId).toBe("local-slg-escalating-v1");
    expect(manifest.assembly.modules.some((module) => module.moduleId === "game.scenario.watergate-escalating")).toBe(true);
    expect(host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" }))).toHaveLength(1);
  });

  it("内容包 contentVersion 与冻结 manifest 不一致时拒绝启动并说明", async () => {
    const dataDir = tempDataDir();
    const first = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    const run = liveRun(first);
    const manifest = run["manifest_json"] as { readonly [key: string]: StorageCell };
    const content = manifest["content"] as { readonly [key: string]: StorageCell };
    first.storage.transact((tx) => {
      tx.rows("runs").put({
        ...run,
        manifest_json: { ...manifest, content: { ...content, contentVersion: "9.9.9" } },
      });
      const world = tx.rows("worlds").get({ world_id: first.worldId });
      if (world !== null) {
        tx.rows("worlds").put({ ...world, content_version: "9.9.9" });
      }
    });
    await first.close();
    await expect(startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" })).rejects.toThrow(
      /contentVersion 不一致.*9\.9\.9.*1\.0\.0/,
    );
  });

  it("从快照恢复的后继 run 沿用源 RunSpec 与 seed", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");
    const headers = { authorization: `Bearer ${session}` };
    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000101"),
    });
    expect(started.statusCode).toBe(200);
    const source = liveRun(host);
    const snapshot = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/snapshots",
      headers,
      payload: { label: "恢复点" },
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotId = (snapshot.json() as { readonly snapshotId: string }).snapshotId;
    const restored = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/restore",
      headers,
      payload: { snapshotId },
    });
    expect(restored.statusCode).toBe(200);
    const restoredBranchId = (restored.json() as { readonly branchId: string }).branchId;
    const branch = host.storage.transact((tx) => tx.rows("branches").get({ branch_id: restoredBranchId }));
    expect(branch).not.toBeNull();
    const successorRunId = String(branch?.["run_id"]);
    const successor = host.storage.transact((tx) => tx.rows("runs").get({ run_id: successorRunId }));
    expect(successor).not.toBeNull();
    expect(successor?.["run_spec_json"]).toEqual(source["run_spec_json"]);
    expect((successor?.["run_spec_json"] as { readonly seed: string }).seed).toBe(
      (source["run_spec_json"] as { readonly seed: string }).seed,
    );
    expect(successor?.["manifest_hash"]).toBe(source["manifest_hash"]);
    expect(successor?.["manifest_json"]).toEqual(source["manifest_json"]);
  });

  it("未知装配在打开存储前失败", async () => {
    const dataDir = tempDataDir();
    await expect(startHost({ dataDir, playerToken: "test-player", consoleToken: "test-console", assemblyRef: "missing-assembly" })).rejects.toThrow("未知 server 装配");
    expect(existsSync(join(dataDir, "ai-npc.db"))).toBe(false);
  });

  it("玩家与控制台令牌相同时拒绝启动且不打开存储", async () => {
    const dataDir = tempDataDir();
    await expect(startHost({ dataDir, playerToken: "same-token", consoleToken: "same-token" }))
      .rejects.toThrow("登录令牌重复");
    expect(existsSync(join(dataDir, "ai-npc.db"))).toBe(false);
  });

  it("单角色令牌只发放对应控制台角色", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      operatorToken: "operator-token",
      researcherToken: "researcher-token",
      evaluatorToken: "evaluator-token",
    });
    hosts.push(host);
    const loginAs = async (token: string) => {
      const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
      expect(response.statusCode).toBe(200);
      return response.json() as { readonly principalId: string; readonly roles: readonly string[] };
    };
    expect(await loginAs("console-token")).toMatchObject({ principalId: "console-admin", roles: ["operator", "researcher", "evaluator"] });
    expect(await loginAs("operator-token")).toMatchObject({ principalId: "console-operator", roles: ["operator"] });
    expect(await loginAs("researcher-token")).toMatchObject({ principalId: "console-researcher", roles: ["researcher"] });
    expect(await loginAs("evaluator-token")).toMatchObject({ principalId: "console-evaluator", roles: ["evaluator"] });
    const unknown = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "unknown-token" } });
    expect(unknown.statusCode).toBe(401);
  }, 20_000);

  it("监听端口被占用时 listen 失败", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => { blocker.listen(0, "127.0.0.1", () => resolve()); });
    const address = blocker.address();
    try {
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      const host = await startHost({
        dataDir: tempDataDir(),
        playerToken: "player-token",
        consoleToken: "console-token",
        transportPort: port,
      });
      hosts.push(host);
      await expect(host.listen()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => resolve()); });
    }
  }, 30_000);
});
