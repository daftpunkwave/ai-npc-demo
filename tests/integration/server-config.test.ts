/**
 * 验证部署配置解析、固定双端拓扑、令牌冲突预检与凭据文件生成复用。
 * 依赖临时目录与环境变量快照；不启动宿主、不监听端口。
 * 禁止读取开发者本机 .env 或把真实令牌写入仓库。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsFileName,
  loadDeploymentConfig,
  parseDeploymentConfig,
  resolveCredentials,
  startupLogLines,
} from "@ai-npc/app-server";

const dirs: string[] = [];

const controlledEnvKeys = [
  "NPC_SERVER_HOST",
  "NPC_SERVER_PORT",
  "NPC_CLIENT_PORT",
  "NPC_DATA_DIR",
  "NPC_ASSEMBLY",
  "NPC_MODEL_LAYOUT",
  "NPC_ROSTER",
  "NPC_PLAYER_TOKEN",
  "NPC_CONSOLE_TOKEN",
  "NPC_OPERATOR_TOKEN",
  "NPC_RESEARCHER_TOKEN",
  "NPC_EVALUATOR_TOKEN",
] as const;

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-config-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      assemblyRef: "local-slg-standard-v1",
      modelLayoutRef: "shared-model-layout-v1",
      rosterRef: "standard-15",
      configuredTokens: {},
    });
  });

  it("读取 NPC_* 覆盖数据目录与运行时选择", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({
      env: {
        NPC_SERVER_HOST: "127.0.0.1",
        NPC_SERVER_PORT: "3000",
        NPC_CLIENT_PORT: "5173",
        NPC_DATA_DIR: "./data-e2e",
        NPC_ASSEMBLY: "local-slg-escalating-v1",
        NPC_MODEL_LAYOUT: "deterministic-model-layout-v1",
        NPC_ROSTER: "core-3",
        NPC_PLAYER_TOKEN: "  player-token  ",
        NPC_CONSOLE_TOKEN: "",
        NPC_OPERATOR_TOKEN: "operator-token",
      },
      projectRoot: root,
    });
    expect(config.dataDir).toBe(join(root, "data-e2e"));
    expect(config.assemblyRef).toBe("local-slg-escalating-v1");
    expect(config.modelLayoutRef).toBe("deterministic-model-layout-v1");
    expect(config.rosterRef).toBe("core-3");
    expect(config.configuredTokens).toEqual({ player: "player-token", operator: "operator-token" });
  });

  it("拒绝非回环主机", () => {
    const root = tempRoot();
    expect(() => parseDeploymentConfig({ env: { NPC_SERVER_HOST: "0.0.0.0" }, projectRoot: root }))
      .toThrow("NPC_SERVER_HOST 必须是 127.0.0.1");
    expect(() => parseDeploymentConfig({ env: { NPC_SERVER_HOST: "::1" }, projectRoot: root }))
      .toThrow("NPC_SERVER_HOST 必须是 127.0.0.1");
  });

  it("拒绝约定之外的服务端端口与客户端端口", () => {
    const root = tempRoot();
    expect(() => parseDeploymentConfig({ env: { NPC_SERVER_PORT: "3001" }, projectRoot: root }))
      .toThrow("NPC_SERVER_PORT 必须是 3000");
    expect(() => parseDeploymentConfig({ env: { NPC_SERVER_PORT: "3000x" }, projectRoot: root }))
      .toThrow("NPC_SERVER_PORT 必须是 3000");
    expect(() => parseDeploymentConfig({ env: { NPC_SERVER_PORT: "80" }, projectRoot: root }))
      .toThrow("NPC_SERVER_PORT 必须是 3000");
    expect(() => parseDeploymentConfig({ env: { NPC_CLIENT_PORT: "5174" }, projectRoot: root }))
      .toThrow("NPC_CLIENT_PORT 必须是 5173");
  });

  it("拒绝玩家、控制台与单角色令牌之间的重复", () => {
    const root = tempRoot();
    expect(() => parseDeploymentConfig({
      env: { NPC_PLAYER_TOKEN: "same-token", NPC_CONSOLE_TOKEN: "same-token" },
      projectRoot: root,
    })).toThrow(/登录令牌重复：NPC_PLAYER_TOKEN 与 NPC_CONSOLE_TOKEN/);
    expect(() => parseDeploymentConfig({
      env: { NPC_PLAYER_TOKEN: "same-token", NPC_EVALUATOR_TOKEN: "same-token" },
      projectRoot: root,
    })).toThrow(/登录令牌重复：NPC_PLAYER_TOKEN 与 NPC_EVALUATOR_TOKEN/);
    expect(() => parseDeploymentConfig({
      env: { NPC_CONSOLE_TOKEN: "console", NPC_OPERATOR_TOKEN: "console" },
      projectRoot: root,
    })).toThrow(/登录令牌重复：NPC_CONSOLE_TOKEN 与 NPC_OPERATOR_TOKEN/);
  });

  it("空令牌视为未配置，不参与冲突预检", () => {
    const root = tempRoot();
    const config = parseDeploymentConfig({
      env: { NPC_PLAYER_TOKEN: "", NPC_CONSOLE_TOKEN: "   ", NPC_OPERATOR_TOKEN: "operator-token" },
      projectRoot: root,
    });
    expect(config.configuredTokens).toEqual({ operator: "operator-token" });
  });

  it("启动前加载项目根 .env", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".env"), [
      "NPC_SERVER_HOST=127.0.0.1",
      "NPC_SERVER_PORT=3000",
      "NPC_CLIENT_PORT=5173",
      "NPC_DATA_DIR=./env-data",
      "NPC_ASSEMBLY=local-slg-escalating-v1",
      "NPC_PLAYER_TOKEN=",
      "NPC_CONSOLE_TOKEN=",
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
    const config = parseDeploymentConfig({ env: { NPC_PLAYER_TOKEN: "env-player" }, projectRoot: root });
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
      "[ai-npc] server ready: http://127.0.0.1:3000",
      "[ai-npc] player  login: http://127.0.0.1:5173/#token=new-player",
      "[ai-npc] console login: http://127.0.0.1:3000/console/#token=new-console",
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
    expect(reused).toEqual(["[ai-npc] server ready: http://127.0.0.1:3000"]);

    const playerOnly = startupLogLines({
      config,
      tokens: { player: "new-player", console: "persisted-console" },
      generated: ["player"],
    });
    expect(playerOnly).toContain("[ai-npc] player  login: http://127.0.0.1:5173/#token=new-player");
    expect(playerOnly.join("\n")).not.toContain("persisted-console");
    expect(playerOnly.join("\n")).not.toContain("/console/#token=");
  });
});
