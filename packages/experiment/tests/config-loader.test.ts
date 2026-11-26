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
  applyProfilePatch,
  createConfigDocumentCache,
  loadAgentProfile,
  loadAgentToolset,
  loadConfigDocument,
  loadContentPack,
  loadModelFixtures,
  loadRoster,
  loadRunSpec,
  resolveConfigReference,
  resolveModelEnv,
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
    "rosterRef: standard-15",
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
  it("模型环境变量仅接受登记名称并从注入环境的自有字段读取", () => {
    const env = Object.assign(Object.create({ NPC_OPENAI_COMPAT_MODEL: "outside-config" }) as Record<string, string>, {
      NPC_OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:11434/v1",
      NPC_OPENAI_COMPAT_MODEL: "fixture-model",
    });
    expect(resolveModelEnv("env:NPC_OPENAI_COMPAT_MODEL", { configDir, env })).toBe("fixture-model");
    for (const ref of ["env:INHERITED_KEY", "env:NPC_OPENAI_COMPAT_MODEL\n", "env:"]) {
      expect(captureLoadingError(() => resolveModelEnv(ref, { configDir, env })).code).toBe("env");
    }
    const inheritedOnly = Object.create({
      NPC_OPENAI_COMPAT_MODEL: "outside-config",
    }) as Record<string, string>;
    expect(captureLoadingError(() =>
      resolveModelEnv("env:NPC_OPENAI_COMPAT_MODEL", { configDir, env: inheritedOnly })).code,
    ).toBe("env");
  });

  it("模型夹具拒绝目录外引用、重复 ID、非法 JSON 和过大的文件", () => {
    const repo = makeTempConfigDir();
    try {
      const context = { configDir: join(repo, "config") };
      const directory = join(repo, "tests", "fixtures", "model");
      mkdirSync(context.configDir);
      mkdirSync(directory, { recursive: true });
      const local = join(directory, "sample.jsonl");
      const ref = "tests/fixtures/model/sample.jsonl";
      const line = JSON.stringify({ id: "known", match: { purpose: "decision" }, response: { finishReason: "stop" } });
      writeFileSync(local, `${line}\n${line}`, "utf8");
      expect(() => loadModelFixtures(["tests/fixtures/model/../outside.jsonl"], context)).toThrow();
      expect(captureLoadingError(() => loadModelFixtures([ref], context)).message).toContain("夹具 ID 重复");
      writeFileSync(local, "{", "utf8");
      expect(captureLoadingError(() => loadModelFixtures([ref], context)).message).toContain("夹具行不是合法 JSON");
      writeFileSync(local, "x".repeat(1_048_577), "utf8");
      expect(captureLoadingError(() => loadModelFixtures([ref], context)).message).toContain("不超过 1 MiB");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("从仓库 config/ 加载 online-default 与 core-3", () => {
    const run = loadRunSpec("online-default", { configDir }, { seed: "online-seed-test" });
    expect(run.value.id).toBe("online-default");
    expect(run.source.endsWith("online-default.yaml")).toBe(true);
    expect(run.value.seed).toBe("online-seed-test");

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
        ...loadRunSpec("online-default", { configDir }, { seed: "online-seed-test" }).value,
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

  it("同一上下文内的文档缓存复用解析结果，新上下文重新读取磁盘", () => {
    const tempDir = makeTempConfigDir();
    try {
      const rostersDir = join(tempDir, "rosters");
      mkdirSync(rostersDir, { recursive: true });
      const rosterPath = join(rostersDir, "sample-roster.yaml");
      writeFileSync(rosterPath, rosterYaml("sample-roster"), "utf8");
      const first = loadRoster("sample-roster", { configDir: tempDir, cache: createConfigDocumentCache() });
      expect(first.value.rosterId).toBe("sample-roster");

      // 同一缓存内改写磁盘不应被观察：缓存的生命周期与一次启动/预检绑定，不能跨请求复用。
      const cache = createConfigDocumentCache();
      loadRoster("sample-roster", { configDir: tempDir, cache });
      writeFileSync(rosterPath, rosterYaml("stale-roster"), "utf8");
      expect(loadRoster("sample-roster", { configDir: tempDir, cache }).value.rosterId).toBe("sample-roster");

      // 新建上下文必须重新读取：配置变更在下一轮装配立即生效，不会被缓存掩盖。
      expect(captureLoadingError(() => loadRoster("sample-roster", { configDir: tempDir })).path).toBe("rosterId");
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
        sampleValue: z.string().min(1),
        label: z.string().min(1),
        nested: z.object({ endpoint: z.string().url() }).strict(),
      })
      .strict();

    const loaded = loadConfigDocument("env-sample", schema, {
      configDir: fixturesConfigDir,
      env: { NPC_TEST_VALUE: "resolved-value", NPC_TEST_ENDPOINT: "http://127.0.0.1:3000" },
    });
    expect(loaded.value.sampleValue).toBe("resolved-value");
    expect(loaded.value.label).toBe("plain");
    expect(loaded.value.nested.endpoint).toBe("http://127.0.0.1:3000");

    const missing = captureLoadingError(() =>
      loadConfigDocument("env-sample", schema, {
        configDir: fixturesConfigDir,
        env: { NPC_TEST_VALUE: "resolved-value" },
      }),
    );
    expect(missing.code).toBe("env");
    expect(missing.path).toBe("nested.endpoint");

    const empty = captureLoadingError(() =>
      loadConfigDocument("env-sample", schema, {
        configDir: fixturesConfigDir,
        env: { NPC_TEST_VALUE: "", NPC_TEST_ENDPOINT: "http://127.0.0.1:3000" },
      }),
    );
    expect(empty.code).toBe("env");
    expect(empty.path).toBe("sampleValue");
  });

  it("拒绝内部 ID 与引用不一致的配置", () => {
    const tempDir = makeTempConfigDir();
    try {
      const rostersDir = join(tempDir, "rosters");
      mkdirSync(rostersDir, { recursive: true });
      writeFileSync(join(rostersDir, "mismatch-roster.yaml"), rosterYaml("other-name"), "utf8");
      const rosterError = captureLoadingError(() =>
        loadRoster("mismatch-roster", { configDir: tempDir }),
      );
      expect(rosterError.code).toBe("reference");
      expect(rosterError.path).toBe("rosterId");

      const runsDir = join(tempDir, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(join(runsDir, "mismatch-run.yaml"), runSpecYaml("other-name"), "utf8");
      const runError = captureLoadingError(() =>
        loadRunSpec("mismatch-run", { configDir: tempDir }),
      );
      expect(runError.code).toBe("reference");
      expect(runError.path).toBe("id");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("五个记忆对比变体均可解析并切到对应槽位", () => {
    const base = loadAgentProfile("agent-character-default", { configDir });
    const windowProfile = applyProfilePatch(base, "memory-m0-window", { configDir });
    const currentProfile = applyProfilePatch(base, "memory-m0-current", { configDir });
    const m1Profile = applyProfilePatch(base, "memory-m1-structured-ledger", { configDir });
    const m2Profile = applyProfilePatch(base, "memory-m2-stream-reflection", { configDir });
    const m3Profile = applyProfilePatch(base, "memory-m3-layered-hybrid", { configDir });
    expect(windowProfile.slots.memory?.module).toBe("agent.memory.none");
    expect(windowProfile.slots.context?.config.historyTurns).toBe(8);
    expect(currentProfile.slots.context?.config.historyTurns).toBe(0);
    expect(m1Profile.slots.memory?.module).toBe("agent.memory.ledger");
    expect(m2Profile.slots.memory?.module).toBe("agent.memory.stream-reflection");
    expect(m2Profile.slots.memory?.config).toMatchObject({ maintenanceTrigger: "importance-threshold" });
    expect(m3Profile.slots.memory?.module).toBe("agent.memory.layered-hybrid");
    expect(m3Profile.slots.memory?.config).toMatchObject({ coreBlockMaxTokens: 300 });
  });

  it("M0 两个变体保留了模型决策所需的上下文预算块", () => {
    // context 槽位按整块替换，不继承父 profile；变体若只写 historyTurns，
    // 模型决策会在预检时报「缺少 decision 预算块」。这里锁定基线预算块仍在。
    const base = loadAgentProfile("agent-character-default", { configDir });
    for (const variant of ["memory-m0-window", "memory-m0-current"]) {
      const profile = applyProfilePatch(base, variant, { configDir });
      const config = profile.slots.context?.config ?? {};
      expect(config, variant).toMatchObject({
        lendUnusedBudget: false,
        decision: {
          maxInputTokens: 8000,
          safetyTokens: 300,
          toolLoopReserveTokens: 1600,
          segmentBudgets: { world: 800, task: 500, memory: 1000, history: 800 },
        },
        speech: { maxInputTokens: 2500, safetyTokens: 200, segmentBudgets: { facts: 800, history: 400 } },
      });
      expect(config.segmentOrder).toEqual(["world", "task", "memory", "history", "input"]);
    }
  });

  it("profile 与 toolset 的配置失败类型统一带 code、source 与 path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-npc-profile-ref-"));
    try {
      // profileId 与文件引用不一致：属于引用解析失败，必须能按 code 分类并定位到字段。
      writeFileSync(
        join(tempDir, "agent-mismatch.yaml"),
        [
          "schemaVersion: 1",
          "profileId: agent-other",
          "kind: agent",
          "parent: null",
          "",
        ].join("\n"),
        "utf8",
      );
      const profileError = captureLoadingError(() =>
        loadAgentProfile("agent-mismatch", { configDir: tempDir }),
      );
      expect(profileError.code).toBe("reference");
      expect(profileError.path).toBe("profileId");
      expect(profileError.source.endsWith("agent-mismatch.yaml")).toBe(true);

      writeFileSync(
        join(tempDir, "toolset-mismatch.yaml"),
        [
          "schemaVersion: 1",
          "toolsetId: other-toolset",
          "tools:",
          "  - { toolId: world.inspect, version: \"1\", permissionProfile: self-known, budgetProfile: query, viewConstraints: { maxListItems: 5, maxTokens: 300 } }",
          "",
        ].join("\n"),
        "utf8",
      );
      const toolsetError = captureLoadingError(() =>
        loadAgentToolset("toolset-mismatch", { configDir: tempDir }),
      );
      expect(toolsetError.code).toBe("reference");
      expect(toolsetError.path).toBe("toolsetId");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("profile 继承链成环时报引用与路径", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-npc-profile-cycle-"));
    try {
      writeFileSync(
        join(tempDir, "agent-cycle-a.yaml"),
        ["schemaVersion: 1", "profileId: agent-cycle-a", "kind: agent", "parent: agent-cycle-b", ""].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(tempDir, "agent-cycle-b.yaml"),
        ["schemaVersion: 1", "profileId: agent-cycle-b", "kind: agent", "parent: agent-cycle-a", ""].join("\n"),
        "utf8",
      );
      const error = captureLoadingError(() => loadAgentProfile("agent-cycle-a", { configDir: tempDir }));
      expect(error.code).toBe("reference");
      expect(error.path).toBe("parent");
      expect(error.message).toContain("->");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("只有 variant 允许声明 patch，其他 kind 声明即被拒绝", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-npc-profile-patch-"));
    try {
      // 非 variant 声明 patch 时，自身 slots 会被 applyPatch 的 `patch ?? document` 静默丢弃。
      writeFileSync(
        join(tempDir, "agent-with-patch.yaml"),
        [
          "schemaVersion: 1",
          "profileId: agent-with-patch",
          "kind: agent",
          "parent: null",
          "patch:",
          "  slots:",
          "    memory: { module: agent.memory.ledger, config: {} }",
          "",
        ].join("\n"),
        "utf8",
      );
      const error = captureLoadingError(() => loadAgentProfile("agent-with-patch", { configDir: tempDir }));
      expect(error.code).toBe("schema");
      expect(error.path).toBe("patch");
      expect(error.message).toContain("variant");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("非 variant profile 省略 parent 时被拒绝", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-npc-profile-parent-"));
    try {
      // 只有 variant 可以省略 parent；其余 kind 必须显式写 parent 或 null，
      // 否则继承链起点会变成隐式默认值。
      for (const kind of ["platform", "scene", "agent"]) {
        const profileId = `${kind}-no-parent`;
        writeFileSync(
          join(tempDir, `${profileId}.yaml`),
          ["schemaVersion: 1", `profileId: ${profileId}`, `kind: ${kind}`, ""].join("\n"),
          "utf8",
        );
        const error = captureLoadingError(() => loadAgentProfile(profileId, { configDir: tempDir }));
        expect(error.code, kind).toBe("schema");
        expect(error.path, kind).toBe("parent");
        expect(error.message, kind).toContain("variant");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("variant 省略 parent 时按继承链起点加载", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-npc-profile-variant-"));
    try {
      // 文档中的变体形状不带 parent；省略必须与显式 null 等价，否则照抄示例会被拒绝。
      writeFileSync(
        join(tempDir, "variant-omitted-parent.yaml"),
        [
          "schemaVersion: 1",
          "profileId: variant-omitted-parent",
          "kind: variant",
          "patch:",
          "  slots:",
          "    memory: { module: agent.memory.ledger, config: {} }",
          "",
        ].join("\n"),
        "utf8",
      );
      const base = loadAgentProfile("agent-character-default", { configDir });
      const patched = applyProfilePatch(base, "variant-omitted-parent", { configDir: tempDir });
      expect(patched.slots.memory?.module).toBe("agent.memory.ledger");
      // 未改动的槽位继续来自父 profile，不会被 variant 清空。
      expect(patched.slots.decision?.module).toBe(base.slots.decision?.module);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("未知键被严格拒绝", () => {
    const error = captureLoadingError(() => loadRunSpec("run-unknown-key", { configDir: fixturesConfigDir }));
    expect(error.code).toBe("schema");
    expect(error.source.endsWith("run-unknown-key.yaml")).toBe(true);
    expect(error.message).toContain("unexpected");
  });

  it("多处 schema 问题时列出全部位置而不是只报第一条", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ai-npc-schema-multi-"));
    try {
      writeFileSync(
        join(tempDir, "multi-bad.yaml"),
        ["schemaVersion: 1", "assemblyId: 42", "configs: {}", "realms: {}", ""].join("\n"),
        "utf8",
      );
      const error = captureLoadingError(() =>
        loadConfigDocument(
          "multi-bad",
          z.strictObject({ schemaVersion: z.literal(1), assemblyId: z.string(), configs: z.record(z.string(), z.unknown()) }),
          { configDir: tempDir },
        ),
      );
      expect(error.code).toBe("schema");
      // 单条问题时保持精确路径；这里有多条，原因里逐条带路径。
      expect(error.message).toContain("assemblyId");
      expect(error.message).toContain("realms");
      expect(error.message).toContain("共 2 处");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("RunSpec 交叉检查", () => {  const content = loadContentPack(contentRoot, "earth-2964-v1");
  const run = loadRunSpec("online-default", { configDir }, { seed: "online-seed-test" });

  it("宿主可把实际启动选择并入模板并仍按严格 schema 校验", () => {
    const loaded = loadRunSpec("online-default", { configDir }, {
      seed: "run-seed-1",
      moduleAssemblyRef: "local-slg-escalating-v1",
      worldPackRef: "earth-2964-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
    });
    expect(loaded.value).toMatchObject({
      seed: "run-seed-1",
      moduleAssemblyRef: "local-slg-escalating-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
    });
    expect(() => loadRunSpec("online-default", { configDir }, { seed: "" })).toThrow();
    expect(() => loadRunSpec("online-default", { configDir })).toThrow();
  });

  it("online-default 的引用与内容一致", () => {
    expect(() => validateRunSpec(run.value, content)).not.toThrow();
    const roster = loadRoster("standard-15", { configDir });
    expect(() => validateRunSpec(run.value, content, roster, run.source)).not.toThrow();
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

  it("脚本引用可被解析到内容索引，缺失分支被拒绝", () => {
    const coreRun: RunSpec = {
      ...run.value,
      rosterRef: "core-3",
      script: { scriptRef: "s-promise", branch: "keep" },
    };
    expect(validateRunSpec(coreRun, content)).toBeUndefined();

    const branchError = captureLoadingError(() =>
      validateRunSpec(
        { ...coreRun, script: { scriptRef: "s-promise", branch: "missing-branch" } },
        content,
      ),
    );
    expect(branchError.path).toBe("script.branch");

    const rosterError = captureLoadingError(() =>
      validateRunSpec(
        { ...coreRun, rosterRef: "standard-15" },
        content,
        loadRoster("standard-15", { configDir }),
      ),
    );
    expect(rosterError.path).toBe("rosterRef");
  });
});
