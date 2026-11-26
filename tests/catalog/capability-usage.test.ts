/**
 * 校验模块源码能力访问与 provides/requires 的静态对账。
 * 依赖临时模块目录、最小模块定义与 app-server 公开的对账函数。
 * 禁止依赖真实模块实现或让测试共享临时目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { checkModuleCapabilityUsage } from "@world-prism/app-server";

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
  const root = mkdtempSync(join(tmpdir(), "world-prism-capability-usage-"));
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

  it("注释与字符串字面量里的能力名不算访问", () => {
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "// ports[\"game.world\"] 只是注释",
          "const label = \"ports[\\\"game.world\\\"]\";",
          "const declared = [\"game.world\"];",
          "export const roads = roadsOf(declared, label);",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    expect(checkModuleCapabilityUsage({ root, definitions: [map, world] })).toEqual([]);
  });

  it("跨行索引访问与解构键都能被发现", () => {
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "export const roads = ports[",
          "  \"game.world\"",
          "];",
          "const { \"game.world\": state } = context.modules;",
          "export const combined = [roads, state];",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.filter((violation) => violation.code === "capability-undeclared")).toHaveLength(2);
    expect(violations.map((violation) => violation.file)).toEqual([
      expect.stringContaining("map/six-nodes"),
      expect.stringContaining("map/six-nodes"),
    ]);
  });

  it("可选链索引访问与普通索引访问等价，都能发现未声明的能力", () => {
    // 可选链是常见写法；若扫描器把 `?.` 误判成非成员访问，
    // 同一句能力访问改写后就会静默逃过对账，隐藏依赖只在运行时以 undefined 崩溃暴露。
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = ports?.[\"game.world\"];\n"),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations).toEqual([
      expect.objectContaining({ code: "capability-undeclared", file: expect.stringContaining("map/six-nodes") }),
    ]);
    expect(violations[0]?.message).toContain("game.world");
  });

  it("深层接收者的可选链与跨行可选链同样被识别", () => {
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "export const a = input.ports?.[\"game.world\"];",
          "export const b = input.ports?.",
          "  [\"game.world\"];",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(
      violations.filter((violation) => violation.code === "capability-undeclared"),
    ).toHaveLength(2);
  });

  it("可选链访问已声明的能力时不报违规", () => {
    // 反向对照：识别范围扩大后不能把合法用例也判成违规。
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = roadsOf();\n"),
      ...sourceModule(
        "game.world.slg-light",
        "port.ts",
        "export const roads = ports?.[\"game.map\"];\nexport const own = ports?.[\"game.world\"];\n",
      ),
    });
    expect(checkModuleCapabilityUsage({ root, definitions: [map, world] })).toEqual([]);
  });

  it("展开运算符里的数组字面量不算能力访问", () => {
    // `...["game.world"]` 的 `[` 前面也是 `.`，若不区分展开与成员访问，
    // 合法模块会被误判成访问了未声明的能力，装配检查随之错误拒绝。
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "const declared = [\"game.world\"];",
          "export const spread = [...declared];",
          "export const roads = roadsOf(spread);",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    expect(checkModuleCapabilityUsage({ root, definitions: [map, world] })).toEqual([]);
  });

  it("展开运算符与可选链相邻出现时仍只识别真实访问", () => {
    // 同一文件里既有展开数组又有真实可选链访问：前者不报，后者必须报。
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "const declared = [\"game.actions\"];",
          "export const spread = [...declared];",
          "export const world = ports?.[\"game.world\"];",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.filter((violation) => violation.code === "capability-undeclared")).toHaveLength(1);
    expect(violations[0]?.message).toContain("game.world");
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

  it("语法合法与非法能力 ID 分别进入不同对账分支", () => {
    const root = fixture({
      // 同一个索引位写 `game.world` 会被对账，写成 `game.WORLD` 会报能力 ID 语法违规。
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "export const valid = ports[\"game.world\"];",
          "export const invalid = ports[\"game.WORLD\"];",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const state = ownState;\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.filter((violation) => violation.code === "capability-unknown")).toEqual([]);
    const undeclared = violations.filter((violation) => violation.code === "capability-undeclared");
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.message).toContain("game.world");
    const invalid = violations.filter((violation) => violation.code === "capability-invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.message).toContain("game.WORLD");
    expect(invalid[0]?.message).toContain("<group>.<family>");
  });

  it("语法非法但带能力 group 前缀的索引访问与解构键都报告为语法违规", () => {
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "export const leadingDigit = ports[\"game.9world\"];",
          "const { \"game.world.extra\": state } = context.modules;",
          "export const combined = [leadingDigit, state];",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const state = ownState;\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    const messages = violations
      .filter((violation) => violation.code === "capability-invalid")
      .map((violation) => violation.message);
    expect(messages).toHaveLength(2);
    expect(messages.join("\n")).toContain("game.9world");
    expect(messages.join("\n")).toContain("game.world.extra");
  });

  it("普通字符串与无 group 前缀的键不报语法违规", () => {
    const root = fixture({
      ...sourceModule(
        "game.map.six-nodes",
        "port.ts",
        [
          "const label = \"hud.compact\";",
          "const channels = { \"console.timeline\": true };",
          "export const roads = roadsOf(label, channels);",
        ].join("\n"),
      ),
      ...sourceModule("game.world.slg-light", "port.ts", "export const state = ownState;\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations.filter((violation) => violation.code === "capability-invalid")).toEqual([]);
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
