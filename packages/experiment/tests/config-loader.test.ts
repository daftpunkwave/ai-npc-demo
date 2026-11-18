/**
 * 配置加载测试：仓库优先、草稿回退、引用歧义、env: 解析与未知键拒绝。
 * 依赖 experiment 包的公开配置入口与 fixtures；临时目录只用于引用优先级测试。
 * 禁止在测试中读取真实 API key 或留下临时配置文件。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LoadingError,
  loadConfigDocument,
  loadContentPack,
  loadRoster,
  loadRunSpec,
  resolveConfigReference,
  runSpecSchema,
  validateRunSpec,
  type ConfigDraftReader,
  type RunSpec,
} from "../src/index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configDir = resolve(repoRoot, "config");
const fixturesConfigDir = resolve(repoRoot, "tests/fixtures/config");
const contentRoot = resolve(repoRoot, "content");

/** 断言加载失败并返回可检查来源、路径与消息的错误。 */
function captureLoadingError(load: () => unknown): LoadingError {
  try {
    load();
  } catch (error) {
    if (error instanceof LoadingError) {
      return error;
    }
    throw error;
  }
  throw new Error("预期加载失败，但实际成功");
}

/** 生成一个结构合法但 id 可替换的 RunSpec YAML，供引用优先级测试使用。 */
function runSpecYaml(id: string): string {
  return [
    "schemaVersion: 1",
    `id: ${id}`,
    "moduleAssemblyRef: local-slg-standard-v1",
    "worldPackRef: earth-2964-v1",
    "scenarioRef: watergate-v1",
    "rosterRef: standard-20",
    "modelLayoutRef: shared-model-layout-v1",
    "seed: generated",
    "player: { principalId: player-1, factionId: null }",
    "mode: live",
    "initialState: { kind: cold-start }",
    "variant: null",
    "script: null",
    "clock: { kind: realtime }",
    "budget: { maxTokens: null, maxCost: null }",
    "failurePolicy: online-fallback",
    "",
  ].join("\n");
}

/** 生成一个只含单个角色的名册 YAML，用于同名引用歧义测试。 */
function rosterYaml(rosterId: string): string {
  return [
    "schemaVersion: 1",
    `rosterId: ${rosterId}`,
    "agents:",
    "  - { agentId: npc-cenyan, kind: character, profileRef: agent-character-default, toolsetRef: character-default }",
    "",
  ].join("\n");
}

/** 建临时配置根目录，测试结束后由调用方删除。 */
function makeTempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ai-npc-config-"));
}

