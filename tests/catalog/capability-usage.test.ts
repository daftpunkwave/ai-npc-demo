/**
 * 校验模块源码能力访问与 provides/requires 的静态对账，覆盖服务端索引与解构、浏览器 hook 调用及宿主固定端口契约。
 * 依赖临时模块目录、最小模块定义、浏览器描述符工厂与 app-server 公开的对账函数。
 * 禁止依赖真实模块实现或让测试共享临时目录。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk";
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

describe("动态能力键", () => {
  /** world 模块访问自身与 requires 的能力，避免夹具同时触发漏声明与多余声明。 */
  const declaredWorldAccess = "export const roads = ports[\"game.map\"];\nexport const own = ports[\"game.world\"];\n";

  function dynamicKeyViolations(worldSource: string): readonly { readonly file: string; readonly message: string }[] {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const roads = roadsOf();\n"),
      ...sourceModule("game.world.slg-light", "port.ts", declaredWorldAccess),
      ...sourceModule("game.world.slg-light", "dynamic.ts", worldSource),
    });
    return checkModuleCapabilityUsage({ root, definitions: [map, world] }).filter(
      (violation) => violation.code === "capability-dynamic-key",
    );
  }

  it("以变量索引端口容器时报动态能力键并指向所在行", () => {
    const violations = dynamicKeyViolations(
      [
        "const capability = pick();",
        "export const port = input.ports[capability];",
      ].join("\n"),
    );
    expect(violations).toEqual([
      expect.objectContaining({ file: expect.stringContaining("world/slg-light/src/dynamic.ts") }),
    ]);
    expect(violations[0]?.message).toContain("dynamic.ts:2");
    expect(violations[0]?.message).toContain("ports");
  });

  it("可选链、调用返回的端口视图、括号转型、模板字符串与转义字面量键同样被拒绝", () => {
    const violations = dynamicKeyViolations(
      [
        "export const a = ports?.[capability];",
        "export const b = asPorts(context)[capability];",
        "export const c = (context.modules as GameModulePorts)[capability];",
        "export const d = context.modules[`game.world`];",
        "export const e = ports[\"game\\u002eworld\"];",
        "export const f = context.modules[",
        "  capability",
        "];",
      ].join("\n"),
    );
    expect(violations.map((violation) => violation.message.match(/dynamic\.ts:(\d+)/)?.[1])).toEqual([
      "1", "2", "3", "4", "5", "6",
    ]);
  });

  it("以计算键解构端口容器时报动态能力键", () => {
    const violations = dynamicKeyViolations(
      [
        "export function portOf(context: HandlerContext, key: string): unknown {",
        "  const { [key]: port } = context.modules;",
        "  return port;",
        "}",
      ].join("\n"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("dynamic.ts:2");
    expect(violations[0]?.message).toContain("modules");
  });

  it("非端口容器的变量索引、数组类型、计算键解构普通对象与注释字符串不报动态能力键", () => {
    const violations = dynamicKeyViolations(
      [
        "// ports[capability] 只是注释",
        "const label = \"context.modules[key]\";",
        "export const item = items[index];",
        "export const value = record[key] ?? label;",
        "export const list: GameModulePorts[] = [];",
        "const { [key]: setting } = settings;",
        "export const spread = [...ports.list];",
        "export const own = setting;",
      ].join("\n"),
    );
    expect(violations).toEqual([]);
  });
});

