/**
 * 核心职责：校验边界检查器对规则 8（共享契约唯一定义）与规则 9（服务端模块源码表名白名单）的判定。
 * 交互契约：测试把内联源码字符串与包清单交给检查器公开入口，不编译也不执行被检查代码；
 * 只断言目标规则的违规，其他规则对夹具的判定由各自的测试覆盖。
 * 约束与禁忌：禁止在测试里放宽名单、跳过违规或让断言与规则编号脱节。
 */
import { describe, expect, it } from "vitest";
import {
  checkBoundaries,
  type BoundaryPackage,
  type BoundarySourceFile,
  type BoundaryViolation,
} from "@world-prism/scripts/check-boundaries";
import { packageManifest, packagesWith } from "./check-boundaries-support";

const TRANSPORT_DIRECTORY = "modules/server/transport/http-ws/fastify";
const TRANSPORT_PACKAGE = packageManifest("@world-prism/mod-transport-http-ws-fastify", TRANSPORT_DIRECTORY);
const CLIENT_HUD_DIRECTORY = "modules/client/hud/standard";
const CLIENT_HUD_PACKAGE = packageManifest("@world-prism/mod-client-hud-standard", CLIENT_HUD_DIRECTORY);
const OBSERVABILITY_DIRECTORY = "modules/server/platform/observability/sqlite";
const OBSERVABILITY_PACKAGE = packageManifest("@world-prism/mod-platform-observability-sqlite", OBSERVABILITY_DIRECTORY);
const BUDGET_DIRECTORY = "modules/server/platform/budget/standard";
const BUDGET_PACKAGE = packageManifest("@world-prism/mod-platform-budget-standard", BUDGET_DIRECTORY);
const WORLD_DIRECTORY = "modules/server/game/world/slg-light";
const WORLD_PACKAGE = packageManifest("@world-prism/mod-game-world-slg-light", WORLD_DIRECTORY);
const SAVE_DIRECTORY = "modules/server/game/save/sqlite";
const SAVE_PACKAGE = packageManifest("@world-prism/mod-game-save-sqlite", SAVE_DIRECTORY);
const STORAGE_DIRECTORY = "modules/server/platform/storage/sqlite";
const STORAGE_PACKAGE = packageManifest("@world-prism/mod-platform-storage-sqlite", STORAGE_DIRECTORY);

function violationsOfRule(
  rule: number,
  files: readonly BoundarySourceFile[],
  extraPackages: readonly BoundaryPackage[] = [],
): readonly BoundaryViolation[] {
  const violations = checkBoundaries({
    files,
    packages: packagesWith(extraPackages),
    definitionKinds: extraPackages.map((pkg) => ({ packageName: pkg.name, kind: "service" as const })),
  });
  return violations.filter((item) => item.rule === rule);
}

