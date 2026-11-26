/**
 * 验证部署配置解析、固定双端拓扑、令牌冲突预检、凭据文件原子写入与启动顺序。
 * 依赖临时目录、环境变量快照与可注入的宿主替身；不启动真实宿主、不监听端口。
 * 禁止读取开发者本机 .env、把真实令牌写入仓库，或用非原子写入的断言掩盖失败路径。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createShutdownHandler,
  credentialsFileName,
  loadDeploymentConfig,
  parseDeploymentConfig,
  resolveCredentials,
  shutdownServer,
  startServer,
  startupLogLines,
} from "@world-prism/app-server";
import type { DeploymentConfig, HostOptions, StartupHost } from "@world-prism/app-server";

vi.mock("node:fs", { spy: true });

const dirs: string[] = [];

const controlledEnvKeys = [
  "WORLD_PRISM_SERVER_HOST",
  "WORLD_PRISM_SERVER_PORT",
  "WORLD_PRISM_CLIENT_PORT",
  "WORLD_PRISM_DATA_DIR",
  "WORLD_PRISM_ASSEMBLY",
  "WORLD_PRISM_MODEL_LAYOUT",
  "WORLD_PRISM_ROSTER",
  "WORLD_PRISM_PLAYER_TOKEN",
  "WORLD_PRISM_CONSOLE_TOKEN",
  "WORLD_PRISM_OPERATOR_TOKEN",
  "WORLD_PRISM_RESEARCHER_TOKEN",
  "WORLD_PRISM_EVALUATOR_TOKEN",
] as const;

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "world-prism-config-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 启动编排的可观测替身：记录宿主启动、监听与关闭次数，并按需注入监听失败。 */
interface FakeHostProvider {
  readonly state: {
    startCalls: number;
    listenCalls: number;
    closeCalls: number;
    readonly options: HostOptions[];
  };
  readonly startHost: (options: HostOptions) => Promise<StartupHost>;
}

function createFakeHostProvider(listenError?: Error): FakeHostProvider {
  const state: FakeHostProvider["state"] = { startCalls: 0, listenCalls: 0, closeCalls: 0, options: [] };
  const host: StartupHost = {
    transport: { host: "127.0.0.1", port: 3000 },
    listen: async () => {
      state.listenCalls += 1;
      if (listenError !== undefined) {
        throw listenError;
      }
    },
    close: async () => {
      state.closeCalls += 1;
    },
  };
  return {
    state,
    startHost: async (options: HostOptions) => {
      state.startCalls += 1;
      state.options.push(options);
      return host;
    },
  };
}

function credentialsPathOf(config: DeploymentConfig): string {
  return join(config.dataDir, credentialsFileName);
}

/** 用真实 fs 模块恢复一次性 mock 实现，避免失败用例把注入实现泄漏给后续用例。 */
function restoreImplementations(actual: typeof import("node:fs")): void {
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
}

