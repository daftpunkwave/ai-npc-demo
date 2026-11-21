/**
 * 校验模块源码能力访问与 provides/requires 的静态对账。
 * 依赖临时模块目录、最小模块定义与 app-server 公开的对账函数。
 * 禁止依赖真实模块实现或让测试共享临时目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { checkModuleCapabilityUsage } from "@ai-npc/app-server";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function moduleDefinition(input: {
  readonly id: string;
  readonly provides: readonly string[];
  readonly requires?: readonly string[];
}): ModuleDefinition {
  return defineModule({
    id: input.id,
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "run",
    provides: input.provides.map((capability) => ({
      capability: capabilityIdSchema.parse(capability),
      cardinality: "exactly-one",
      instanceScope: "run",
    })),
    requires: (input.requires ?? []).map((capability) => ({
      capability: capabilityIdSchema.parse(capability),
      cardinality: "exactly-one",
      instanceScope: "run",
    })),
    requiresRemote: [],
    configSchema: emptyModuleConfigSchema,
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async () => {
      throw new Error("静态对账不应创建模块实例");
    },
  });
}

/** 按仓库目录约定写入模块源码目录，返回仓库根路径。 */
function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "ai-npc-capability-usage-"));
  temporaryRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
  return root;
}

function sourceModule(id: string, fileName: string, content: string): Record<string, string> {
  const [group, family, implementation] = id.split(".");
  const directory = `modules/server/${String(group)}/${String(family)}/${String(implementation)}/src`;
  return {
    [`${directory}/definition.ts`]: "export {};\n",
    [`${directory}/${fileName}`]: content,
  };
}

const map = moduleDefinition({ id: "game.map.six-nodes", provides: ["game.map"] });
const world = moduleDefinition({
  id: "game.world.slg-light",
  provides: ["game.world"],
  requires: ["game.map"],
});

describe("模块能力声明对账", () => {
  it("访问未声明的能力时报告漏声明", () => {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = ports[\"game.world\"];\n"),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations).toEqual([
      expect.objectContaining({ code: "capability-undeclared", file: expect.stringContaining("map/six-nodes") }),
    ]);
    expect(violations[0]?.message).toContain("game.world");
  });

  it("声明了未访问的能力时报告多余声明", () => {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = roadsOf();\n"),
      ...sourceModule("game.world.slg-light", "port.ts", "export const state = ownState;\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.map((violation) => violation.code)).toContain("capability-unused");
    expect(violations.map((violation) => violation.message).join("\n")).toContain("game.map");
  });

  it("访问目录中不存在的能力时报告拼写错误", () => {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = ports[\"game.wolrd\"];\n"),
      ...sourceModule("game.world.slg-light", "port.ts", "export const state = ownState;\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.map((violation) => violation.code)).toContain("capability-unknown");
  });

  it("访问与声明一致时没有违规", () => {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = roadsOf();\n"),
      ...sourceModule(
        "game.world.slg-light",
        "port.ts",
        "export const roads = ports[\"game.map\"];\nexport const own = ports[\"game.world\"];\n",
      ),
    });
    expect(checkModuleCapabilityUsage({ root, definitions: [map, world] })).toEqual([]);
  });

  it("登记定义没有源码目录时报告目录缺失", () => {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = roadsOf();\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.map((violation) => violation.code)).toContain("module-source-missing");
    expect(violations.map((violation) => violation.message).join("\n")).toContain("game.world.slg-light");
  });
});
