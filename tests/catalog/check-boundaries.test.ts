/**
 * 校验边界检查器对规则 1（包公开入口与依赖声明）与规则 2（模块 realm/kind 白名单）的判定。
 * 夹具以纯文本存放，测试把字符串传给检查器公开入口，不编译也不执行被检查代码。
 * 禁止在测试里放宽规则、跳过夹具或让断言与规则编号脱节。
 */
import { describe, expect, it } from "vitest";
import {
  checkBoundaries,
  formatViolation,
  type BoundarySourceFile,
  type BoundaryViolation,
} from "@ai-npc/scripts/check-boundaries";
import {
  MEMORY_MODULE_DIRECTORY,
  MEMORY_MODULE_KIND,
  MEMORY_MODULE_NAME,
  SERVER_SERVICE_DIRECTORY,
  SERVER_SERVICE_KIND,
  SERVER_SERVICE_PACKAGE,
  checkFixture,
  expectCode,
  expectRule,
  memoryModule,
  packageManifest,
  packagesWith,
  readFixture,
} from "./check-boundaries-support";

describe("规则 1：包公开入口与 workspace 依赖声明", () => {
  it("拒绝 workspace 包源码深层导入", () => {
    const violations = checkFixture("packages/authority/src/envelope.ts", "deep-import.ts.txt", {
      packages: packagesWith([
        packageManifest("@ai-npc/authority", "packages/authority", {
          dependencies: { "@ai-npc/contracts": "workspace:*" },
        }),
      ]),
    });
    expect(violations).toHaveLength(1);
    expectCode(violations, "deep-import");
    expectRule(violations, 1);
    expect(formatViolation(violations[0] as BoundaryViolation)).toMatch(
      /^packages\/authority\/src\/envelope\.ts:\d+: \[规则 1 \//,
    );
  });

  it("允许 exports 声明的模块定义子路径入口", () => {
    const appPackage = packageManifest("@ai-npc/app-server", "apps/server", {
      dependencies: { [MEMORY_MODULE_NAME]: "workspace:*" },
    });
    const violations = checkFixture("apps/server/src/host/module-catalog.ts", "deep-import-allowed-exports.ts.txt", {
      packages: packagesWith([appPackage, memoryModule()]),
      definitionKinds: [MEMORY_MODULE_KIND],
    });
    expect(violations).toEqual([]);
  });

  it("拒绝未在 dependencies 声明的 workspace 包引用", () => {
    const violations = checkFixture("packages/authority/src/gateway.ts", "undeclared-workspace-dependency.ts.txt");
    expectCode(violations, "workspace-dependency-not-declared");
    expectRule(violations, 1);
  });

  it("拒绝只写在 devDependencies 的生产依赖", () => {
    const violations = checkFixture("packages/authority/src/gateway.ts", "workspace-dependency-dev-only.ts.txt", {
      packages: packagesWith([
        packageManifest("@ai-npc/authority", "packages/authority", {
          devDependencies: { "@ai-npc/kernel": "workspace:*" },
        }),
      ]),
    });
    expectCode(violations, "workspace-dependency-dev-only");
    expectRule(violations, 1);
  });

  it("re-export 同样受深层导入限制", () => {
    const violations = checkFixture("packages/authority/src/index.ts", "re-export-deep-import.ts.txt", {
      packages: packagesWith([
        packageManifest("@ai-npc/authority", "packages/authority", {
          dependencies: { "@ai-npc/contracts": "workspace:*" },
        }),
      ]),
    });
    expectCode(violations, "deep-import");
    expectRule(violations, 1);
  });

  it("拒绝跨包相对路径引用", () => {
    const violations = checkFixture("packages/authority/src/command.ts", "cross-package-relative.ts.txt");
    expectCode(violations, "cross-package-relative-import");
    expectRule(violations, 1);
  });

  it("验证用包可以引用模块公开入口", () => {
    const violations = checkFixture("tests/catalog/sample.test.ts", "deep-import-allowed-exports.ts.txt", {
      packages: packagesWith([
        packageManifest("@ai-npc/tests", "tests", {
          dependencies: { [MEMORY_MODULE_NAME]: "workspace:*" },
        }),
        memoryModule(),
      ]),
      definitionKinds: [MEMORY_MODULE_KIND],
    });
    expect(violations).toEqual([]);
  });

  it("验证包的生产性脚本代码同样要求声明 workspace 依赖", () => {
    // scripts/ 承载质量门禁自身的基础设施：它引用 workspace 包却漏声明时，门禁会在
    // 更换链接策略或裁剪根依赖后以「模块找不到」崩溃，而崩溃点与门禁职责无关。
    const files: readonly BoundarySourceFile[] = [
      {
        path: "scripts/check-docs.ts",
        content: "/**\n * 核心职责：夹具。\n * 交互契约：仅测试使用。\n * 约束与禁忌：无。\n */\nimport { readRepository } from \"@ai-npc/kernel\";\nexport const run = (): unknown => readRepository;\n",
      },
    ];
    const violations = checkBoundaries({
      files,
      packages: packagesWith([packageManifest("@ai-npc/scripts", "scripts", {})]),
    });
    expectCode(violations, "workspace-dependency-not-declared");
    expectRule(violations, 1);
  });

  it("验证包的生产性脚本代码同样要求声明第三方依赖", () => {
    const files: readonly BoundarySourceFile[] = [
      {
        path: "scripts/check-assets.ts",
        content: "/**\n * 核心职责：夹具。\n * 交互契约：仅测试使用。\n * 约束与禁忌：无。\n */\nimport { XMLParser } from \"fast-xml-parser-not-declared\";\nexport const parser = XMLParser;\n",
      },
    ];
    const violations = checkBoundaries({
      files,
      packages: packagesWith([packageManifest("@ai-npc/scripts", "scripts", {})]),
    });
    expectCode(violations, "undeclared-third-party-dependency");
    expectRule(violations, 6);
  });

  it("验证包允许把验证用途的依赖写在 devDependencies", () => {
    const files: readonly BoundarySourceFile[] = [
      {
        path: "scripts/check-catalog.ts",
        content: "/**\n * 核心职责：夹具。\n * 交互契约：仅测试使用。\n * 约束与禁忌：无。\n */\nimport { readRepository } from \"@ai-npc/kernel\";\nimport { parse } from \"yaml\";\nexport const run = (): unknown => [readRepository, parse];\n",
      },
    ];
    const violations = checkBoundaries({
      files,
      packages: packagesWith([
        packageManifest("@ai-npc/scripts", "scripts", {
          devDependencies: { "@ai-npc/kernel": "workspace:*", yaml: "^2.9.1" },
        }),
      ]),
    });
    expect(violations).toEqual([]);
  });

  it("生产模块写在 devDependencies 依旧拒绝", () => {
    const files: readonly BoundarySourceFile[] = [
      {
        path: "packages/authority/src/gateway.ts",
        content: "/**\n * 核心职责：夹具。\n * 交互契约：仅测试使用。\n * 约束与禁忌：无。\n */\nimport { Kernel } from \"@ai-npc/kernel\";\nexport const kernel = Kernel;\n",
      },
    ];
    const violations = checkBoundaries({
      files,
      packages: packagesWith([
        packageManifest("@ai-npc/authority", "packages/authority", {
          devDependencies: { "@ai-npc/kernel": "workspace:*" },
        }),
      ]),
    });
    expectCode(violations, "workspace-dependency-dev-only");
    expectRule(violations, 1);
  });

  it("字符串字面量中的 import 文本不视为依赖", () => {
    const violations = checkFixture("packages/authority/src/help.ts", "string-literal-import.ts.txt");
    expect(violations).toEqual([]);
  });
});

describe("规则 2：模块 realm/kind 依赖白名单", () => {
  it("server service 只允许契约、模块辅助与校验库", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY, {
      dependencies: {
        "@ai-npc/contracts": "workspace:*",
        "@ai-npc/module-sdk": "workspace:*",
        zod: "^4",
      },
    });
    const violations = checkFixture(`${SERVER_SERVICE_DIRECTORY}/src/index.ts`, "module-server-service-valid.ts.txt", {
      packages: packagesWith([modulePackage]),
      definitionKinds: [SERVER_SERVICE_KIND],
    });
    expect(violations).toEqual([]);
  });

  it("server service 不能引用 HTTP 传输框架", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY);
    const violations = checkFixture(`${SERVER_SERVICE_DIRECTORY}/src/index.ts`, "module-server-service-forbidden.ts.txt", {
      packages: packagesWith([modulePackage]),
      definitionKinds: [SERVER_SERVICE_KIND],
    });
    expectCode(violations, "module-forbidden-external-import");
    expectRule(violations, 2);
  });

  it("HTTP 传输 adapter 可以使用 Fastify 及其插件", () => {
    const directory = "modules/server/transport/http-ws/fastify";
    const modulePackage = packageManifest("@ai-npc/mod-transport-http-ws-fastify", directory, {
      dependencies: { fastify: "^5", "@fastify/static": "^10" },
    });
    const violations = checkFixture(`${directory}/src/index.ts`, "module-server-adapter-fastify-valid.ts.txt", {
      packages: packagesWith([modulePackage]),
      definitionKinds: [{ packageName: "@ai-npc/mod-transport-http-ws-fastify", kind: "adapter" }],
    });
    expect(violations).toEqual([]);
  });

  it("SQLite 存储 adapter 可以使用内置 sqlite", () => {
    const directory = "modules/server/platform/storage/sqlite";
    const modulePackage = packageManifest("@ai-npc/mod-platform-storage-sqlite", directory);
    const violations = checkFixture(`${directory}/src/index.ts`, "module-server-adapter-sqlite-valid.ts.txt", {
      packages: packagesWith([modulePackage]),
      definitionKinds: [{ packageName: "@ai-npc/mod-platform-storage-sqlite", kind: "adapter" }],
    });
    expect(violations).toEqual([]);
  });

  it("SQLite 存储 adapter 可以使用文件系统读取迁移与库文件", () => {
    const directory = "modules/server/platform/storage/sqlite";
    const modulePackage = packageManifest("@ai-npc/mod-platform-storage-sqlite", directory);
    const violations = checkFixture(
      `${directory}/src/index.ts`,
      "module-server-adapter-sqlite-filesystem-valid.ts.txt",
      {
        packages: packagesWith([modulePackage]),
        definitionKinds: [{ packageName: "@ai-npc/mod-platform-storage-sqlite", kind: "adapter" }],
      },
    );
    expect(violations).toEqual([]);
  });

  it("模块测试文件可以使用测试工具、Node 内置模块与宿主机制包", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY);
    const violations = checkFixture(
      `${SERVER_SERVICE_DIRECTORY}/tests/behavior.test.ts`,
      "module-server-test-vitest-valid.ts.txt",
      {
        packages: packagesWith([modulePackage]),
        definitionKinds: [SERVER_SERVICE_KIND],
      },
    );
    expect(violations).toEqual([]);
  });

  it("模块测试也不能引用其他模块实现", () => {
    const violations = checkFixture(
      `${SERVER_SERVICE_DIRECTORY}/tests/behavior.test.ts`,
      "module-cross-dependency.ts.txt",
      {
        packages: packagesWith([packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY), memoryModule()]),
        definitionKinds: [SERVER_SERVICE_KIND, MEMORY_MODULE_KIND],
      },
    );
    expectCode(violations, "module-forbidden-workspace-import");
    expectRule(violations, 2);
  });

  it("adapter 白名单按所属适配器收窄", () => {
    const directory = "modules/server/platform/storage/sqlite";
    const modulePackage = packageManifest("@ai-npc/mod-platform-storage-sqlite", directory);
    const violations = checkFixture(`${directory}/src/index.ts`, "module-server-adapter-misplaced.ts.txt", {
      packages: packagesWith([modulePackage]),
      definitionKinds: [{ packageName: "@ai-npc/mod-platform-storage-sqlite", kind: "adapter" }],
    });
    expectCode(violations, "module-forbidden-external-import");
    expectRule(violations, 2);
  });

  it("模块包之间不能互相依赖", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY, {
      dependencies: { [MEMORY_MODULE_NAME]: "workspace:*" },
    });
    const violations = checkFixture(`${SERVER_SERVICE_DIRECTORY}/src/index.ts`, "module-cross-dependency.ts.txt", {
      packages: packagesWith([modulePackage, memoryModule()]),
      definitionKinds: [SERVER_SERVICE_KIND, MEMORY_MODULE_KIND],
    });
    expectCode(violations, "module-forbidden-workspace-import");
    expectCode(violations, "module-cross-package-dependency");
    expectRule(violations, 2);
  });

  it("pixi.js 只允许场景渲染适配器", () => {
    const hudDirectory = "modules/client/hud/standard";
    const hudViolations = checkFixture(`${hudDirectory}/src/index.ts`, "module-client-pixi.ts.txt", {
      packages: packagesWith([packageManifest("@ai-npc/mod-client-hud-standard", hudDirectory)]),
      definitionKinds: [{ packageName: "@ai-npc/mod-client-hud-standard", kind: "adapter" }],
    });
    expectCode(hudViolations, "module-forbidden-external-import");

    const rendererDirectory = "modules/client/scene-renderer/pixi";
    const rendererViolations = checkFixture(`${rendererDirectory}/src/index.ts`, "module-client-pixi.ts.txt", {
      packages: packagesWith([
        packageManifest("@ai-npc/mod-client-scene-renderer-pixi", rendererDirectory, {
          dependencies: { "pixi.js": "^8" },
        }),
      ]),
      definitionKinds: [{ packageName: "@ai-npc/mod-client-scene-renderer-pixi", kind: "adapter" }],
    });
    expect(rendererViolations).toEqual([]);
  });

  it("kind 从 definition 源文本读取", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY, {
      dependencies: {
        "@ai-npc/contracts": "workspace:*",
        "@ai-npc/module-sdk": "workspace:*",
        zod: "^4",
      },
    });
    const files: readonly BoundarySourceFile[] = [
      {
        path: `${SERVER_SERVICE_DIRECTORY}/src/index.ts`,
        content: readFixture("module-server-service-valid.ts.txt"),
      },
      {
        path: `${SERVER_SERVICE_DIRECTORY}/src/definition.ts`,
        content: readFixture("module-definition.ts.txt"),
      },
    ];
    const violations = checkBoundaries({ files, packages: packagesWith([modulePackage]) });
    expect(violations).toEqual([]);
  });

  it("无法判定 kind 时明确报错", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY, {
      dependencies: { "@ai-npc/contracts": "workspace:*" },
    });
    const violations = checkFixture(`${SERVER_SERVICE_DIRECTORY}/src/index.ts`, "module-definition-unreadable.ts.txt", {
      packages: packagesWith([modulePackage]),
    });
    expectCode(violations, "module-kind-unreadable");
    expectRule(violations, 2);
  });
});