describe("部署配置", () => {
  it("缺省解析为固定双端拓扑与默认数据目录", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    expect(config).toMatchObject({
      projectRoot: root,
      serverHost: "127.0.0.1",
      serverPort: 3000,
      clientPort: 5173,
      dataDir: join(root, "data"),
      consoleStaticDir: join(root, "apps/server/console-static"),
      assemblyRef: "local-slg-standard-v1",
      modelLayoutRef: "shared-model-layout-v1",
      rosterRef: "standard-15",
      configuredTokens: {},
    });
  });

  it("读取 WORLD_PRISM_* 覆盖数据目录与运行时选择", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({
      env: {
        WORLD_PRISM_SERVER_HOST: "127.0.0.1",
        WORLD_PRISM_SERVER_PORT: "3000",
        WORLD_PRISM_CLIENT_PORT: "5173",
        WORLD_PRISM_DATA_DIR: "./data-e2e",
        WORLD_PRISM_ASSEMBLY: "local-slg-escalating-v1",
        WORLD_PRISM_MODEL_LAYOUT: "deterministic-model-layout-v1",
        WORLD_PRISM_ROSTER: "core-3",
        WORLD_PRISM_PLAYER_TOKEN: "  player-token  ",
        WORLD_PRISM_CONSOLE_TOKEN: "",
        WORLD_PRISM_OPERATOR_TOKEN: "operator-token",
      },
      projectRoot: root,
    });
    expect(config.dataDir).toBe(join(root, "data-e2e"));
    expect(config.assemblyRef).toBe("local-slg-escalating-v1");
    expect(config.modelLayoutRef).toBe("deterministic-model-layout-v1");
    expect(config.rosterRef).toBe("core-3");
    expect(config.configuredTokens).toEqual({ player: "player-token", operator: "operator-token" });
  });

  it("控制台静态目录按项目根解析，可被 WORLD_PRISM_CONSOLE_STATIC_DIR 覆盖", () => {
    const root = tempRoot();
    // 相对路径按项目根解析：与数据目录同一规则，不随进程工作目录变化。
    expect(parseDeploymentConfig({ env: { WORLD_PRISM_CONSOLE_STATIC_DIR: "./build/console" }, projectRoot: root })
      .consoleStaticDir).toBe(join(root, "build/console"));
    // 绝对路径原样使用，允许把构建产物部署到仓库之外。
    expect(parseDeploymentConfig({ env: { WORLD_PRISM_CONSOLE_STATIC_DIR: resolve("/srv/console-static") }, projectRoot: root })
      .consoleStaticDir).toBe(resolve("/srv/console-static"));
    expect(parseDeploymentConfig({ env: { WORLD_PRISM_CONSOLE_STATIC_DIR: "   " }, projectRoot: root })
      .consoleStaticDir).toBe(join(root, "apps/server/console-static"));
  });

  it("拒绝非回环主机", () => {
    const root = tempRoot();
    expect(() => parseDeploymentConfig({ env: { WORLD_PRISM_SERVER_HOST: "0.0.0.0" }, projectRoot: root }))
      .toThrow("WORLD_PRISM_SERVER_HOST 必须是 127.0.0.1");
    expect(() => parseDeploymentConfig({ env: { WORLD_PRISM_SERVER_HOST: "::1" }, projectRoot: root }))
      .toThrow("WORLD_PRISM_SERVER_HOST 必须是 127.0.0.1");
  });

  it("拒绝约定之外的服务端端口与客户端端口", () => {
    const root = tempRoot();
    expect(() => parseDeploymentConfig({ env: { WORLD_PRISM_SERVER_PORT: "3001" }, projectRoot: root }))
      .toThrow("WORLD_PRISM_SERVER_PORT 必须是 3000");
    expect(() => parseDeploymentConfig({ env: { WORLD_PRISM_SERVER_PORT: "3000x" }, projectRoot: root }))
      .toThrow("WORLD_PRISM_SERVER_PORT 必须是 3000");
    expect(() => parseDeploymentConfig({ env: { WORLD_PRISM_SERVER_PORT: "80" }, projectRoot: root }))
      .toThrow("WORLD_PRISM_SERVER_PORT 必须是 3000");
    expect(() => parseDeploymentConfig({ env: { WORLD_PRISM_CLIENT_PORT: "5174" }, projectRoot: root }))
      .toThrow("WORLD_PRISM_CLIENT_PORT 必须是 5173");
  });

  it("拒绝玩家、控制台与单角色令牌之间的重复", () => {
    const root = tempRoot();
    expect(() => parseDeploymentConfig({
      env: { WORLD_PRISM_PLAYER_TOKEN: "same-token", WORLD_PRISM_CONSOLE_TOKEN: "same-token" },
      projectRoot: root,
    })).toThrow(/登录令牌重复：WORLD_PRISM_PLAYER_TOKEN 与 WORLD_PRISM_CONSOLE_TOKEN/);
    expect(() => parseDeploymentConfig({
      env: { WORLD_PRISM_PLAYER_TOKEN: "same-token", WORLD_PRISM_EVALUATOR_TOKEN: "same-token" },
      projectRoot: root,
    })).toThrow(/登录令牌重复：WORLD_PRISM_PLAYER_TOKEN 与 WORLD_PRISM_EVALUATOR_TOKEN/);
    expect(() => parseDeploymentConfig({
      env: { WORLD_PRISM_CONSOLE_TOKEN: "console", WORLD_PRISM_OPERATOR_TOKEN: "console" },
      projectRoot: root,
    })).toThrow(/登录令牌重复：WORLD_PRISM_CONSOLE_TOKEN 与 WORLD_PRISM_OPERATOR_TOKEN/);
  });

  it("空令牌视为未配置，不参与冲突预检", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({
      env: { WORLD_PRISM_PLAYER_TOKEN: "", WORLD_PRISM_CONSOLE_TOKEN: "   ", WORLD_PRISM_OPERATOR_TOKEN: "operator-token" },
      projectRoot: root,
    });
    expect(config.configuredTokens).toEqual({ operator: "operator-token" });
  });

  it("启动前加载项目根 .env", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".env"), [
      "WORLD_PRISM_SERVER_HOST=127.0.0.1",
      "WORLD_PRISM_SERVER_PORT=3000",
      "WORLD_PRISM_CLIENT_PORT=5173",
      "WORLD_PRISM_DATA_DIR=./env-data",
      "WORLD_PRISM_ASSEMBLY=local-slg-escalating-v1",
      "WORLD_PRISM_PLAYER_TOKEN=",
      "WORLD_PRISM_CONSOLE_TOKEN=",
      "",
    ].join("\n"), "utf8");
    const saved = new Map(controlledEnvKeys.map((key) => [key, process.env[key]]));
    for (const key of controlledEnvKeys) {
      delete process.env[key];
    }
    try {
      const config = loadDeploymentConfig({ projectRoot: root });
      expect(config.dataDir).toBe(join(root, "env-data"));
      expect(config.assemblyRef).toBe("local-slg-escalating-v1");
      expect(config.configuredTokens).toEqual({});
    } finally {
      for (const key of controlledEnvKeys) {
        const value = saved.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe("登录凭据", () => {
  it("首次启动生成令牌并写入凭据文件，重启复用而不重新生成", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const first = resolveCredentials(config, { generate: (role) => `${role}-generated-token` });
    expect(first.generated).toEqual(["player", "console"]);
    expect(first.filePath).toBe(join(config.dataDir, credentialsFileName));
    expect(first.tokens).toEqual({ player: "player-generated-token", console: "console-generated-token" });
    expect(existsSync(first.filePath)).toBe(true);
    const stored = JSON.parse(readFileSync(first.filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      playerToken: "player-generated-token",
      consoleToken: "console-generated-token",
    });

    const second = resolveCredentials(config, {
      generate: () => {
        throw new Error("已有持久化令牌时不应重新生成");
      },
    });
    expect(second.generated).toEqual([]);
    expect(second.tokens).toEqual(first.tokens);
    expect(readFileSync(second.filePath, "utf8")).toBe(readFileSync(first.filePath, "utf8"));
  });

  it("配置的令牌优先于凭据文件，且不写入文件", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: { WORLD_PRISM_PLAYER_TOKEN: "env-player" }, projectRoot: root });
    mkdirSync(config.dataDir, { recursive: true });
    const filePath = join(config.dataDir, credentialsFileName);
    writeFileSync(filePath, JSON.stringify({ version: 1, playerToken: "stored-player", consoleToken: "stored-console" }), "utf8");

    const resolved = resolveCredentials(config);
    expect(resolved.tokens).toEqual({ player: "env-player", console: "stored-console" });
    expect(resolved.generated).toEqual([]);
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({ version: 1, consoleToken: "stored-console" });
  });

  it("凭据文件中的重复令牌同样被拒绝", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(
      join(config.dataDir, credentialsFileName),
      JSON.stringify({ version: 1, playerToken: "duplicated", consoleToken: "duplicated" }),
      "utf8",
    );
    expect(() => resolveCredentials(config)).toThrow(/登录令牌重复/);
  });

  it("凭据文件损坏时明确失败，不静默重新生成", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(join(config.dataDir, credentialsFileName), "not-json", "utf8");
    expect(() => resolveCredentials(config)).toThrow(/凭据文件不是合法 JSON/);
  });

  it.skipIf(process.platform === "win32")("凭据文件权限收紧为仅当前用户可读写", () => {
    // Windows 不支持 POSIX 权限位，本用例只在类 Unix 平台验证。
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const resolved = resolveCredentials(config, { generate: (role) => `${role}-generated-token` });
    expect(statSync(resolved.filePath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("已存在的宽权限凭据目录在写入时被收紧为 0700", () => {
    // Windows 不支持 POSIX 权限位，本用例只在类 Unix 平台验证；
    // mkdir 的 mode 只作用于新建目录，预先以 0755 存在的目录必须被显式收紧。
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    mkdirSync(config.dataDir, { recursive: true });
    chmodSync(config.dataDir, 0o755);
    resolveCredentials(config, { generate: (role) => `${role}-generated-token` });
    expect(statSync(config.dataDir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("令牌未变化无需重写时，已存在的宽权限目录同样被收紧", () => {
    // Windows 不支持 POSIX 权限位，本用例只在类 Unix 平台验证；
    // 目录收紧发生在令牌未变化的提前返回之前，日常二次启动也会生效。
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    mkdirSync(config.dataDir, { recursive: true });
    chmodSync(config.dataDir, 0o755);
    const first = resolveCredentials(config, { generate: (role) => `${role}-first-token` });
    chmodSync(config.dataDir, 0o755);
    const second = resolveCredentials(config);
    expect(second.tokens).toEqual(first.tokens);
    expect(statSync(config.dataDir).mode & 0o777).toBe(0o700);
  });
});

describe("启动编排", () => {
  it("凭据写入中途失败时在监听前终止，旧文件保持可用且不留暂存文件", async () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const filePath = credentialsPathOf(config);
    mkdirSync(config.dataDir, { recursive: true });
    const previous = `${JSON.stringify({ version: 1, playerToken: "stored-player" }, null, 2)}\n`;
    writeFileSync(filePath, previous, "utf8");

    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const writeSpy = vi.mocked(fs.writeFileSync);
    writeSpy.mockImplementationOnce((target, data) => {
      // 模拟写入中途失败：暂存文件已经出现部分内容，正式文件尚未发布。
      actual.writeFileSync(target, String(data).slice(0, 12), "utf8");
      throw new Error("注入的凭据写入失败");
    });
    const provider = createFakeHostProvider();
    try {
      await expect(startServer({
        config,
        startHost: provider.startHost,
        logLine: () => {},
        logError: () => {},
      })).rejects.toThrow(/写入凭据文件失败/);
    } finally {
      restoreImplementations(actual);
    }
    expect(provider.state.startCalls).toBe(0);
    expect(provider.state.listenCalls).toBe(0);
    expect(readFileSync(filePath, "utf8")).toBe(previous);
    expect(readdirSync(config.dataDir)).toEqual([credentialsFileName]);
  });

  it("宿主启动失败时丢弃暂存文件且不发布凭据文件", async () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const startHost = async (): Promise<StartupHost> => {
      throw new Error("注入的宿主启动失败");
    };
    await expect(startServer({ config, startHost, logLine: () => {}, logError: () => {} }))
      .rejects.toThrow(/注入的宿主启动失败/);
    expect(readdirSync(config.dataDir)).toEqual([]);
  });

  it("监听失败时丢弃暂存文件，不发布正式凭据文件", async () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const provider = createFakeHostProvider(new Error("EADDRINUSE"));
    const errorLines: string[] = [];
    await expect(startServer({
      config,
      startHost: provider.startHost,
      logLine: () => {},
      logError: (line) => { errorLines.push(line); },
    })).rejects.toThrow(/监听 127\.0\.0\.1:3000 失败: EADDRINUSE/);
    expect(provider.state.listenCalls).toBe(1);
    expect(provider.state.closeCalls).toBe(1);
    expect(errorLines).toEqual([]);
    expect(readdirSync(config.dataDir)).toEqual([]);
  });

  it("监听成功并输出登录地址后才原子发布完整凭据文件", async () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const filePath = credentialsPathOf(config);
    const lines: string[] = [];
    const existedWhileLogging: boolean[] = [];
    const provider = createFakeHostProvider();
    const running = await startServer({
      config,
      startHost: provider.startHost,
      logLine: (line) => {
        lines.push(line);
        existedWhileLogging.push(existsSync(filePath));
      },
      logError: () => {},
    });

    expect(provider.state.listenCalls).toBe(1);
    expect(provider.state.closeCalls).toBe(0);
    expect(running.transport).toEqual({ host: "127.0.0.1", port: 3000 });
    // 输出登录地址时正式凭据文件尚未发布，避免“已落盘却从未展示”。
    expect(existedWhileLogging).toEqual([false, false, false]);
    expect(existsSync(filePath)).toBe(true);
    expect(readdirSync(config.dataDir)).toEqual([credentialsFileName]);

    const contents = readFileSync(filePath, "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    const stored = JSON.parse(contents) as Record<string, string | number>;
    expect(stored).toMatchObject({ version: 1 });
    expect(Object.keys(stored).sort()).toEqual(["consoleToken", "playerToken", "version"]);
    const playerToken = String(stored["playerToken"]);
    const consoleToken = String(stored["consoleToken"]);
    expect(lines[0]).toBe("[world-prism] server ready: http://127.0.0.1:3000");
    expect(lines).toContain(`[world-prism] player  login: http://127.0.0.1:5173/#token=${encodeURIComponent(playerToken)}`);
    expect(lines).toContain(`[world-prism] console login: http://127.0.0.1:3000/console/#token=${encodeURIComponent(consoleToken)}`);

    const reused = resolveCredentials(config, {
      generate: () => {
        throw new Error("发布完成的令牌不应重新生成");
      },
    });
    expect(reused.generated).toEqual([]);
    expect(reused.tokens).toEqual({ player: playerToken, console: consoleToken });
  });

  it("原子发布失败时保留旧凭据文件并明确报告，不静默降级", async () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const filePath = credentialsPathOf(config);
    mkdirSync(config.dataDir, { recursive: true });
    const previous = `${JSON.stringify({ version: 1, playerToken: "stored-player" }, null, 2)}\n`;
    writeFileSync(filePath, previous, "utf8");

    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("注入的原子发布失败");
    });
    const lines: string[] = [];
    const errorLines: string[] = [];
    const provider = createFakeHostProvider();
    let caught: unknown;
    try {
      await startServer({
        config,
        startHost: provider.startHost,
        logLine: (line) => { lines.push(line); },
        logError: (line) => { errorLines.push(line); },
      });
    } catch (error) {
      caught = error;
    } finally {
      restoreImplementations(actual);
    }
    // 凭据无法持久化时启动必须失败并关闭宿主；已打印的本次登录地址不再视为可用。
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("凭据文件原子发布失败");
    expect((caught as Error).message).toContain("启动已终止");
    expect(provider.state.closeCalls).toBe(1);
    expect(lines.some((line) => line.includes("console login:"))).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(previous);
    expect(readdirSync(config.dataDir)).toEqual([credentialsFileName]);
  });

  it.skipIf(process.platform === "win32")("原子发布后的凭据文件权限为仅当前用户可读写", async () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const provider = createFakeHostProvider();
    await startServer({ config, startHost: provider.startHost, logLine: () => {}, logError: () => {} });
    expect(statSync(credentialsPathOf(config)).mode & 0o777).toBe(0o600);
  });
});

