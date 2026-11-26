/**
 * 校验 catalog 预检：目录扫描、模块目录一致性、运行时依赖闭包、环、重复绑定、realm 与配置 schema。
 * 依赖真实装配目录、临时 YAML 夹具与最小假模块；不启动服务、不打开存储。
 * 禁止写死装配文件名或只断言异常存在而不核对原因。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  assemblyDescriptorSchema,
  capabilityIdSchema,
  type AssemblyDescriptor,
  type CapabilityRef,
  type ModuleDefinition,
  type Realm,
} from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { clockConfigSchema } from "@ai-npc/mod-game-clock-controlled";
import { checkCatalog, runCatalogCheckCli } from "@ai-npc/scripts/check-catalog";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function capability(capabilityId: string, realm: Realm = "server"): CapabilityRef {
  return {
    capability: capabilityIdSchema.parse(capabilityId),
    cardinality: "exactly-one",
    instanceScope: realm === "server" ? "run" : "session",
  };
}

/** 构造通过描述符校验的最小模块；create 在预检阶段不会被调用。 */
function fakeModule(input: {
  readonly id: string;
  readonly provides: readonly string[];
  readonly requires?: readonly string[];
  readonly realm?: Realm;
}): ModuleDefinition {
  const realm = input.realm ?? "server";
  return defineModule({
    id: input.id,
    realm,
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: realm === "server" ? "run" : "session",
    provides: input.provides.map((id) => capability(id, realm)),
    requires: (input.requires ?? []).map((id) => capability(id, realm)),
    requiresRemote: [],
    configSchema: clockConfigSchema,
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async () => {
      throw new Error(`预检不应创建模块 ${input.id}`);
    },
  });
}

function assembly(input: {
  readonly assemblyId: string;
  readonly bindings?: readonly { capability: string; moduleId: string; configRef?: string | null }[];
  readonly configs?: Readonly<Record<string, unknown>>;
}): AssemblyDescriptor {
  return assemblyDescriptorSchema.parse({
    schemaVersion: 1,
    assemblyId: input.assemblyId,
    configs: input.configs ?? {},
    realms: {
      server: {
        bindings: (input.bindings ?? []).map((binding) => ({
          capability: binding.capability,
          moduleId: binding.moduleId,
          configRef: binding.configRef ?? null,
        })),
      },
      client: { bindings: [] },
      console: { bindings: [] },
    },
  });
}

