/**
 * 验证服务端宿主 bootstrap：真实存储、内容、authority、在线分支、HTTP 应用、多角色令牌与监听失败。
 * 依赖临时数据目录与 content 包；不监听固定端口。
 * 禁止用假存储替代首次启动路径。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const liveRun = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" })[0]);
    expect(liveRun).toMatchObject({ mode: "live", status: "running" });

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
    const login = async (token: string) => {
      const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
      expect(response.statusCode).toBe(200);
      return response.json() as { readonly principalId: string; readonly roles: readonly string[] };
    };
    expect(await login("console-token")).toMatchObject({ principalId: "console-admin", roles: ["operator", "researcher", "evaluator"] });
    expect(await login("operator-token")).toMatchObject({ principalId: "console-operator", roles: ["operator"] });
    expect(await login("researcher-token")).toMatchObject({ principalId: "console-researcher", roles: ["researcher"] });
    expect(await login("evaluator-token")).toMatchObject({ principalId: "console-evaluator", roles: ["evaluator"] });
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