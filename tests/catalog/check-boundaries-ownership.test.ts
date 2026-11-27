/**
 * 核心职责：校验边界检查器对规则 8（共享契约唯一定义）的判定。
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