function fixtureRoot(assemblies: Readonly<Record<string, AssemblyDescriptor>>): string {
  const root = mkdtempSync(join(tmpdir(), "ai-npc-catalog-test-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "config/assemblies"), { recursive: true });
  for (const [fileName, value] of Object.entries(assemblies)) {
    writeFileSync(join(root, "config/assemblies", fileName), stringify(value), "utf8");
  }
  return root;
}

function messagesOf(report: ReturnType<typeof checkCatalog>): string {
  return report.violations.map((violation) => violation.message).join("\n");
}

describe("catalog 预检", () => {
  it("扫描真实装配目录并全部解析通过", () => {
    const report = checkCatalog({ root: repositoryRoot });
    expect(report.violations).toEqual([]);
    expect([...report.assemblies].sort()).toEqual([
      "local-slg-escalating-v1",
      "local-slg-standard-v1",
      "local-slg-test-v1",
    ]);
  });

  it("目录扫描发现全部 YAML 装配而不是固定文件名", () => {
    const map = fakeModule({ id: "game.map.six-nodes", provides: ["game.map"] });
    const world = fakeModule({ id: "game.world.slg-light", provides: ["game.world"], requires: ["game.map"] });
    const root = fixtureRoot({
      "first.yaml": assembly({
        assemblyId: "assembly-a",
        bindings: [
          { capability: "game.map", moduleId: "game.map.six-nodes" },
          { capability: "game.world", moduleId: "game.world.slg-light" },
        ],
      }),
      "second.yml": assembly({
        assemblyId: "assembly-b",
        bindings: [{ capability: "game.map", moduleId: "game.map.six-nodes" }],
      }),
    });
    const report = checkCatalog({ root, definitions: [map, world], requiredCapabilities: [] });
    expect(report.violations).toEqual([]);
    expect([...report.assemblies].sort()).toEqual(["assembly-a", "assembly-b"]);
  });

  it("缺失运行时依赖失败并给出消费方与缺失能力", () => {
    const world = fakeModule({ id: "game.world.slg-light", provides: ["game.world"], requires: ["game.clock"] });
    const root = fixtureRoot({
      "missing.yaml": assembly({
        assemblyId: "assembly-missing",
        bindings: [{ capability: "game.world", moduleId: "game.world.slg-light" }],
      }),
    });
    const report = checkCatalog({ root, definitions: [world], requiredCapabilities: [] });
    expect(messagesOf(report)).toContain("game.clock");
    expect(messagesOf(report)).toContain("缺少必需");
  });

  it("循环依赖失败并打印环路", () => {
    const actions = fakeModule({ id: "game.actions.standard", provides: ["game.actions"], requires: ["game.map"] });
    const map = fakeModule({ id: "game.map.six-nodes", provides: ["game.map"], requires: ["game.actions"] });
    const root = fixtureRoot({
      "cycle.yaml": assembly({
        assemblyId: "assembly-cycle",
        bindings: [
          { capability: "game.actions", moduleId: "game.actions.standard" },
          { capability: "game.map", moduleId: "game.map.six-nodes" },
        ],
      }),
    });
    const report = checkCatalog({ root, definitions: [actions, map], requiredCapabilities: [] });
    expect(report.violations.some((violation) => violation.code === "assembly-incompatible")).toBe(true);
    expect(messagesOf(report)).toContain("->");
    expect(messagesOf(report)).toContain("game.actions.standard");
  });

  it("同一能力重复绑定失败", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const manual = fakeModule({ id: "game.clock.manual", provides: ["game.clock"] });
    const root = fixtureRoot({
      "duplicate.yaml": assembly({
        assemblyId: "assembly-duplicate",
        bindings: [
          { capability: "game.clock", moduleId: "game.clock.controlled" },
          { capability: "game.clock", moduleId: "game.clock.manual" },
        ],
      }),
    });
    const report = checkCatalog({ root, definitions: [clock, manual], requiredCapabilities: [] });
    expect(
      report.violations.some(
        (violation) => violation.code === "binding-duplicate" || violation.code === "capability-conflict",
      ),
    ).toBe(true);
    expect(messagesOf(report)).toContain("game.clock");
  });

  it("realm 不匹配失败", () => {
    const hud = fakeModule({ id: "client.hud.standard", realm: "client", provides: ["client.hud"] });
    const root = fixtureRoot({
      "realm.yaml": assembly({
        assemblyId: "assembly-realm",
        bindings: [{ capability: "client.hud", moduleId: "client.hud.standard" }],
      }),
    });
    const report = checkCatalog({ root, definitions: [hud], requiredCapabilities: [] });
    expect(report.violations.some((violation) => violation.code === "realm-violation")).toBe(true);
    expect(messagesOf(report)).toContain("client");
  });

  it("模块配置不符合 schema 失败并定位字段", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const root = fixtureRoot({
      "config.yaml": assembly({
        assemblyId: "assembly-config",
        configs: { clock: { secondsPerTick: "ten" } },
        bindings: [{ capability: "game.clock", moduleId: "game.clock.controlled", configRef: "clock" }],
      }),
    });
    const report = checkCatalog({ root, definitions: [clock], requiredCapabilities: [] });
    expect(report.violations.some((violation) => violation.code === "assembly-incompatible")).toBe(true);
    expect(messagesOf(report)).toContain("配置校验失败");
    expect(messagesOf(report)).toContain("secondsPerTick");
  });

  it("装配 schema 失败时给出代码与字段路径", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const root = mkdtempSync(join(tmpdir(), "ai-npc-catalog-schema-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "config/assemblies"), { recursive: true });
    // 绕开 assembly() 助手直接写文件：schemaVersion 必须是未知版本才会触发 schema 失败。
    writeFileSync(
      join(root, "config/assemblies/bad-schema.yaml"),
      [
        "schemaVersion: 2",
        "assemblyId: assembly-bad-schema",
        "configs: {}",
        "realms:",
        "  server: { bindings: [] }",
        "  client: { bindings: [] }",
        "  console: { bindings: [] }",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = checkCatalog({ root, definitions: [clock], requiredCapabilities: [] });
    const violation = report.violations.find((entry) => entry.code === "assembly-schema");
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("schemaVersion");
  });

  it("重复 assemblyId 与越界符号链接在预检阶段失败", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const duplicateRoot = fixtureRoot({
      "first.yaml": assembly({ assemblyId: "assembly-dup" }),
      "second.yaml": assembly({ assemblyId: "assembly-dup" }),
    });
    const duplicateReport = checkCatalog({ root: duplicateRoot, definitions: [clock], requiredCapabilities: [] });
    expect(duplicateReport.violations.some((violation) => violation.code === "assembly-duplicate")).toBe(true);

    // 指向装配目录外的符号链接必须被拒绝：启动路径与 check:catalog 共用同一扫描实现。
    const linkRoot = fixtureRoot({ "kept.yaml": assembly({ assemblyId: "assembly-kept" }) });
    const outside = join(linkRoot, "outside.yaml");
    writeFileSync(outside, stringify(assembly({ assemblyId: "assembly-outside" })), "utf8");
    try {
      symlinkSync(outside, join(linkRoot, "config/assemblies/linked.yaml"));
    } catch {
      // 无权限创建符号链接的环境跳过该半段断言，重复 ID 已覆盖扫描失败路径。
      return;
    }
    const linkReport = checkCatalog({ root: linkRoot, definitions: [clock], requiredCapabilities: [] });
    expect(
      linkReport.violations.some(
        (violation) => violation.code === "assembly-unreadable" || violation.code === "assembly-duplicate",
      ),
    ).toBe(true);
  });

  it("CLI 在失败时非零退出并逐项打印原因", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const root = fixtureRoot({
      "bad.yaml": assembly({
        assemblyId: "assembly-bad",
        configs: { clock: { secondsPerTick: -1 } },
        bindings: [{ capability: "game.clock", moduleId: "game.clock.controlled", configRef: "clock" }],
      }),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = runCatalogCheckCli({
      root,
      definitions: [clock],
      requiredCapabilities: [],
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    expect(code).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("catalog 校验失败");
    expect(stderr.join("")).toContain("[assembly-incompatible]");
    expect(stderr.join("")).toContain("secondsPerTick");
  });
});