describe("规则 8：共享契约唯一定义", () => {
  it("其他包再声明一份共享契约类型时报违规并指向声明行", () => {
    const violations = violationsOfRule(
      8,
      [
        {
          path: `${TRANSPORT_DIRECTORY}/src/routes/contracts.ts`,
          content: [
            "import type { Json } from \"@world-prism/contracts\";",
            "",
            "export type AccessAction = \"player\" | \"command\";",
            "export interface AccessDecision {",
            "  readonly allowed: boolean;",
            "  readonly reason: string;",
            "}",
          ].join("\n"),
        },
      ],
      [TRANSPORT_PACKAGE],
    );
    expect(violations).toEqual([
      expect.objectContaining({ code: "shared-contract-redeclared", file: `${TRANSPORT_DIRECTORY}/src/routes/contracts.ts`, line: 3 }),
      expect.objectContaining({ code: "shared-contract-redeclared", file: `${TRANSPORT_DIRECTORY}/src/routes/contracts.ts`, line: 4 }),
    ]);
    expect(violations[0]?.message).toContain("AccessAction");
    expect(violations[0]?.message).toContain("@world-prism/module-sdk");
    expect(violations[1]?.message).toContain("AccessDecision");
  });

  it("同名 schema 常量与泛型类型别名同样算作再声明", () => {
    const violations = violationsOfRule(
      8,
      [
        {
          path: "packages/authority/src/budgets.ts",
          content: [
            "export const contextSegmentBudgetsSchema = z.record(z.string(), z.number());",
            "export type StoragePort<T = unknown> = { readonly value: T };",
          ].join("\n"),
        },
      ],
    );
    expect(violations.map((item) => [item.code, item.line])).toEqual([
      ["shared-contract-redeclared", 1],
      ["shared-contract-redeclared", 2],
    ]);
    expect(violations[0]?.message).toContain("@world-prism/contracts");
  });

  it("导入、类型修饰导入、再导出、注释与字符串里的同名文字不算声明", () => {
    const violations = violationsOfRule(
      8,
      [
        {
          path: `${TRANSPORT_DIRECTORY}/src/routes/access.ts`,
          content: [
            "import { type AccessAction, type AccessDecision } from \"@world-prism/module-sdk\";",
            "import type { HostServices } from \"@world-prism/contracts\";",
            "export type { AccessAction, AccessDecision, HostServices };",
            "// interface SavePort 只是注释",
            "const label = \"type GameContent = 文本\";",
            "type LocalAction = AccessAction;",
            "export const describe = (action: LocalAction, host: HostServices): string => label + action + String(host);",
          ].join("\n"),
        },
      ],
      [TRANSPORT_PACKAGE],
    );
    expect(violations).toEqual([]);
  });

  it("所有者包自身的声明、测试文件与验证包不参与再声明判定", () => {
    const violations = violationsOfRule(8, [
      { path: "packages/module-sdk/src/access-policy.ts", content: "export type AccessAction = \"player\";\n" },
      { path: "packages/authority/tests/access.test.ts", content: "interface AccessAction { readonly fake: true }\n" },
      { path: "packages/authority/src/access.spec.ts", content: "type HostServices = { readonly fake: true };\n" },
    ]);
    expect(violations.filter((item) => item.code === "shared-contract-redeclared")).toEqual([]);
  });

  it("浏览器 realm 不能导入服务端专属所有者，但仍不得再声明 contracts 拥有的契约", () => {
    const violations = violationsOfRule(
      8,
      [
        {
          path: `${CLIENT_HUD_DIRECTORY}/src/plugin.tsx`,
          content: [
            "type AccessAction = \"player\";",
            "interface HostServices {",
            "  nowIso(): string;",
            "}",
          ].join("\n"),
        },
      ],
      [CLIENT_HUD_PACKAGE],
    );
    expect(violations).toEqual([
      expect.objectContaining({ code: "shared-contract-redeclared", file: `${CLIENT_HUD_DIRECTORY}/src/plugin.tsx`, line: 2 }),
    ]);
    expect(violations[0]?.message).toContain("HostServices");
  });

  it("所有者包有源码参与扫描却缺少名单中的声明时报名单过期", () => {
    const violations = violationsOfRule(8, [
      {
        path: "packages/module-sdk/src/access-policy.ts",
        content: [
          "export type AccessAction = \"player\";",
          "export type AccessDecisionReason = \"allowed\";",
          "export interface AccessRequest { readonly action: AccessAction }",
          "export interface AccessDecision { readonly reason: AccessDecisionReason }",
          "export interface AccessPolicy { authorize(request: AccessRequest): AccessDecision }",
          "export interface GameContent { readonly packId: string }",
          "export interface SavePort { readonly kind: \"save\" }",
        ].join("\n"),
      },
    ]);
    expect(violations).toEqual([
      expect.objectContaining({ code: "shared-contract-owner-missing", file: "packages/module-sdk/package.json", line: 1 }),
    ]);
    expect(violations[0]?.message).toContain("ObservabilitySources");
  });
});

