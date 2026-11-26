/**
 * 校验边界检查器对规则 3（浏览器 realm 边界）、规则 4（kernel/contracts 依赖限制）与规则 5（宿主组合根）的判定。
 * 夹具以纯文本存放，测试把字符串传给检查器公开入口，不编译也不执行被检查代码。
 * 禁止在测试里放宽规则、跳过夹具或让断言与规则编号脱节。
 */
import { describe, expect, it } from "vitest";
import {
  MEMORY_MODULE_KIND,
  MEMORY_MODULE_NAME,
  checkFixture,
  expectCode,
  expectRule,
  memoryModule,
  packageManifest,
  packagesWith,
} from "./check-boundaries-support";

describe("规则 3：浏览器 realm 边界", () => {
  it("浏览器宿主不能引用 Node 内置模块", () => {
    const appPackage = packageManifest("@world-prism/app-client", "apps/client");
    const violations = checkFixture("apps/client/src/main.tsx", "browser-node-import.ts.txt", {
      packages: packagesWith([appPackage]),
    });
    expectCode(violations, "browser-forbidden-node-import");
    expectRule(violations, 3);
  });

  it("浏览器包不能引用服务端固定机制包", () => {
    const clientSdkPackage = packageManifest("@world-prism/client-sdk", "packages/client-sdk", {
      dependencies: { "@world-prism/authority": "workspace:*" },
    });
    const violations = checkFixture("packages/client-sdk/src/transport.ts", "browser-server-package-import.ts.txt", {
      packages: packagesWith([clientSdkPackage]),
    });
    expectCode(violations, "browser-forbidden-server-package");
    expectRule(violations, 3);
  });

  it("浏览器模块允许 React 与客户端辅助库", () => {
    const directory = "modules/client/hud/standard";
    const modulePackage = packageManifest("@world-prism/mod-client-hud-standard", directory, {
      dependencies: {
        "@world-prism/client-sdk": "workspace:*",
        react: "^19",
        zod: "^4",
      },
    });
    const violations = checkFixture(`${directory}/src/index.ts`, "module-client-service-valid.ts.txt", {
      packages: packagesWith([modulePackage]),
      definitionKinds: [{ packageName: "@world-prism/mod-client-hud-standard", kind: "service" }],
    });
    expect(violations).toEqual([]);
  });
});

describe("规则 4：kernel 与 contracts 的依赖限制", () => {
  it("kernel 不能引用 React", () => {
    const violations = checkFixture("packages/kernel/src/slots.ts", "kernel-react-import.ts.txt");
    expectCode(violations, "host-mechanism-forbidden-import");
    expectRule(violations, 4);
  });

  it("contracts 不能引用模块实现", () => {
    const violations = checkFixture("packages/contracts/src/modules.ts", "contracts-module-import.ts.txt", {
      packages: packagesWith([memoryModule()]),
      definitionKinds: [MEMORY_MODULE_KIND],
    });
    expectCode(violations, "host-mechanism-forbidden-import");
    expectRule(violations, 4);
  });
});

describe("规则 5：宿主应用组合根", () => {
  it("组合根之外不能引用模块包", () => {
    const appPackage = packageManifest("@world-prism/app-server", "apps/server", {
      dependencies: { [MEMORY_MODULE_NAME]: "workspace:*" },
    });
    const violations = checkFixture("apps/server/src/main.ts", "app-module-import-outside-catalog.ts.txt", {
      packages: packagesWith([appPackage, memoryModule()]),
      definitionKinds: [MEMORY_MODULE_KIND],
    });
    expect(violations).toHaveLength(1);
    expectCode(violations, "module-import-outside-catalog");
    expectRule(violations, 5);
  });
});
