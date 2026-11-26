/**
 * 验证九个共享包的公开入口可被 workspace 解析，且导出的包名与目录名一致。
 * 依赖 pnpm workspace 链接与各包 index 导出的 packageName 常量。
 * 禁止在此加载宿主实现、访问文件系统或启动外部进程。
 */
import { expect, it } from "vitest";
import { packageName as agentRuntimePackageName } from "@world-prism/agent-runtime";
import { packageName as authorityPackageName } from "@world-prism/authority";
import { packageName as clientProtocolPackageName } from "@world-prism/client-protocol";
import { packageName as clientSdkPackageName } from "@world-prism/client-sdk";
import { packageName as contractsPackageName } from "@world-prism/contracts";
import { packageName as experimentPackageName } from "@world-prism/experiment";
import { packageName as kernelPackageName } from "@world-prism/kernel";
import { packageName as moduleSdkPackageName } from "@world-prism/module-sdk";
import { packageName as observabilityPackageName } from "@world-prism/observability";

/** 共享包目录名与期望包名的固定对照，顺序即断言顺序。 */
const expectedPackages = [
  ["contracts", "@world-prism/contracts"],
  ["kernel", "@world-prism/kernel"],
  ["module-sdk", "@world-prism/module-sdk"],
  ["client-sdk", "@world-prism/client-sdk"],
  ["client-protocol", "@world-prism/client-protocol"],
  ["authority", "@world-prism/authority"],
  ["agent-runtime", "@world-prism/agent-runtime"],
  ["experiment", "@world-prism/experiment"],
  ["observability", "@world-prism/observability"],
] as const;

/** 各包当前导出的 packageName，顺序与 expectedPackages 一致。 */
const actualPackageNames = [
  contractsPackageName,
  kernelPackageName,
  moduleSdkPackageName,
  clientSdkPackageName,
  clientProtocolPackageName,
  authorityPackageName,
  agentRuntimePackageName,
  experimentPackageName,
  observabilityPackageName,
] as const;

it("九个共享包的导出包名与目录一致", () => {
  expect(actualPackageNames).toHaveLength(expectedPackages.length);

  expectedPackages.forEach(([directory, expectedName], index) => {
    expect(actualPackageNames[index]).toBe(expectedName);
    expect(expectedName).toBe(`@world-prism/${directory}`);
  });
});