describe("规则 9：服务端模块源码表名白名单", () => {
  it("SQL 引用其他所有者的表时报违规，FROM 与 JOIN 分别报告", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${OBSERVABILITY_DIRECTORY}/src/research-queries.ts`,
          content: [
            "export const ownSpans = (tx: Tx) => tx.all(\"SELECT trace_id FROM trace_spans\");",
            "export const turns = (tx: Tx) => tx.all(`SELECT t.turn_id",
            "  FROM turn_runs t JOIN controller_leases c ON c.agent_id = t.agent_id`);",
          ].join("\n"),
        },
      ],
      [OBSERVABILITY_PACKAGE],
    );
    expect(violations.map((item) => [item.code, item.line])).toEqual([
      ["module-table-unlisted", 3],
      ["module-table-unlisted", 3],
    ]);
    expect(violations.map((item) => item.message).join("\n")).toContain("turn_runs");
    expect(violations.map((item) => item.message).join("\n")).toContain("controller_leases");
  });

  it("未登记白名单的模块经表级接口访问任何表都报违规", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${WORLD_DIRECTORY}/src/port.ts`,
          content: "export const state = (tx: Tx, branchId: string) => tx.branch(branchId).table(\"aggregate_state\").list();\n",
        },
      ],
      [WORLD_PACKAGE],
    );
    expect(violations).toEqual([
      expect.objectContaining({ code: "module-table-unlisted", file: `${WORLD_DIRECTORY}/src/port.ts`, line: 1 }),
    ]);
    expect(violations[0]?.message).toContain("game.world.slg-light");
    expect(violations[0]?.message).toContain("aggregate_state");
  });

  it("表名来自变量或模板插值时报无法静态核对", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${BUDGET_DIRECTORY}/src/plugin.ts`,
          content: [
            "export const own = (tx: Tx) => tx.rows(\"budget_ledger\");",
            "export const byName = (tx: Tx, table: string) => tx.rows(table);",
            "export const templated = (tx: Tx, table: string) => tx.all(`SELECT * FROM ${table}`);",
            "export const interpolated = (tx: Tx, table: string) => tx.rows(`${table}`);",
          ].join("\n"),
        },
      ],
      [BUDGET_PACKAGE],
    );
    expect(violations.map((item) => [item.code, item.line])).toEqual([
      ["module-table-dynamic", 2],
      ["module-table-dynamic", 3],
      ["module-table-dynamic", 4],
    ]);
  });

  it("小写 SQL 语句与 FROM 后的逗号表列表同样被识别", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${BUDGET_DIRECTORY}/src/plugin.ts`,
          content: [
            "export const own = (tx: Tx) => tx.rows(\"budget_ledger\");",
            "export const joined = (tx: Tx) => tx.get(\"select 1 from budget_ledger b, clock k where b.run_id = k.run_id\");",
          ].join("\n"),
        },
      ],
      [BUDGET_PACKAGE],
    );
    expect(violations).toEqual([
      expect.objectContaining({ code: "module-table-unlisted", line: 2 }),
    ]);
    expect(violations[0]?.message).toContain("clock");
  });

  it("登记过的表、注释、普通文本、表值函数、CTE、列清单与 upsert 都不误报", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${BUDGET_DIRECTORY}/src/plugin.ts`,
          content: [
            "// SELECT * FROM clock 只是注释",
            "/* UPDATE turn_runs SET status = 'x' 同样是注释 */",
            "const message = \"usage copied from snapshot into report\";",
            "export const ledger = (tx: Tx) => tx.rows(\"budget_ledger\").list();",
            "export const tagged = (tx: Tx) => tx.all(\"SELECT key FROM budget_ledger, json_each(budget_ledger.tags_json)\");",
            "export const recent = (tx: Tx) => tx.all(`WITH recent AS (SELECT * FROM budget_ledger) SELECT * FROM recent`);",
            "export const upsert = (tx: Tx) => tx.run(",
            "  \"INSERT INTO budget_ledger(entry_id, run_id) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET run_id = excluded.run_id\",",
            ");",
            "export const label = message;",
          ].join("\n"),
        },
      ],
      [BUDGET_PACKAGE],
    );
    expect(violations).toEqual([]);
  });

  it("白名单登记的表在模块源码中不再出现时报未使用", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${SAVE_DIRECTORY}/src/service.ts`,
          content: "export const snapshot = (tx: Tx, id: string) => tx.rows(\"snapshots\").get({ snapshot_id: id });\n",
        },
      ],
      [SAVE_PACKAGE],
    );
    expect(violations.map((item) => [item.code, item.file])).toEqual([
      ["module-table-unused", `${SAVE_DIRECTORY}/package.json`],
      ["module-table-unused", `${SAVE_DIRECTORY}/package.json`],
      ["module-table-unused", `${SAVE_DIRECTORY}/package.json`],
    ]);
    expect(violations.map((item) => item.message).join("\n")).toContain("world_aliases");
  });

  it("存储适配器、模块测试与固定机制包不参与表名白名单", () => {
    const violations = violationsOfRule(
      9,
      [
        {
          path: `${STORAGE_DIRECTORY}/src/sqlite/fork-branch.ts`,
          content: "export const copy = (tx: Tx, table: string) => tx.run(`INSERT INTO ${table} SELECT * FROM ${table}`);\n",
        },
        {
          path: `${WORLD_DIRECTORY}/tests/port.test.ts`,
          content: "export const peek = (tx: Tx) => tx.all(\"SELECT * FROM domain_events\");\n",
        },
        {
          path: "packages/authority/src/event-queries.ts",
          content: "export const events = (tx: Tx) => tx.all(\"SELECT * FROM domain_events\");\n",
        },
      ],
      [STORAGE_PACKAGE, WORLD_PACKAGE],
    );
    expect(violations).toEqual([]);
  });
});
