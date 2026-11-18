/**
 * 验证九个共享包的公开入口可被 workspace 解析，且导出的包名与目录名一致。
 * 依赖 pnpm workspace 链接与各包 index 导出的 packageName 常量。
 * 禁止在此加载宿主实现、访问文件系统或启动外部进程。
 */
import { expect, it } from "vitest";
import { packageName as agentRuntimePackageName } from "@ai-npc/agent-runtime";
import { packageName as authorityPackageName } from "@ai-npc/authority";
import { packageName as clientProtocolPackageName } from "@ai-npc/client-protocol";
import { packageName as clientSdkPackageName } from "@ai-npc/client-sdk";
import { packageName as contractsPackageName } from "@ai-npc/contracts";
import { packageName as experimentPackageName } from "@ai-npc/experiment";
import { packageName as kernelPackageName } from "@ai-npc/kernel";
import { packageName as moduleSdkPackageName } from "@ai-npc/module-sdk";
import { packageName as observabilityPackageName } from "@ai-npc/observability";

/** 共享包目录名与期望包名的固定对照，顺序即断言顺序。 */
const expectedPackages = [
  ["contracts", "@ai-npc/contracts"],
  ["kernel", "@ai-npc/kernel"],
  ["module-sdk", "@ai-npc/module-sdk"],
  ["client-sdk", "@ai-npc/client-sdk"],
  ["client-protocol", "@ai-npc/client-protocol"],
  ["authority", "@ai-npc/authority"],
  ["agent-runtime", "@ai-npc/agent-runtime"],
  ["experiment", "@ai-npc/experiment"],
  ["observability", "@ai-npc/observability"],
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
    expect(expectedName).toBe(`@ai-npc/${directory}`);
  });
});