describe("规则 2 子规则：definition 文件只含描述符数据", () => {
  it("definition 文件不得静态 import 同包实现", () => {
    const modulePackage = packageManifest(SERVER_SERVICE_PACKAGE, SERVER_SERVICE_DIRECTORY);
    const violations = checkFixture(`${SERVER_SERVICE_DIRECTORY}/src/definition.ts`, "definition-static-plugin-import.ts.txt", {
      packages: packagesWith([modulePackage]),
    });
    expectCode(violations, "definition-static-implementation-import");
    expectRule(violations, 2);
  });

  it("definition 文件不得静态 import 渲染库", () => {
    const directory = "modules/client/scene-renderer/pixi";
    const modulePackage = packageManifest("@ai-npc/mod-client-scene-renderer-pixi", directory, {
      dependencies: { "pixi.js": "^8" },
    });
    const violations = checkFixture(`${directory}/src/definition.ts`, "definition-static-renderer-import.ts.txt", {
      packages: packagesWith([modulePackage]),
    });
    expectCode(violations, "definition-static-forbidden-import");
    expectRule(violations, 2);
  });

  it("definition 文件允许类型导入与动态加载实现", () => {
    const modulePackage = packageManifest("@ai-npc/mod-agent-memory-ledger", MEMORY_MODULE_DIRECTORY, {
      dependencies: { "@ai-npc/contracts": "workspace:*", zod: "^4" },
    });
    const violations = checkFixture(`${MEMORY_MODULE_DIRECTORY}/src/definition.ts`, "definition-dynamic-plugin-import.ts.txt", {
      packages: packagesWith([modulePackage]),
    });
    expect(violations).toEqual([]);
  });
});
