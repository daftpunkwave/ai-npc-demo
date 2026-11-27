/**
 * 校验 catalog 预检：目录扫描、模块目录一致性、运行时依赖闭包、环、重复绑定、realm、配置 schema 与其幂等契约。
 * 依赖真实装配目录、临时 YAML 夹具与最小假模块；不启动服务、不打开存储。
 * 禁止写死装配文件名或只断言异常存在而不核对原因。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { z } from "zod";
import {
  assemblyDescriptorSchema,
  capabilityIdSchema,
  type AssemblyDescriptor,
  type CapabilityRef,
  type ModuleDefinition,
  type Realm,
} from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { clockConfigSchema } from "@world-prism/mod-game-clock-controlled";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { checkCatalog, runCatalogCheckCli } from "@world-prism/scripts/check-catalog";

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
  readonly requiresRemote?: readonly string[];
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
    requiresRemote: (input.requiresRemote ?? []).map((id) => capabilityIdSchema.parse(id)),
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
  readonly consoleBindings?: readonly { capability: string; moduleId: string }[];
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
      console: {
        bindings: (input.consoleBindings ?? []).map((binding) => ({ ...binding, configRef: null })),
      },
    },
  });
}

function fixtureRoot(assemblies: Readonly<Record<string, AssemblyDescriptor>>): string {
  const root = mkdtempSync(join(tmpdir(), "world-prism-catalog-test-"));
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

  it("控制台模块的 requiresRemote 不在 server 段绑定内时预检失败并列出缺失能力", () => {
    const observability = fakeModule({ id: "platform.observability.sqlite", provides: ["platform.observability"] });
    const page = fakeModule({
      id: "console.health.standard",
      realm: "console",
      provides: ["console.health"],
      requiresRemote: ["platform.observability", "platform.operations"],
    });
    const root = fixtureRoot({
      "remote.yaml": assembly({
        assemblyId: "assembly-remote",
        bindings: [{ capability: "platform.observability", moduleId: "platform.observability.sqlite" }],
        consoleBindings: [{ capability: "console.health", moduleId: "console.health.standard" }],
      }),
    });
    const report = checkCatalog({ root, definitions: [observability, page], requiredCapabilities: [] });
    expect(report.violations).toEqual([
      {
        file: "remote.yaml",
        code: "assembly-incompatible",
        message: expect.stringContaining("console.health.standard 缺少 platform.operations"),
      },
    ]);
  });

  it("配置 schema 用改变类型的 transform 时，默认配置与装配配置两条路径都报对自身输出不幂等", () => {
    // 带默认值的模块即使没有进入任何装配，也按默认配置核对。
    const withDefault = defineModule({
      ...fakeModule({ id: "platform.budget.standard", provides: ["platform.budget"] }),
      configSchema: z.strictObject({ ceiling: z.string().default("100").transform(Number) }),
    });
    // 必须由装配提供配置的模块，按装配解析出的配置核对。
    const fromAssembly = defineModule({
      ...fakeModule({ id: "transport.http-ws.fastify", provides: ["transport.http-ws"] }),
      configSchema: z.strictObject({ port: z.string().transform(Number) }),
    });
    const root = fixtureRoot({
      "transform.yaml": assembly({
        assemblyId: "assembly-transform",
        configs: { transport: { port: "8080" } },
        bindings: [{ capability: "transport.http-ws", moduleId: "transport.http-ws.fastify", configRef: "transport" }],
      }),
    });
    const report = checkCatalog({ root, definitions: [withDefault, fromAssembly], requiredCapabilities: [] });
    expect(report.violations).toEqual([
      {
        file: "<module-catalog>",
        code: "assembly-incompatible",
        message: expect.stringContaining("platform.budget.standard 的默认配置"),
      },
      {
        file: "transform.yaml",
        code: "assembly-incompatible",
        message: expect.stringContaining("transport.http-ws.fastify 的 configSchema 对自身输出不幂等"),
      },
    ]);
    expect(report.violations[0]?.message).toContain("对自身输出不幂等");
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

  it("装配配置块声明只由部署环境提供的 retentionDays 时失败并点名配置块、键与环境变量", () => {
    const storageAssembly = (storage: Readonly<Record<string, unknown>>): AssemblyDescriptor => assembly({
      assemblyId: "assembly-storage",
      configs: { storage },
      bindings: [{ capability: "platform.storage", moduleId: storageModuleDefinition.id, configRef: "storage" }],
    });
    const accepted = checkCatalog({
      root: fixtureRoot({ "storage.yaml": storageAssembly({ inlineArtifactMaxBytes: 65536 }) }),
      definitions: [storageModuleDefinition],
      requiredCapabilities: [],
    });
    expect(accepted.violations).toEqual([]);
    // 存储配置 schema 本身接受 retentionDays；拦截来自装配检查，而不是 schema。
    const rejected = checkCatalog({
      root: fixtureRoot({
        "storage.yaml": storageAssembly({ inlineArtifactMaxBytes: 65536, retentionDays: { trace_spans: 30 } }),
      }),
      definitions: [storageModuleDefinition],
      requiredCapabilities: [],
    });
    expect(rejected.violations).toEqual([{
      file: "storage.yaml",
      code: "assembly-incompatible",
      message: expect.stringContaining("装配配置块 storage 不能为模块 platform.storage.sqlite 声明 retentionDays"),
    }]);
    expect(messagesOf(rejected)).toContain("WORLD_PRISM_TRACE_SPANS_RETENTION_DAYS");
  });

  it("装配 schema 失败时给出代码与字段路径", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const root = mkdtempSync(join(tmpdir(), "world-prism-catalog-schema-"));
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

  it("重复 assemblyId 与不可用装配文件在预检阶段失败", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const duplicateRoot = fixtureRoot({
      "first.yaml": assembly({ assemblyId: "assembly-dup" }),
      "second.yaml": assembly({ assemblyId: "assembly-dup" }),
    });
    const duplicateReport = checkCatalog({ root: duplicateRoot, definitions: [clock], requiredCapabilities: [] });
    expect(duplicateReport.violations.some((violation) => violation.code === "assembly-duplicate")).toBe(true);

    // 以 .yaml 结尾的目录必须被拒绝而不是静默跳过：启动路径与 check:catalog 共用同一扫描实现。
    // 用目录而非符号链接构造，避免测试依赖创建符号链接的管理员权限。
    const notPlainRoot = fixtureRoot({ "kept.yaml": assembly({ assemblyId: "assembly-kept" }) });
    mkdirSync(join(notPlainRoot, "config/assemblies/not-a-file.yaml"));
    const notPlainReport = checkCatalog({ root: notPlainRoot, definitions: [clock], requiredCapabilities: [] });
    expect(notPlainReport.violations.some((violation) => violation.code === "assembly-unreadable")).toBe(true);
  });

  it("不可用装配文件与其他装配问题一并累积", () => {
    const clock = fakeModule({ id: "game.clock.controlled", provides: ["game.clock"] });
    const root = fixtureRoot({ "kept.yaml": assembly({ assemblyId: "assembly-kept" }) });
    // 以 .yaml 结尾的目录不可用，但与 schema 失败应同时出现在同一份报告里，
    // 单文件失败不能中断其余文件的诊断。
    mkdirSync(join(root, "config/assemblies/not-a-file.yaml"));
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
    expect(report.violations.some((violation) => violation.code === "assembly-unreadable")).toBe(true);
    expect(report.violations.some((violation) => violation.code === "assembly-schema")).toBe(true);
    // 可用的装配仍然被计入结果，不因同目录的其他失败项而丢失。
    expect(report.assemblies).toContain("assembly-kept");
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