describe("配置加载", () => {
  it("从仓库 config/ 加载 online-default 与 core-3", () => {
    const run = loadRunSpec("online-default", { configDir });
    expect(run.value.id).toBe("online-default");
    expect(run.source.endsWith("online-default.yaml")).toBe(true);

    const roster = loadRoster("core-3", { configDir });
    expect(roster.value.rosterId).toBe("core-3");
    expect(roster.value.agents).toHaveLength(3);
  });

  it("按引用基名在 fixtures 配置目录中解析文件", () => {
    const roster = loadRoster("sample-roster", { configDir: fixturesConfigDir });
    expect(roster.value.rosterId).toBe("sample-roster");
    expect(roster.value.agents).toHaveLength(3);
    expect(roster.source.endsWith(join("rosters", "sample-roster.yaml"))).toBe(true);
  });

  it("仓库文件优先于同名草稿，文件缺失时回退到草稿", () => {
    const tempDir = makeTempConfigDir();
    try {
      const profilesDir = join(tempDir, "profiles");
      mkdirSync(profilesDir, { recursive: true });
      const filePath = join(profilesDir, "sample-run.yaml");
      writeFileSync(filePath, runSpecYaml("from-file"), "utf8");
      const draftRun: RunSpec = {
        ...loadRunSpec("online-default", { configDir }).value,
        id: "from-draft",
      };
      const drafts: ConfigDraftReader = {
        read: (kind, configId) => (kind === "profile" && configId === "sample-run" ? draftRun : null),
      };

      const fromFile = loadConfigDocument("sample-run", runSpecSchema, { configDir: tempDir, drafts }, "profile");
      expect(fromFile.value.id).toBe("from-file");
      expect(fromFile.source).toBe(filePath);

      rmSync(filePath);
      const fromDraft = loadConfigDocument("sample-run", runSpecSchema, { configDir: tempDir, drafts }, "profile");
      expect(fromDraft.value.id).toBe("from-draft");
      expect(fromDraft.source).toBe("draft:profile:sample-run");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("同名配置出现在多个目录时报告引用歧义", () => {
    const tempDir = makeTempConfigDir();
    try {
      for (const sub of ["a", "b"]) {
        const dir = join(tempDir, sub);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "sample-roster.yaml"), rosterYaml("sample-roster"), "utf8");
      }
      const error = captureLoadingError(() => loadRoster("sample-roster", { configDir: tempDir }));
      expect(error.code).toBe("reference");
      expect(error.message).toContain("多个同名配置文件");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("拒绝路径穿越与非法引用", () => {
    const error = captureLoadingError(() => resolveConfigReference("../secret", { configDir }));
    expect(error.code).toBe("reference");
    expect(error.source).toBe("../secret");
  });

  it("env: 引用按注入的环境变量解析，缺失或为空时失败", () => {
    const schema = z
      .object({
        schemaVersion: z.literal(1),
        token: z.string().min(1),
        label: z.string().min(1),
        nested: z.object({ endpoint: z.string().url() }).strict(),
      })
      .strict();

    const loaded = loadConfigDocument("env-sample", schema, {
      configDir: fixturesConfigDir,
      env: { NPC_TEST_TOKEN: "secret-value", NPC_TEST_ENDPOINT: "http://127.0.0.1:3000" },
    });
    expect(loaded.value.token).toBe("secret-value");
    expect(loaded.value.label).toBe("plain");
    expect(loaded.value.nested.endpoint).toBe("http://127.0.0.1:3000");

    const missing = captureLoadingError(() =>
      loadConfigDocument("env-sample", schema, {
        configDir: fixturesConfigDir,
        env: { NPC_TEST_TOKEN: "secret-value" },
      }),
    );
    expect(missing.code).toBe("env");
    expect(missing.path).toBe("nested.endpoint");

    const empty = captureLoadingError(() =>
      loadConfigDocument("env-sample", schema, {
        configDir: fixturesConfigDir,
        env: { NPC_TEST_TOKEN: "", NPC_TEST_ENDPOINT: "http://127.0.0.1:3000" },
      }),
    );
    expect(empty.code).toBe("env");
    expect(empty.path).toBe("token");
  });

  it("未知键被严格拒绝", () => {
    const error = captureLoadingError(() => loadRunSpec("run-unknown-key", { configDir: fixturesConfigDir }));
    expect(error.code).toBe("schema");
    expect(error.source.endsWith("run-unknown-key.yaml")).toBe(true);
    expect(error.message).toContain("unexpected");
  });
});

describe("RunSpec 交叉检查", () => {
  const content = loadContentPack(contentRoot, "earth-2964-v1");
  const run = loadRunSpec("online-default", { configDir });

  it("online-default 的引用与内容一致", () => {
    expect(() => validateRunSpec(run.value, content)).not.toThrow();
  });

  it("拒绝不存在的剧情、脚本与非人类派系", () => {
    const scenarioError = captureLoadingError(() =>
      validateRunSpec({ ...run.value, scenarioRef: "missing-scenario" }, content),
    );
    expect(scenarioError.path).toBe("scenarioRef");

    const scriptError = captureLoadingError(() =>
      validateRunSpec(
        { ...run.value, script: { scriptRef: "missing-script" } },
        content,
      ),
    );
    expect(scriptError.path).toBe("script.scriptRef");

    const factionError = captureLoadingError(() =>
      validateRunSpec(
        { ...run.value, player: { principalId: "player-1", factionId: "species-fauna" } },
        content,
      ),
    );
    expect(factionError.path).toBe("player.factionId");

    const principalError = captureLoadingError(() =>
      validateRunSpec(
        { ...run.value, player: { principalId: "player-2", factionId: null } },
        content,
      ),
    );
    expect(principalError.path).toBe("player.principalId");
  });

  it("脚本引用可被解析到内容索引", () => {
    expect(
      validateRunSpec(
        { ...run.value, script: { scriptRef: "s-promise", branch: "keep" } },
        content,
      ),
    ).toBeUndefined();
  });
});
