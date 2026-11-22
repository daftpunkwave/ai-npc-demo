/**
 * 校验边界检查器对规则 6（依赖图与动态加载）与规则 7（手写源码文件头）的判定。
 * 夹具以纯文本存放，测试把字符串传给检查器公开入口，不编译也不执行被检查代码。
 * 禁止在测试里放宽规则、跳过夹具或让断言与规则编号脱节。
 */
import { describe, expect, it } from "vitest";
import {
  checkBoundaries,
  checkSourceFile,
  formatViolation,
  type BoundarySourceFile,
} from "@ai-npc/scripts/check-boundaries";
import {
  checkFixture,
  checkHeader,
  expectCode,
  expectRule,
  packageManifest,
  packagesWith,
  readFixture,
} from "./check-boundaries-support";
import { scanRepository } from "@ai-npc/scripts/check-boundaries";

describe("规则 6：依赖图与动态加载", () => {
  it("字面量动态导入按普通 import 检查", () => {
    const violations = checkFixture("packages/authority/src/loader.ts", "dynamic-import-literal.ts.txt");
    expect(violations).toEqual([]);
  });

  it("拒绝非字面量动态导入", () => {
    const violations = checkFixture("packages/authority/src/loader.ts", "dynamic-import-variable.ts.txt");
    expectCode(violations, "dynamic-import-non-literal");
    expectRule(violations, 6);
  });

  it("拒绝未声明第三方库", () => {
    const violations = checkFixture("packages/authority/src/loader.ts", "undeclared-third-party.ts.txt");
    expectCode(violations, "undeclared-third-party-dependency");
    expectRule(violations, 6);
  });

  it("拒绝把生产依赖写进 devDependencies", () => {
    const authorityPackage = packageManifest("@ai-npc/authority", "packages/authority", {
      devDependencies: { yaml: "^2" },
    });
    const violations = checkFixture("packages/authority/src/loader.ts", "undeclared-third-party.ts.txt", {
      packages: packagesWith([authorityPackage]),
    });
    expectCode(violations, "dependency-declared-in-dev-dependencies");
    expectRule(violations, 6);
  });

  it("拒绝未使用的 workspace 依赖声明", () => {
    const authorityPackage = packageManifest("@ai-npc/authority", "packages/authority", {
      dependencies: { "@ai-npc/contracts": "workspace:*" },
    });
    const violations = checkFixture("packages/authority/src/index.ts", "no-imports.ts.txt", {
      packages: packagesWith([authorityPackage]),
    });
    expectCode(violations, "unused-workspace-dependency");
    expectRule(violations, 6);
  });

  it("拒绝未使用的第三方依赖声明", () => {
    const authorityPackage = packageManifest("@ai-npc/authority", "packages/authority", {
      dependencies: { yaml: "^2" },
    });
    const violations = checkFixture("packages/authority/src/index.ts", "no-imports.ts.txt", {
      packages: packagesWith([authorityPackage]),
    });
    expectCode(violations, "unused-third-party-dependency");
    expectRule(violations, 6);
  });

  it("拒绝根清单声明生产依赖", () => {
    const rootPackage = packageManifest("ai-npc-demo", "", {
      dependencies: { fastify: "^5" },
    });
    const violations = checkBoundaries({ files: [], packages: [rootPackage] });
    expectCode(violations, "unused-third-party-dependency");
    expectRule(violations, 6);
    expect(violations[0]?.message).toContain("fastify");
  });

  it("验证包生产源码导入第三方仍须自身声明", () => {
    const scriptsPackage = packageManifest("@ai-npc/scripts", "scripts", {
      exports: { "./check-boundaries": "./check-boundaries.ts" },
    });
    const violations = checkFixture("scripts/check-sample.ts", "undeclared-third-party.ts.txt", {
      packages: [scriptsPackage],
    });
    expectCode(violations, "undeclared-third-party-dependency");
    expectRule(violations, 6);
  });

  it("工具配置文件导入 devDependencies 构建工具不报违规", () => {
    const appClientPackage = packageManifest("@ai-npc/app-client", "apps/client", {
      devDependencies: { vite: "^8" },
    });
    const violations = checkFixture("apps/client/vite.config.ts", "tool-config-import.ts.txt", {
      packages: [appClientPackage],
    });
    expect(violations).toEqual([]);
  });

  it("工具配置文件导入未声明的库仍报违规", () => {
    const appClientPackage = packageManifest("@ai-npc/app-client", "apps/client", {});
    const violations = checkFixture("apps/client/vite.config.ts", "tool-config-import.ts.txt", {
      packages: [appClientPackage],
    });
    expectCode(violations, "undeclared-third-party-dependency");
    expectRule(violations, 6);
  });

  it("拒绝生产 JSX 文件未声明 react", () => {
    const modulePackage = packageManifest("@ai-npc/fake-client", "modules/client/fake/standard", {
      dependencies: { "@ai-npc/client-sdk": "workspace:*" },
    });
    const violations = checkFixture("modules/client/fake/standard/src/plugin.tsx", "jsx-plugin.ts.txt", {
      packages: [modulePackage],
      definitionKinds: [{ packageName: "@ai-npc/fake-client", kind: "service" }],
    });
    expectCode(violations, "undeclared-third-party-dependency");
    expectRule(violations, 6);
    expect(violations.some((item) => item.message.includes("JSX"))).toBe(true);
  });

  it("仓库扫描把根包纳入依赖图检查范围", () => {
    const scanned = scanRepository(process.cwd());
    const rootPackage = scanned.packages.find((pkg) => pkg.directory === "");
    expect(rootPackage).toBeDefined();
    expect(rootPackage?.name).toBe("ai-npc-demo");
    // 真实根清单不声明生产依赖；一旦引入，依赖图规则会立即报未使用。
    expect(Object.keys(rootPackage?.dependencies ?? {})).toEqual([]);
  });

  it("拒绝包依赖环", () => {
    const cyclePackages = [
      packageManifest("@ai-npc/cycle-a", "packages/cycle-a", {
        dependencies: { "@ai-npc/cycle-b": "workspace:*" },
      }),
      packageManifest("@ai-npc/cycle-b", "packages/cycle-b", {
        dependencies: { "@ai-npc/cycle-a": "workspace:*" },
      }),
    ];
    const files: readonly BoundarySourceFile[] = [
      { path: "packages/cycle-a/src/index.ts", content: readFixture("cycle-a.ts.txt") },
      { path: "packages/cycle-b/src/index.ts", content: readFixture("cycle-b.ts.txt") },
    ];
    const violations = checkBoundaries({ files, packages: packagesWith(cyclePackages) });
    expectCode(violations, "cyclic-package-dependency");
    expectRule(violations, 6);
    const cycleViolation = violations.find((item) => item.code === "cyclic-package-dependency");
    expect(cycleViolation?.message).toContain("@ai-npc/cycle-a");
    expect(cycleViolation?.message).toContain("@ai-npc/cycle-b");
  });
});