describe("登录地址输出", () => {
  it("玩家地址使用客户端端口，控制台地址使用服务端端口", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const lines = startupLogLines({
      config,
      tokens: { player: "new-player", console: "new-console" },
      generated: ["player", "console"],
    });
    expect(lines).toEqual([
      "[world-prism] server ready: http://127.0.0.1:3000",
      "[world-prism] player  login: http://127.0.0.1:5173/#token=new-player",
      "[world-prism] console login: http://127.0.0.1:3000/console/#token=new-console",
    ]);
  });

  it("只为本次新生成的令牌打印带令牌地址", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({ env: {}, projectRoot: root });
    const reused = startupLogLines({
      config,
      tokens: { player: "persisted-player", console: "persisted-console" },
      generated: [],
    });
    expect(reused).toEqual(["[world-prism] server ready: http://127.0.0.1:3000"]);

    const playerOnly = startupLogLines({
      config,
      tokens: { player: "new-player", console: "persisted-console" },
      generated: ["player"],
    });
    expect(playerOnly).toContain("[world-prism] player  login: http://127.0.0.1:5173/#token=new-player");
    expect(playerOnly.join("\n")).not.toContain("persisted-console");
    expect(playerOnly.join("\n")).not.toContain("/console/#token=");
  });
});

describe("关闭编排", () => {
  it("关闭成功时退出码为 0 且不记录错误", async () => {
    const exitCodes: number[] = [];
    const errorLines: string[] = [];
    await shutdownServer({
      close: async () => {},
      logError: (line) => { errorLines.push(line); },
      setExitCode: (code) => { exitCodes.push(code); },
    });
    expect(exitCodes).toEqual([0]);
    expect(errorLines).toEqual([]);
  });

  it("关闭失败时记录原因并设置非零退出码", async () => {
    const exitCodes: number[] = [];
    const errorLines: string[] = [];
    await shutdownServer({
      close: async () => {
        throw new Error("注入的关闭失败");
      },
      logError: (line) => { errorLines.push(line); },
      setExitCode: (code) => { exitCodes.push(code); },
    });
    expect(exitCodes).toEqual([1]);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("关闭失败");
    expect(errorLines[0]).toContain("注入的关闭失败");
  });

  it("连续关闭信号只执行一次关闭，失败退出码不被后续调用覆盖", async () => {
    let closeCalls = 0;
    const exitCodes: number[] = [];
    const errorLines: string[] = [];
    const shutdown = createShutdownHandler({
      close: async () => {
        closeCalls += 1;
        throw new Error("注入的关闭失败");
      },
      logError: (line) => { errorLines.push(line); },
      setExitCode: (code) => { exitCodes.push(code); },
    });
    const first = shutdown();
    const second = shutdown();
    // SIGINT 与 SIGTERM 共享同一个关闭任务，第二次调用不会重新关闭。
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(closeCalls).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("注入的关闭失败");
  });

  it("连续关闭信号在成功路径只保留退出码 0", async () => {
    let closeCalls = 0;
    const exitCodes: number[] = [];
    const shutdown = createShutdownHandler({
      close: async () => {
        closeCalls += 1;
      },
      logError: () => {},
      setExitCode: (code) => { exitCodes.push(code); },
    });
    await Promise.all([shutdown(), shutdown()]);
    expect(closeCalls).toBe(1);
    expect(exitCodes).toEqual([0]);
  });
});