describe("浏览器模块的端口取用对账", () => {
  const camera = defineBrowserModuleDefinition({
    id: "client.camera.standard",
    kind: "service",
    provides: "client.camera",
    create: async () => {
      throw new Error("静态对账不应创建模块实例");
    },
  });
  const worldView = defineBrowserModuleDefinition({
    id: "client.world-view.standard",
    kind: "service",
    provides: "client.world-view",
    create: async () => {
      throw new Error("静态对账不应创建模块实例");
    },
  });

  function settings(requires: readonly string[]): ModuleDefinition {
    return defineBrowserModuleDefinition({
      id: "client.settings.standard",
      kind: "contributor",
      provides: "client.settings",
      requires,
      create: async () => {
        throw new Error("静态对账不应创建模块实例");
      },
    });
  }

  function healthPage(): ModuleDefinition {
    return defineBrowserModuleDefinition({
      id: "console.health.standard",
      kind: "contributor",
      provides: "console.health",
      create: async () => {
        throw new Error("静态对账不应创建模块实例");
      },
    });
  }

  /** 按浏览器 realm 目录约定写入模块源码，视图文件用 .tsx。 */
  function browserModule(id: string, fileName: string, content: string): Record<string, string> {
    const [realm, family, implementation] = id.split(".");
    const directory = `modules/${String(realm)}/${String(family)}/${String(implementation)}/src`;
    return {
      [`${directory}/definition.ts`]: "export {};\n",
      [`${directory}/${fileName}`]: content,
    };
  }

  /** camera 与 world-view 不取用任何端口，只作为被依赖的提供者。 */
  const providers = {
    ...browserModule("client.camera.standard", "plugin.ts", "export const camera = createCamera();\n"),
    ...browserModule("client.world-view.standard", "plugin.ts", "export const api = input.ports[\"host.api\"];\n"),
  };

  it("视图经 usePort 取用未声明的能力时报漏声明并指向所在行", () => {
    const root = fixture({
      ...providers,
      ...browserModule(
        "client.settings.standard",
        "plugin.tsx",
        [
          "import { usePort, usePortSubscription } from \"@world-prism/client-sdk\";",
          "const view = usePortSubscription<ProjectionState | null>(\"client.world-view\");",
          "const camera = usePort<CameraLike>(\"client.camera\");",
        ].join("\n"),
      ),
    });
    const violations = checkModuleCapabilityUsage({
      root,
      definitions: [camera, worldView, settings(["client.world-view"])],
    });
    expect(violations).toEqual([
      expect.objectContaining({ code: "capability-undeclared", file: "modules/client/settings/standard/src/plugin.tsx" }),
    ]);
    expect(violations[0]?.message).toContain("plugin.tsx:3");
    expect(violations[0]?.message).toContain("client.camera");
  });

  it("带类型实参、跨行与箭头类型的 hook 调用都能识别，声明一致时没有违规", () => {
    const root = fixture({
      ...providers,
      ...browserModule(
        "client.settings.standard",
        "plugin.tsx",
        [
          "const state = usePortSubscription<{ x: number; y: number; zoom: number }>(\"client.camera\");",
          "const view = usePort<{",
          "  subscribe(listener: (value: number) => void): () => void;",
          "}>(",
          "  \"client.world-view\",",
          ");",
          "const api = usePort<ApiClient>(\"host.api\");",
        ].join("\n"),
      ),
    });
    expect(
      checkModuleCapabilityUsage({ root, definitions: [camera, worldView, settings(["client.camera", "client.world-view"])] }),
    ).toEqual([]);
  });

  it("浏览器模块声明了却从未取用的 requires 报多余声明", () => {
    const root = fixture({
      ...providers,
      ...browserModule("client.settings.standard", "plugin.tsx", "const camera = usePort(\"client.camera\");\n"),
    });
    const violations = checkModuleCapabilityUsage({
      root,
      definitions: [camera, worldView, settings(["client.camera", "client.world-view"])],
    });
    expect(violations).toEqual([
      expect.objectContaining({ code: "capability-unused", file: "modules/client/settings/standard" }),
    ]);
    expect(violations[0]?.message).toContain("client.world-view");
  });

  it("取用本 realm 固定端口契约之外的宿主端口时报越界，本 realm 固定端口无需声明", () => {
    const root = fixture({
      ...browserModule(
        "console.health.standard",
        "plugin.tsx",
        [
          "const host = usePort<ConsoleHostPort>(\"host.console\");",
          "const api = usePort<ApiClient>(\"host.api\");",
        ].join("\n"),
      ),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [healthPage()] });
    expect(violations).toEqual([
      expect.objectContaining({ code: "host-port-undeclared", file: "modules/console/health/standard/src/plugin.tsx" }),
    ]);
    expect(violations[0]?.message).toContain("plugin.tsx:2");
    expect(violations[0]?.message).toContain("host.api");
    expect(violations[0]?.message).toContain("host.console");
  });

  it("服务端模块没有宿主固定端口，索引取用 host 端口同样报越界", () => {
    const root = fixture({
      ...sourceModule("game.map.six-nodes", "port.ts", "export const api = ports[\"host.api\"];\n"),
      ...sourceModule("game.world.slg-light", "port.ts", "export const roads = ports[\"game.map\"];\n"),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [map, world] });
    expect(violations).toEqual([expect.objectContaining({ code: "host-port-undeclared" })]);
    expect(violations[0]?.message).toContain("本 realm 的固定端口：无");
  });

  it("hook 以变量取端口报动态能力键，以不合语法的字符串取端口报语法违规", () => {
    const root = fixture({
      ...providers,
      ...browserModule(
        "client.settings.standard",
        "plugin.tsx",
        [
          "const camera = usePort(\"client.camera\");",
          "const port = usePort<unknown>(capability);",
          "const typo = usePort(\"camera\");",
        ].join("\n"),
      ),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [camera, worldView, settings(["client.camera"])] });
    expect(violations.map((violation) => violation.code)).toEqual(["capability-dynamic-key", "capability-invalid"]);
    expect(violations[0]?.message).toContain("plugin.tsx:2");
    expect(violations[0]?.message).toContain("usePort");
    expect(violations[1]?.message).toContain("plugin.tsx:3");
    expect(violations[1]?.message).toContain("camera");
  });

  it("hook 实参以字符串开头但拼接或运算的表达式报动态能力键，不当作静态访问", () => {
    const root = fixture({
      ...providers,
      ...browserModule(
        "client.settings.standard",
        "plugin.tsx",
        [
          "const camera = usePort(\"client.camera\");",
          "const joined = usePort(\"client.camera\" + suffix);",
          "const chosen = usePort<unknown>(\"client.camera\" || fallback);",
          "const listener = usePortSubscription(\"client.camera\", onChange);",
        ].join("\n"),
      ),
    });
    const violations = checkModuleCapabilityUsage({ root, definitions: [camera, worldView, settings(["client.camera"])] });
    expect(violations.map((violation) => violation.code)).toEqual(["capability-dynamic-key", "capability-dynamic-key"]);
    expect(violations[0]?.message).toContain("plugin.tsx:2");
    expect(violations[1]?.message).toContain("plugin.tsx:3");
  });
});