describe("规则 7：手写源码文件头", () => {
  it("TS 文件缺少文件头", () => {
    const violations = checkHeader("scripts/sample.ts", "header-missing.ts.txt");
    expectCode(violations, "header-missing");
    expectRule(violations, 7);
  });

  it("TS 文件头必须是 JSDoc 块注释", () => {
    const violations = checkHeader("scripts/sample.ts", "header-invalid-format.ts.txt");
    expectCode(violations, "header-invalid-format");
    expectRule(violations, 7);
  });

  it("文件头需要中文说明", () => {
    const violations = checkHeader("scripts/sample.ts", "header-no-chinese.ts.txt");
    expectCode(violations, "header-missing-chinese");
    expectRule(violations, 7);
  });

  it("文件头不得引用开发文档路径", () => {
    const violations = checkHeader("scripts/sample.ts", "header-doc-reference.ts.txt");
    expectCode(violations, "header-doc-path-reference");
    expectRule(violations, 7);
  });

  it("文件头不得引用 Markdown 文档", () => {
    const violations = checkHeader("scripts/sample.ts", "header-markdown-reference.ts.txt");
    expectCode(violations, "header-markdown-link-reference");
    expectCode(violations, "header-markdown-file-reference");
    expectRule(violations, 7);
  });

  it("文件头不得引用构建阶段编号", () => {
    const violations = checkHeader("scripts/sample.ts", "header-stage-reference.ts.txt");
    expectCode(violations, "header-stage-reference");
    expectRule(violations, 7);
  });

  it("文件头不得引用 URL", () => {
    const violations = checkHeader("scripts/sample.ts", "header-url-reference.ts.txt");
    expectCode(violations, "header-url-reference");
    expectRule(violations, 7);
  });

  it("shebang 之后的文件头合法", () => {
    const violations = checkHeader("scripts/sample.ts", "header-shebang.ts.txt");
    expect(violations).toEqual([]);
  });

  it("SQL 文件使用行注释作为文件头", () => {
    const violations = checkHeader("modules/server/platform/storage/sqlite/migrations/0001_init.sql", "header-sql-valid.sql.txt");
    expect(violations).toEqual([]);
  });

  it("SQL 文件缺少行注释文件头", () => {
    const violations = checkHeader("modules/server/platform/storage/sqlite/migrations/0001_init.sql", "header-sql-invalid.sql.txt");
    expectCode(violations, "header-missing");
    expectRule(violations, 7);
  });

  it("CSS、HTML 与 shell 文件头缺失时报告", () => {
    expectCode(checkHeader("apps/client/src/theme.css", "header-css-missing.css.txt"), "header-missing");
    expectCode(checkHeader("apps/client/index.html", "header-html-missing.html.txt"), "header-missing");
    expectCode(checkHeader("scripts/tool.sh", "header-shell-missing.sh.txt"), "header-missing");
  });

  it("JSON 与纯数据配置不需要文件头", () => {
    expect(checkSourceFile({ path: "config/pricing.json", content: "{}" })).toEqual([]);
    expect(checkSourceFile({ path: "config/assemblies/local-slg-standard-v1.yaml", content: "schemaVersion: 1" })).toEqual([]);
  });

  it("生成目录中的文件不参与检查", () => {
    expect(checkSourceFile({ path: "apps/server/console-static/index.html", content: "<div></div>" })).toEqual([]);
  });

  it("违规输出包含文件行号与规则编号", () => {
    const violations = checkSourceFile({
      path: "scripts/sample.ts",
      content: readFixture("header-missing.ts.txt"),
    });
    const first = violations[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const formatted = formatViolation(first);
    expect(formatted).toContain("scripts/sample.ts:1");
    expect(formatted).toContain("规则 7");
    expect(formatted).toContain("header-missing");
  });
});
